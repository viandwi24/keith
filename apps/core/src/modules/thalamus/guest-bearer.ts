import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { GUEST_BEARER_PREFIX, type GuestEndReason } from '@keith/contracts'

/**
 * Guest bearers and IP hashes (docs/specs/guests.md, "Guest HTTP"). A bearer is `keith_g_<32 random bytes>`, shown
 * once to the visitor; only its SHA-256 and a keyed hash of the peer address are kept, in memory, next to the
 * session. Nothing here is written anywhere.
 */

export interface IpHasher {
  /** Full keyed hash of the peer address for one process: binds a bearer to its IP and keys the rate limiter. */
  bind(ip: string): string
  /** The 12 hex characters an owner sees (`ipHash`): keyed with a secret that rotates every UTC day. */
  daily(ip: string): string
}

/** Both keys are random per process and never stored: a restart or a new day makes hashes unlinkable. */
export function createIpHasher(now: () => number = Date.now): IpHasher {
  const processKey = crypto.getRandomValues(new Uint8Array(32))
  const dayKeys = new Map<string, Buffer>()
  const hmac = (key: Uint8Array | Buffer, data: string) =>
    createHmac('sha256', key).update(data).digest()
  const dayKey = (): Buffer => {
    const day = new Date(now()).toISOString().slice(0, 10)
    let key = dayKeys.get(day)
    if (key === undefined) {
      dayKeys.clear()
      key = hmac(processKey, `day:${day}`)
      dayKeys.set(day, key)
    }
    return key
  }
  return {
    bind: (ip) => hmac(processKey, `ip:${ip}`).toString('hex'),
    daily: (ip) => hmac(dayKey(), `ip:${ip}`).toString('hex').slice(0, 12),
  }
}

/** A new bearer: the prefix and 32 random bytes in base64url (43 characters, never a legacy `keith_` token). */
export const newGuestToken = (): string =>
  `${GUEST_BEARER_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`

const TOKEN_RE = /^keith_g_[A-Za-z0-9_-]{43}$/

/** The guest token of an `Authorization: Bearer` header, or undefined (anything else is not ours). */
export function guestTokenOf(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header)
  const token = match?.[1]
  return token !== undefined && TOKEN_RE.test(token) ? token : undefined
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

interface BearerRecord {
  tokenHash: Buffer
  ipBind: string
  /** Set when the session ended: later requests with the right bearer learn why (`410`). */
  ended?: { reason: GuestEndReason; at: number }
}

export type BearerCheck =
  | { ok: true }
  | { ok: false; why: 'unknown' | 'token' | 'ip' }
  | { ok: false; why: 'ended'; reason: GuestEndReason }

export interface BearerStore {
  /** Remember a new session's bearer and the IP it is bound to. */
  add(id: string, token: string, ipBind: string): void
  /**
   * Whether `token` is the bearer of session `id` and `ipBind` is the address it was bound to. An ended session still
   * answers `ended` (with its reason) to the right bearer from the right address, for a while; everyone else sees `unknown`.
   */
  check(id: string, token: string, ipBind: string): BearerCheck
  /** The session ended: keep a tombstone (a hash and a reason, no more) for the 410 answer. */
  end(id: string, reason: GuestEndReason): void
  readonly size: number
}

/** How long a tombstone answers `410` (the visitor's client usually asks within seconds). */
export const TOMBSTONE_MS = 10 * 60_000
const MAX_TOMBSTONES = 1000

export function createBearerStore(now: () => number = Date.now): BearerStore {
  const records = new Map<string, BearerRecord>()
  const prune = (): void => {
    const at = now()
    let tombs = 0
    for (const [id, r] of records) {
      if (r.ended === undefined) continue
      if (at - r.ended.at >= TOMBSTONE_MS) records.delete(id)
      else tombs += 1
    }
    // over the cap: drop the oldest tombstones (Map keeps insertion order)
    for (const [id, r] of records) {
      if (tombs <= MAX_TOMBSTONES) break
      if (r.ended !== undefined) {
        records.delete(id)
        tombs -= 1
      }
    }
  }
  return {
    add(id, token, ipBind) {
      records.set(id, { tokenHash: sha256(token), ipBind })
    },
    check(id, token, ipBind) {
      const record = records.get(id)
      if (record === undefined) return { ok: false, why: 'unknown' }
      if (!timingSafeEqual(record.tokenHash, sha256(token))) return { ok: false, why: 'token' }
      if (record.ipBind !== ipBind) return { ok: false, why: 'ip' }
      if (record.ended !== undefined) {
        if (now() - record.ended.at >= TOMBSTONE_MS) {
          records.delete(id)
          return { ok: false, why: 'unknown' }
        }
        return { ok: false, why: 'ended', reason: record.ended.reason }
      }
      return { ok: true }
    },
    end(id, reason) {
      const record = records.get(id)
      if (record === undefined) return
      record.ended = { reason, at: now() }
      prune()
    },
    get size() {
      return records.size
    },
  }
}
