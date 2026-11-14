import {
  APPROVAL_PING_DEFAULT_HOURS,
  APPROVAL_TTL_DEFAULT_HOURS,
  APPROVAL_TTL_MAX_HOURS,
} from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'

/** Setting key: how many hours a pending approval waits for an answer (1 to 168, default 24). */
export const APPROVAL_TTL_KEY = 'approvals.ttlHours'
/** Setting key: the hours before expiry of the owner's ping (1 up to below the lifetime, default 2; ADR-0027 §10). */
export const APPROVAL_PING_KEY = 'approvals.pingBeforeHours'
const HOUR_MS = 3_600_000

/** One stored change: the key, the value before and the value now (the audit detail). */
export type ApprovalChange = {
  key: string
  from: number
  to: number
}

export interface ApprovalSettings {
  /** Hours in force: the stored setting, else 24. A corrupt value reads as the default, never as "forever". */
  ttlHours(): number
  /** The same lifetime in milliseconds. */
  ttlMs(): number
  /** Stores the lifetime. Throws `RangeError` outside 1..168, for a non-integer, or at or below the ping in force. */
  setTtlHours(hours: number): void
  /** Hours before expiry of the ping: the stored setting, else 2. A corrupt value reads as the default. */
  pingBeforeHours(): number
  /** Stores the ping. Throws `RangeError` below 1, for a non-integer, or at or above the lifetime in force. */
  setPingBeforeHours(hours: number): void
  /**
   * Stores one or both values as one step: the pair is checked first (the ping must stay below the lifetime that results),
   * and nothing is written on a refusal. Returns one change per value given.
   */
  set(change: {
    ttlHours?: number | undefined
    pingBeforeHours?: number | undefined
  }): ApprovalChange[]
}

const isHours = (value: number): boolean =>
  Number.isInteger(value) && value >= 1 && value <= APPROVAL_TTL_MAX_HOURS

export function createApprovalSettings(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
): ApprovalSettings {
  const storedHours = (key: string, fallback: number): number => {
    const stored = settings.get<unknown>(key)
    return typeof stored === 'number' && isHours(stored) ? stored : fallback
  }
  const ttlHours = (): number => storedHours(APPROVAL_TTL_KEY, APPROVAL_TTL_DEFAULT_HOURS)
  const pingBeforeHours = (): number => storedHours(APPROVAL_PING_KEY, APPROVAL_PING_DEFAULT_HOURS)
  const set: ApprovalSettings['set'] = (change) => {
    if (change.ttlHours !== undefined && !isHours(change.ttlHours))
      throw new RangeError(`approval lifetime is 1 to ${APPROVAL_TTL_MAX_HOURS} hours`)
    if (change.pingBeforeHours !== undefined && !isHours(change.pingBeforeHours))
      throw new RangeError(`approval ping is 1 to ${APPROVAL_TTL_MAX_HOURS} hours before expiry`)
    const ttl = change.ttlHours ?? ttlHours()
    const ping = change.pingBeforeHours ?? pingBeforeHours()
    if (ping >= ttl)
      throw new RangeError(
        `the ping (${ping} hours before expiry) must stay below the lifetime (${ttl} hours)`,
      )
    const changes: ApprovalChange[] = []
    if (change.ttlHours !== undefined) {
      changes.push({ key: APPROVAL_TTL_KEY, from: ttlHours(), to: change.ttlHours })
      settings.set(APPROVAL_TTL_KEY, change.ttlHours)
    }
    if (change.pingBeforeHours !== undefined) {
      changes.push({ key: APPROVAL_PING_KEY, from: pingBeforeHours(), to: change.pingBeforeHours })
      settings.set(APPROVAL_PING_KEY, change.pingBeforeHours)
    }
    return changes
  }
  return {
    ttlHours,
    ttlMs: () => ttlHours() * HOUR_MS,
    setTtlHours(hours) {
      set({ ttlHours: hours })
    },
    pingBeforeHours,
    setPingBeforeHours(hours) {
      set({ pingBeforeHours: hours })
    },
    set,
  }
}
