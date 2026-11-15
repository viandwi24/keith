// The delivery service (docs/specs/delivery.md, ADR-0024 §5, ADR-0027 §16): exactly once by run id, retried while a route
// is unavailable, and a terminal failure is reported to the creator and recorded (no text).
import {
  DELIVERY_FAILED,
  type DeliveryFailedRecord,
  DeliveryFailedRecordSchema,
  type DeliveryFailReason,
  type DeliveryHoldReason,
  type DeliveryNeeds,
  DeliveryNeedsSchema,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryRequestInput,
  DeliveryRequestSchema,
  type PresenceState,
} from '@keith/contracts'
import type { DeliveriesRepo, DeliveryRecord } from '@keith/db'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import type { Audit } from '../audit/index.ts'
import { createDigest, HELD_PREFIX, holdReasonOf } from './digest.ts'

/** What a route answers for one attempt. `unavailable` is retried; `budget` and `recipient-gone` end the delivery. */
export type RouteResult =
  | { ok: true }
  | { ok: false; reason: 'budget' | 'recipient-gone' | 'unavailable' }

/** One way to reach a person (the front session today; a client, a push or a mail later). */
export interface DeliveryRoute {
  id: string
  /**
   * A companion route (a Web Push, docs/specs/push.md) runs in its place in the plan but never decides: its answer is ignored,
   * it neither delivers the message nor refuses it, and the next route is always tried (the front session is never replaced).
   */
  companion?: boolean
  send(request: DeliveryRequest, ctx: { attempt: number }): Promise<RouteResult>
}

/** The answer "keep it for the return digest" (ADR-0034 §6): `until` is the end of a stated busy or out status (epoch ms). */
export interface RouteHold {
  hold: { reason: DeliveryHoldReason; until?: number }
}

/** The routes of a delivery, best first, or a hold. */
export type RoutePlan = DeliveryRoute[] | RouteHold

/** Chooses the routes of a delivery, best first, or holds it. The seam of P27 (presence) and P28 (protocol `notify`). */
export interface RoutePlanner {
  plan(person: string, needs: DeliveryNeeds): Promise<RoutePlan>
}

/** Writes an activity record on a session (the core's `emit`, bound to its store). Never throws. */
export interface DeliveryActivity {
  record(sessionId: string, type: string, payload: Record<string, unknown>): void
}

/** The retry waits after the first, second and third attempt: 1, 5 and 30 minutes. */
export const DEFAULT_RETRY_MS: readonly number[] = [60_000, 300_000, 1_800_000]
/** Rows the tick takes per run. */
export const TICK_LIMIT = 20
/** The period of the timer in the core (`CoreTiming.deliveryTickMs`). */
export const DEFAULT_TICK_MS = 30_000

export interface DeliveryOptions {
  deliveries: DeliveriesRepo
  planner: RoutePlanner
  audit: Pick<Audit, 'record'>
  activity?: DeliveryActivity
  /** Whether the person counts for routing now (`active`, ADR-0027 §15). Default: everybody. */
  isActive?: (personId: string) => boolean | Promise<boolean>
  now: () => number
  retryMs?: readonly number[]
  tickMs?: number
  warn?: (message: string) => void
  /** The current front generation of each person (ADR-0030 §2): the session the person's events go to. */
  generations: FrontGenerationOf
  /** The person's front session: the digest turn and the 7-day notes go there. Without it, held rows are never released. */
  front?: DeliveryRoute
  /** One notice to the person's active client when a digest is released (best effort). */
  notify?: (personId: string, text: string) => Promise<void>
  /** The person's presence now: the tick releases held rows of a person who is active or idle again. */
  presenceOf?: (personId: string) => { state: PresenceState } | undefined
}

export interface Delivery {
  /** Releases every held row of the person as one digest (the person came back); a repeat finds nothing held. */
  release(personId: string): Promise<void>
  /** Sends a request once for its run id; a repeat returns the stored outcome and sends nothing. */
  deliver(request: DeliveryRequestInput): Promise<DeliveryOutcome>
  /** Attempts the pending rows that are due (at most `TICK_LIMIT`). */
  tick(): Promise<void>
  /** One tick now, then one every `tickMs`. */
  start(): void
  stop(): void
}

type Attempt =
  | { ok: true; route: string }
  | { ok: false; reason: DeliveryFailReason }
  | { held: RouteHold['hold'] }

/** The request a stored row was made from (retries and the failure notice read the row, not the caller). */
export function requestOf(row: DeliveryRecord): DeliveryRequest {
  return DeliveryRequestSchema.parse({
    id: row.id,
    source: row.source,
    to: row.recipientId,
    ...(row.billTo === null ? {} : { billTo: row.billTo }),
    name: row.name,
    text: row.text,
    ...(row.data === null ? {} : { data: JSON.parse(row.data) as unknown }),
    needs: JSON.parse(row.needs) as unknown,
    ...(row.reportTo === null || row.reportText === null || row.reportKey === null
      ? {}
      : { onFailure: { to: row.reportTo, text: row.reportText, key: row.reportKey } }),
  })
}

/** The outcome a stored row answers with (a repeat of the same run id). */
export function outcomeOf(row: DeliveryRecord): DeliveryOutcome {
  if (row.status === 'delivered')
    return { status: 'delivered', route: row.route ?? '', attempts: row.attempts }
  if (row.status === 'failed')
    return {
      status: 'failed',
      reason: (row.reason ?? 'unavailable') as DeliveryFailReason,
      attempts: row.attempts,
    }
  if (row.status === 'held') return { status: 'held', reason: holdReasonOf(row.reason) }
  return {
    status: 'queued',
    reason: 'unavailable',
    nextAttemptAt: row.nextAttemptAt ?? row.createdAt,
  }
}

export function createDelivery(options: DeliveryOptions): Delivery {
  const { deliveries, planner, audit, activity, now, generations } = options
  const isActive = options.isActive ?? (() => true)
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const warn = options.warn ?? (() => {})
  // runs in progress in this process: the tick skips them, so one run is not attempted twice at once
  const inFlight = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  /** Sends through one route; a throw is an unavailable route. */
  async function sendVia(
    candidate: DeliveryRoute,
    request: DeliveryRequest,
    attempt: number,
  ): Promise<RouteResult> {
    try {
      return await candidate.send(request, { attempt })
    } catch (error) {
      warn(`delivery: route ${candidate.id} failed: ${message(error)}`)
      return { ok: false, reason: 'unavailable' }
    }
  }

  /**
   * One attempt over the recipient's routes. `best`: in order, until one takes the message or a terminal refusal
   * (`budget`, `recipient-gone`) ends it. `all`: every route is tried; delivered when any took it.
   */
  async function route(request: DeliveryRequest, attempt: number): Promise<Attempt> {
    if (!(await isActive(request.to))) return { ok: false, reason: 'recipient-gone' }
    let routes: DeliveryRoute[]
    try {
      const plan = await planner.plan(request.to, request.needs)
      if (!Array.isArray(plan)) return { held: plan.hold }
      routes = plan
    } catch (error) {
      warn(`delivery: planner failed: ${message(error)}`)
      return { ok: false, reason: 'unavailable' }
    }
    if (routes.length === 0) return { ok: false, reason: 'no-route' }

    const all = request.needs.fanout === 'all'
    const delivered: string[] = []
    const refusals: RouteResult[] = []
    for (const candidate of routes) {
      const result = await sendVia(candidate, request, attempt)
      if (candidate.companion === true) continue
      if (result.ok) {
        if (!all) return { ok: true, route: candidate.id }
        delivered.push(candidate.id)
        continue
      }
      if (!all && result.reason !== 'unavailable') return { ok: false, reason: result.reason }
      refusals.push(result)
    }
    const first = delivered[0]
    if (first !== undefined) return { ok: true, route: first }
    // every route refused: a route that is only unavailable means retry; otherwise the first terminal refusal
    const terminal = refusals.find((r) => !r.ok && r.reason !== 'unavailable')
    if (
      terminal !== undefined &&
      !terminal.ok &&
      !refusals.some((r) => !r.ok && r.reason === 'unavailable')
    )
      return { ok: false, reason: terminal.reason }
    return { ok: false, reason: 'unavailable' }
  }

  /**
   * The failure notice: a note (stored, no turn, no budget) with the run id `report:<key>`. The key makes it once: a
   * second failure with the same key finds the row and writes nothing.
   */
  async function report(
    notice: NonNullable<DeliveryRequest['onFailure']>,
    failedId: string,
  ): Promise<void> {
    const created = deliveries.create({
      id: `report:${notice.key}`,
      source: 'delivery',
      recipientId: notice.to,
      name: 'delivery-failed',
      needs: JSON.stringify(DeliveryNeedsSchema.parse({ mode: 'note' })),
      text: notice.text,
    })
    if (!created.created) return
    audit.record({
      kind: 'delivery.reported',
      actor: 'system',
      via: 'local',
      detail: { id: failedId, to: notice.to },
    })
    await attemptGuarded(created.record)
  }

  /**
   * A delivery that will not happen: the audit row, the activity record on the recipient's front session (no text), and
   * the failure notice to the creator when one was given (ADR-0027 §16).
   */
  async function finalFailure(
    row: DeliveryRecord,
    request: DeliveryRequest,
    reason: DeliveryFailReason,
    attempts: number,
  ): Promise<void> {
    audit.record({
      kind: 'delivery.failed',
      actor: 'system',
      via: 'local',
      detail: { id: row.id, source: row.source, to: row.recipientId, reason, attempts },
    })
    if (activity !== undefined) {
      const record: DeliveryFailedRecord = DeliveryFailedRecordSchema.parse({
        personId: row.recipientId,
        deliveryId: row.id,
        source: row.source,
        reason,
      })
      activity.record(
        frontSessionId(row.recipientId, generations.current(row.recipientId)),
        DELIVERY_FAILED,
        record,
      )
    }
    if (request.onFailure !== undefined) await report(request.onFailure, row.id)
  }

  /** One attempt of a stored row: settles it as delivered, pending (a retry) or failed. */
  async function attempt(row: DeliveryRecord): Promise<DeliveryOutcome> {
    const request = requestOf(row)
    const attemptNo = row.attempts + 1
    const outcome = await route(request, attemptNo)

    if ('held' in outcome) {
      // kept for the return digest: no retry timer, the text stays (docs/specs/delivery.md, "Hold and digest")
      const { reason, until } = outcome.held
      deliveries.settle(row.id, {
        status: 'held',
        reason: `${HELD_PREFIX}${reason}`,
        attempts: row.attempts,
        nextAttemptAt: null,
      })
      audit.record({
        kind: 'delivery.held',
        actor: 'system',
        via: 'local',
        detail: { id: row.id, source: row.source, to: row.recipientId, reason },
      })
      return { status: 'held', reason, ...(until === undefined ? {} : { until }) }
    }
    if (outcome.ok) {
      deliveries.settle(row.id, { status: 'delivered', attempts: attemptNo, route: outcome.route })
      audit.record({
        kind: 'delivery.sent',
        actor: 'system',
        via: 'local',
        detail: {
          id: row.id,
          source: row.source,
          to: row.recipientId,
          route: outcome.route,
          attempts: attemptNo,
        },
      })
      return { status: 'delivered', route: outcome.route, attempts: attemptNo }
    }

    // an unavailable route is retried after the wait of this attempt; past the last wait the delivery fails
    const wait = outcome.reason === 'unavailable' ? retryMs[attemptNo - 1] : undefined
    if (wait !== undefined) {
      const nextAttemptAt = now() + wait
      deliveries.settle(row.id, {
        status: 'pending',
        reason: 'unavailable',
        attempts: attemptNo,
        nextAttemptAt,
      })
      audit.record({
        kind: 'delivery.retry',
        actor: 'system',
        via: 'local',
        detail: { id: row.id, attempt: attemptNo + 1, nextAttemptAt, to: row.recipientId },
      })
      return { status: 'queued', reason: 'unavailable', nextAttemptAt }
    }

    deliveries.settle(row.id, { status: 'failed', reason: outcome.reason, attempts: attemptNo })
    await finalFailure(row, request, outcome.reason, attemptNo)
    return { status: 'failed', reason: outcome.reason, attempts: attemptNo }
  }

  /** Runs one attempt of a row unless this process already runs it; a throw is logged, not raised. */
  async function attemptGuarded(row: DeliveryRecord): Promise<DeliveryOutcome | undefined> {
    if (inFlight.has(row.id)) return undefined
    inFlight.add(row.id)
    try {
      return await attempt(row)
    } catch (error) {
      warn(`delivery ${row.id} failed: ${message(error)}`)
      return undefined
    } finally {
      inFlight.delete(row.id)
    }
  }

  const deliver = async (input: DeliveryRequestInput): Promise<DeliveryOutcome> => {
    const request = DeliveryRequestSchema.parse(input)
    const { created, record } = deliveries.create({
      id: request.id,
      source: request.source,
      recipientId: request.to,
      billTo: request.billTo ?? null,
      name: request.name,
      needs: JSON.stringify(request.needs),
      data: request.data === undefined ? null : JSON.stringify(request.data),
      text: request.text,
      reportTo: request.onFailure?.to ?? null,
      reportText: request.onFailure?.text ?? null,
      reportKey: request.onFailure?.key ?? null,
      nextAttemptAt: now(),
    })
    // a stored run (any state) answers with its outcome and sends nothing
    if (!created) return outcomeOf(record)
    const done = await attemptGuarded(record)
    return done ?? outcomeOf(deliveries.get(record.id) ?? record)
  }

  const digest =
    options.front === undefined
      ? undefined
      : createDigest({
          deliveries,
          front: options.front,
          audit,
          now,
          warn,
          ...(options.notify === undefined ? {} : { notify: options.notify }),
          ...(options.presenceOf === undefined ? {} : { presenceOf: options.presenceOf }),
        })

  const tick = async (): Promise<void> => {
    for (const row of deliveries.due(now(), TICK_LIMIT)) await attemptGuarded(row)
    await digest?.sweep()
  }

  const tickLogged = (): void => {
    tick().catch((error: unknown) => warn(`delivery tick failed: ${message(error)}`))
  }

  return {
    deliver,
    release: async (personId) => digest?.release(personId),
    tick,
    start() {
      tickLogged()
      timer = setInterval(tickLogged, tickMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
