import type { ReviewStatus, ReviewView } from '@keith/contracts'
import type { ReviewRecord, ReviewsRepo } from '@keith/db'
import { type ActorDirectory, GuardError, type KeithPlugin, type ReviewPort } from '@keith/host'
import { uuidv7 } from 'eharness'
import type { Audit } from '../audit/index.ts'
import type { PeopleService } from '../people/index.ts'
import type { PluginHost } from './host.ts'

export const DEFAULT_REVIEW_EXPIRY_DAYS = 7
export const DEFAULT_REVIEW_MAX_PENDING = 20
export const REVIEW_EXPIRY_KEY = 'reviews.expiryDays'
export const REVIEW_MAX_PENDING_KEY = 'reviews.maxPending'
/** A decided review (approved, denied or expired) and its payload are deleted this long after the decision (ADR-0027 §19). */
export const REVIEW_DECIDED_KEEP_DAYS = 30
const DAY_MS = 86_400_000

export class ReviewError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT'
  constructor(code: 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
  }
}

/** Who decides, for the audit row. */
export interface ReviewCaller {
  by: string
  via: 'local' | 'tcp'
}

export interface ReviewService {
  /** What the guard files a review with (`GuardDeps.reviews`). */
  readonly port: ReviewPort
  list(filter?: {
    status?: ReviewStatus | undefined
    limit?: number | undefined
  }): Promise<ReviewView[]>
  /** Replays the operation as the requester, revalidated now. The review is decided first; the run's outcome is recorded on it. */
  approve(id: string, by: ReviewCaller): Promise<ReviewView>
  deny(id: string, reason: string | undefined, by: ReviewCaller): Promise<ReviewView>
  /** Pending reviews past their expiry become `expired` (audited, the requester told); returns how many. */
  sweep(): number
  /** Deletes the reviews decided more than `REVIEW_DECIDED_KEEP_DAYS` ago, payload included; pending ones stay. Returns how many. */
  purgeDecided(): number
}

export interface ReviewDeps {
  repo: ReviewsRepo
  /** Read lazily: the host is built with this service's `port`. */
  host: () => PluginHost
  directory: ActorDirectory
  people: Pick<PeopleService, 'get' | 'owner'>
  audit: Audit
  settings: { get<T>(key: string): T | undefined }
  /** Typed notices on the feed: `to` gets a short event of the `reviews` channel (no payload ever). */
  notify: (to: string, event: string, data: Record<string, unknown>) => void
  warn?: (message: string) => void
  /** Clock of the purge (default `Date.now`; tests pass theirs). */
  now?: () => number
}

/**
 * The owner review queue (docs/specs/plugins.md, "Owner review queue"). The guard files a review through `port`
 * (the validated input, never run); the owner lists, approves or denies it. Approval replays the operation through
 * the same guard **as the requester**, whose status and rights are read again then (a suspended or gone requester is
 * refused and the review stays pending, so the owner can deny it), and never elevated. The audit rows hold ids and
 * names of plugin and operation, never the payload.
 */
export function createReviewService(deps: ReviewDeps): ReviewService {
  const num = (key: string, fallback: number): number => {
    const v = deps.settings.get<number>(key)
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback
  }
  const audit = (
    kind: string,
    caller: ReviewCaller | undefined,
    r: ReviewRecord,
    extra = {},
  ): void =>
    deps.audit.record({
      kind: `plugin.review.${kind}`,
      actor: caller?.by ?? 'system',
      via: caller?.via ?? 'local',
      detail: {
        review: r.id,
        plugin: r.plugin,
        operation: r.operation,
        requester: r.requester,
        ...extra,
      },
    })
  const tell = (to: string, event: string, r: ReviewRecord, extra = {}): void =>
    deps.notify(to, event, { review: r.id, plugin: r.plugin, operation: r.operation, ...extra })

  const view = async (r: ReviewRecord): Promise<ReviewView> => {
    const person = await deps.people.get(r.requester).catch(() => undefined)
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = null
    }
    return {
      id: r.id,
      requester: {
        id: r.requester,
        username: person?.username ?? null,
        name: person?.name ?? r.requester,
      },
      plugin: r.plugin,
      operation: r.operation,
      payload,
      status: r.status,
      reason: r.reason,
      outcome: r.outcome,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      decidedAt: r.decidedAt,
      decidedBy: r.decidedBy,
    }
  }

  const sweep = (): number => {
    const expired = deps.repo.expire()
    for (const r of expired) {
      audit('expired', undefined, r)
      tell(r.requester, 'review_expired', r)
    }
    return expired.length
  }
  const pendingOf = (id: string): ReviewRecord => {
    sweep()
    const r = deps.repo.get(id)
    if (r === undefined) throw new ReviewError('NOT_FOUND', 'no such review')
    if (r.status !== 'pending')
      throw new ReviewError('CONFLICT', `the review is already ${r.status}`)
    return r
  }
  const operationOf = (r: ReviewRecord) =>
    deps
      .host()
      .loaded()
      .find((p: KeithPlugin) => p.id === r.plugin)
      ?.operation(r.operation)

  return {
    port: {
      request(review) {
        const id = uuidv7()
        const made = deps.repo.create(
          {
            id,
            requester: review.requester,
            plugin: review.plugin,
            operation: review.operation,
            payload: JSON.stringify(review.payload),
            reason: review.reason ?? null,
            ttlMs: num(REVIEW_EXPIRY_KEY, DEFAULT_REVIEW_EXPIRY_DAYS) * DAY_MS,
          },
          num(REVIEW_MAX_PENDING_KEY, DEFAULT_REVIEW_MAX_PENDING),
        )
        if (!made.ok) return made
        const row = deps.repo.get(id)
        deps.people
          .owner()
          .then((owner) => {
            if (owner !== undefined && row !== undefined)
              tell(owner.id, 'review_requested', row, { requester: review.requester })
          })
          .catch((error: unknown) =>
            deps.warn?.(
              `reviews: could not tell the owner: ${error instanceof Error ? error.message : error}`,
            ),
          )
        return { ok: true, id }
      },
    },

    async list(filter = {}) {
      sweep()
      const rows = deps.repo.list({
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      })
      return Promise.all(rows.map(view))
    },

    async approve(id, caller) {
      const r = pendingOf(id)
      const op = operationOf(r)
      if (op === undefined)
        throw new ReviewError(
          'CONFLICT',
          'the plugin is not loaded: deny the review or enable the plugin',
        )
      const facts = await deps.directory.resolve(r.requester)
      if (facts === undefined || facts.status !== 'active')
        throw new ReviewError('CONFLICT', 'the requester is suspended or gone: deny the review')
      if (!deps.repo.decide(id, 'approved', caller.by))
        throw new ReviewError('CONFLICT', 'the review was decided meanwhile')
      let outcome = 'ok'
      try {
        await deps.host().guard.run(op, JSON.parse(r.payload), {
          principal: { id: r.requester },
          session: { id: null, kind: 'api', method: null, elevated: false },
          approvedReview: id,
        })
      } catch (error) {
        outcome = `error:${error instanceof GuardError ? error.code : 'INTERNAL'}`
      }
      deps.repo.setOutcome(id, outcome)
      const done = deps.repo.get(id) as ReviewRecord
      audit('approved', caller, done, { outcome })
      tell(r.requester, 'review_decided', done, { status: 'approved', outcome })
      return view(done)
    },

    async deny(id, reason, caller) {
      const r = pendingOf(id)
      if (!deps.repo.decide(id, 'denied', caller.by, reason))
        throw new ReviewError('CONFLICT', 'the review was decided meanwhile')
      const done = deps.repo.get(id) as ReviewRecord
      audit('denied', caller, done)
      tell(r.requester, 'review_decided', done, { status: 'denied' })
      return view(done)
    },

    sweep,
    purgeDecided() {
      return deps.repo.purge((deps.now ?? Date.now)() - REVIEW_DECIDED_KEEP_DAYS * DAY_MS)
    },
  }
}
