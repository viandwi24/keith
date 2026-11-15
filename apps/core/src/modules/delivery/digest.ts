// The return digest (docs/specs/delivery.md "Hold and digest", ADR-0034 §7): deliveries held while the person was busy,
// away, out or offline are released as ONE wake turn of the front agent when the person comes back, plus one notice to the
// active client. A row held for more than 7 days is released into the front session as a plain note instead.
import { createHash } from 'node:crypto'
import {
  type DeliveryHoldReason,
  DeliveryHoldReasonSchema,
  DeliveryNeedsSchema,
  type DeliveryRequest,
  type PresenceState,
} from '@keith/contracts'
import type { DeliveriesRepo, DeliveryRecord } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import type { DeliveryRoute } from './delivery.ts'

/** Rows held longer than this are released as plain notes: nothing waits forever. */
export const HELD_MAX_MS = 7 * 86_400_000
/** The most items in one digest turn (the request text is limited to 4000 characters); the rest is the next digest. */
export const DIGEST_ITEMS_MAX = 20
/** The most characters of one item's text in the digest turn. */
export const DIGEST_ITEM_CLIP = 140
/** The route id of a row released by a digest. */
export const DIGEST_ROUTE = 'digest'

/** The `reason` of a held row is `held:<why>`. */
export const HELD_PREFIX = 'held:'

/** The hold reason a held row's `reason` column names. */
export const holdReasonOf = (reason: string | null): DeliveryHoldReason => {
  const parsed = DeliveryHoldReasonSchema.safeParse((reason ?? '').slice(HELD_PREFIX.length))
  return parsed.success ? parsed.data : 'away'
}

export interface DigestOptions {
  deliveries: DeliveriesRepo
  /** The person's front session: the digest turn and the 7-day notes go there. */
  front: DeliveryRoute
  audit: Pick<Audit, 'record'>
  now: () => number
  warn: (message: string) => void
  /** One notice to the person's active client (when one announces `notify`); best effort, never throws. */
  notify?: (personId: string, text: string) => Promise<void>
  /** The person's presence now; the sweep releases a person who is active or idle again. */
  presenceOf?: (personId: string) => { state: PresenceState } | undefined
  heldMaxMs?: number
}

export interface Digest {
  /** Releases every held row of the person as one digest turn (idempotent: nothing held, nothing sent). */
  release(personId: string): Promise<void>
  /** Releases people who are back (status ended, a missed presence record) and rows held past 7 days. */
  sweep(): Promise<void>
}

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= DIGEST_ITEM_CLIP ? one : `${one.slice(0, DIGEST_ITEM_CLIP - 1)}…`
}

/** The id of a digest: a hash of its rows' ids, so the same rows always make the same inject key. */
export function digestId(rows: readonly DeliveryRecord[]): string {
  const hash = createHash('sha256')
    .update(rows.map((r) => r.id).join('\n'))
    .digest('hex')
  return `digest:${hash.slice(0, 32)}`
}

/** The wake text of a digest: the instruction (ADR-0034 §1 briefing rule), then the held items (name and text). */
export function digestText(rows: readonly DeliveryRecord[]): string {
  const items = rows.map((r, i) => `${i + 1}. ${r.name}: ${clip(r.text)}`)
  return [
    `The person is back. ${rows.length} message${rows.length === 1 ? ' was' : 's were'} held for them while they were busy or away.`,
    'Brief them now in their language and address: the count first, then each item in one line, then one closing line.',
    'Do not invent items; these are all of them.',
    '',
    ...items,
  ].join('\n')
}

export function createDigest(options: DigestOptions): Digest {
  const { deliveries, front, audit, now, warn } = options
  const heldMaxMs = options.heldMaxMs ?? HELD_MAX_MS
  const busy = new Set<string>()
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  async function releaseBatch(personId: string): Promise<boolean> {
    const rows = deliveries.heldFor(personId, DIGEST_ITEMS_MAX)
    if (rows.length === 0) return false
    const id = digestId(rows)
    const request: DeliveryRequest = {
      id,
      source: 'delivery',
      to: personId,
      name: 'digest',
      text: digestText(rows),
      needs: DeliveryNeedsSchema.parse({ mode: 'wake' }),
    }
    const result = await front.send(request, { attempt: 1 }).catch((error: unknown) => {
      warn(`delivery: digest route failed: ${message(error)}`)
      return { ok: false as const, reason: 'unavailable' as const }
    })
    if (!result.ok) {
      // the rows stay held: the sweep tries again, and the 7-day rule is the end
      warn(`delivery: digest for ${personId} not sent (${result.reason}); rows stay held`)
      return false
    }
    for (const row of rows) {
      deliveries.settle(row.id, {
        status: 'delivered',
        attempts: row.attempts,
        route: DIGEST_ROUTE,
      })
      audit.record({
        kind: 'delivery.sent',
        actor: 'system',
        via: 'local',
        detail: {
          id: row.id,
          source: row.source,
          to: personId,
          route: DIGEST_ROUTE,
          attempts: row.attempts,
        },
      })
    }
    const notify = options.notify
    if (notify !== undefined) {
      const count = rows.length
      await notify(personId, `Keith · ${count} held message${count === 1 ? '' : 's'}`).catch(
        (error: unknown) => warn(`delivery: digest notice failed: ${message(error)}`),
      )
    }
    return rows.length === DIGEST_ITEMS_MAX
  }

  async function release(personId: string): Promise<void> {
    if (busy.has(personId)) return
    busy.add(personId)
    try {
      // more than one batch only when over DIGEST_ITEMS_MAX rows were held
      while (await releaseBatch(personId));
    } catch (error) {
      warn(`delivery: digest for ${personId} failed: ${message(error)}`)
    } finally {
      busy.delete(personId)
    }
  }

  /** A row held for more than 7 days: stored in the front session as a plain note (no turn, no budget). */
  async function releaseStale(row: DeliveryRecord): Promise<void> {
    const request: DeliveryRequest = {
      id: row.id,
      source: row.source,
      to: row.recipientId,
      name: row.name,
      text: row.text,
      needs: DeliveryNeedsSchema.parse({ mode: 'note' }),
    }
    const result = await front.send(request, { attempt: 1 }).catch(() => ({ ok: false as const }))
    if (!result.ok) return
    deliveries.settle(row.id, { status: 'delivered', attempts: row.attempts, route: front.id })
    audit.record({
      kind: 'delivery.sent',
      actor: 'system',
      via: 'local',
      detail: {
        id: row.id,
        source: row.source,
        to: row.recipientId,
        route: front.id,
        attempts: row.attempts,
      },
    })
  }

  return {
    release,
    async sweep() {
      for (const row of deliveries.heldBefore(now() - heldMaxMs, 50)) {
        await releaseStale(row).catch((error: unknown) =>
          warn(`delivery: held row ${row.id} not released: ${message(error)}`),
        )
      }
      const presenceOf = options.presenceOf
      if (presenceOf === undefined) return
      for (const personId of deliveries.heldRecipients()) {
        const state = presenceOf(personId)?.state
        if (state === 'active' || state === 'idle') await release(personId)
      }
    },
  }
}
