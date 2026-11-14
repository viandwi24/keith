import { ANY_IP, type SecretsRepo } from '@keith/db'

/** Failures before the delay starts: the 5th consecutive failure is the first one that waits. */
export const FREE_FAILURES = 4
export const DELAY_BASE_MS = 1000
export const DELAY_CAP_MS = 300_000
/** A member is locked after this many failures (any address) until `people unlock`. */
export const MEMBER_LOCK_AT = 20
/** Counters of unknown names and idle addresses older than this are dropped. */
const KEEP_MS = 24 * 3_600_000

/** Wait after `failures` consecutive failures from one address: 0 below five, then 1 s doubling to 5 min. */
export function delayMs(failures: number): number {
  if (failures <= FREE_FAILURES) return 0
  return Math.min(DELAY_CAP_MS, DELAY_BASE_MS * 2 ** (failures - FREE_FAILURES - 1))
}

/** The counter key of an attempt on a username that does not exist (no row of `people` to point at). */
export async function unknownSubject(username: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(username))
  return `u:${Buffer.from(digest).toString('hex').slice(0, 32)}`
}

export interface Throttle {
  /** Seconds to wait before this (subject, address) may try again, or undefined when it may try now. */
  blocked(subject: string, ip: string): number | undefined
  /**
   * Seconds every address must wait because of the failures of the subject from all addresses
   * (the PIN on the LAN: a delay, never a lock), `delayMs` capped at `capMs`; undefined when none.
   */
  blockedPerson(subject: string, capMs: number): number | undefined
  /** Count a failure. `member` is set for a known member: the 20th failure locks them. `total` is the person-wide count. */
  failed(
    subject: string,
    ip: string,
    who: { known: boolean; member: boolean },
  ): { locked: boolean; total: number }
  /** A success clears every counter of the subject. */
  succeeded(subject: string): void
  locked(subject: string): boolean
}

/**
 * Throttling per (account, address), kept in `auth_attempts` so it survives a restart. Answers are
 * the same for unknown accounts (keyed by a hash of the name). The owner is never locked out: only
 * delayed; members lock after {@link MEMBER_LOCK_AT} failures from anywhere.
 */
export function createThrottle(repo: SecretsRepo, now: () => number = Date.now): Throttle {
  let lastPrune = 0
  return {
    blocked(subject, ip) {
      const row = repo.attempt(subject, ip)
      if (row === undefined) return undefined
      const wait = delayMs(row.failures)
      const left = row.lastFailureAt + wait - now()
      return wait > 0 && left > 0 ? Math.ceil(left / 1000) : undefined
    },
    blockedPerson(subject, capMs) {
      const row = repo.attempt(subject, ANY_IP)
      if (row === undefined) return undefined
      const wait = Math.min(capMs, delayMs(row.failures))
      const left = row.lastFailureAt + wait - now()
      return wait > 0 && left > 0 ? Math.ceil(left / 1000) : undefined
    },
    failed(subject, ip, who) {
      const at = now()
      repo.fail(subject, ip, at)
      let locked = false
      // the person-wide row is written for an unknown subject too: a decoy does the same writes
      const total = repo.fail(subject, ANY_IP, at)
      if (who.known && who.member && total.failures >= MEMBER_LOCK_AT) {
        repo.lock(subject, at)
        locked = true
      }
      if (at - lastPrune > 3_600_000) {
        lastPrune = at
        repo.prune(at - KEEP_MS)
      }
      return { locked, total: total.failures }
    },
    succeeded(subject) {
      repo.reset(subject)
    },
    locked: (subject) => repo.locked(subject),
  }
}
