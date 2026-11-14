import {
  GUEST_CAP_EVENT,
  type GuestCapEvent,
  type GuestDeniedAudit,
  GuestDeniedAuditSchema,
  type GuestSessionAudit,
  GuestSessionAuditSchema,
} from '@keith/contracts'
import type { ActivityStore } from 'eharness/activity'
import type { Audit } from '../audit/index.ts'
import { emit } from '../brain-events/index.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Refusing addresses tracked at once; past this every pending window is written and the table starts over. */
const MAX_PENDING = 5_000

export interface GuestAudit {
  /** The registry's `onEnd`: writes the one `guest.session.end` row (counts only; strict) and may tell the owner of a cap. */
  onEnd(record: GuestSessionAudit): void
  /** One refusal from an address hash: counted into that address's current minute, written as one row per minute. */
  denied(event: { ipHash: string; reason: string }): void
  /** Write every refusal window that is over (all of them when `all`). The timer calls it; `close` writes the rest. */
  flush(all?: boolean): void
  close(): void
}

export interface GuestAuditOptions {
  audit: Audit
  /** The owner's feed: cap notices go here as events with no session (only the owner receives those). */
  store?: ActivityStore
  now?: () => number
  warn?: (message: string) => void
  /** How often finished minutes are written (ms; default 15 s, 0 = only on `flush`). */
  flushEveryMs?: number
}

interface Pending {
  windowStart: number
  count: number
  reasons: Record<string, number>
}

/**
 * Recording for guest mode (docs/specs/guests.md): an aggregate audit row per ended session, an aggregate row per
 * address hash per minute for refusals, and at most one cap notice an hour on the owner's feed. Nothing here ever
 * sees text, a raw address or a user agent: the inputs are already counts and hashes, and each row is parsed with a
 * strict schema before it is written, so a stray field fails the write instead of reaching the log.
 */
export function createGuestAudit(options: GuestAuditOptions): GuestAudit {
  const now = options.now ?? Date.now
  const pending = new Map<string, Pending>()
  let lastNotice = Number.NEGATIVE_INFINITY
  let capsSince = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const write = (kind: string, actor: string, detail: Record<string, unknown>): void => {
    try {
      options.audit.record({ kind, actor, via: 'tcp', detail })
    } catch {
      options.warn?.(`guests: could not record ${kind}`)
    }
  }
  const writePending = (ipHash: string, p: Pending): void => {
    const parsed = GuestDeniedAuditSchema.safeParse({ ipHash, ...p } satisfies GuestDeniedAudit)
    if (parsed.success) write('guest.session.denied', 'guest', parsed.data)
    else options.warn?.('guests: a refusal record did not match its schema')
  }
  const notifyCap = (cap: GuestCapEvent['cap']): void => {
    capsSince += 1
    const at = now()
    if (at - lastNotice < HOUR_MS || options.store === undefined) return
    lastNotice = at
    const event: GuestCapEvent = { cap, count: capsSince, at }
    capsSince = 0
    emit(options.store, GUEST_CAP_EVENT, null, null, event, options.warn)
  }
  const flush = (all = false): void => {
    const at = now()
    for (const [ipHash, p] of pending) {
      if (!all && at - p.windowStart < MINUTE_MS) continue
      pending.delete(ipHash)
      writePending(ipHash, p)
    }
  }

  const every = options.flushEveryMs ?? 15_000
  if (every > 0) {
    timer = setInterval(() => flush(), every)
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    onEnd(record) {
      const parsed = GuestSessionAuditSchema.safeParse(record)
      if (!parsed.success) {
        options.warn?.('guests: a session record did not match its schema')
        return
      }
      write('guest.session.end', `guest:${parsed.data.guestId}`, parsed.data)
      if (parsed.data.reason === 'cost-cap') notifyCap('cost-cap')
    },
    denied({ ipHash, reason }) {
      const at = now()
      const current = pending.get(ipHash)
      if (current !== undefined && at - current.windowStart >= MINUTE_MS) {
        pending.delete(ipHash)
        writePending(ipHash, current)
      }
      if (pending.size >= MAX_PENDING && !pending.has(ipHash)) flush(true)
      const p = pending.get(ipHash) ?? { windowStart: at - (at % MINUTE_MS), count: 0, reasons: {} }
      p.count += 1
      p.reasons[reason] = (p.reasons[reason] ?? 0) + 1
      pending.set(ipHash, p)
      if (reason === 'daily-cap' || reason === 'monthly-cap') notifyCap(reason)
    },
    flush,
    close() {
      if (timer !== undefined) clearInterval(timer)
      flush(true)
    },
  }
}
