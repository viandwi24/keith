// The protocol settings of the hypothalamus region (docs/specs/hypothalamus.md, "Settings"). Read from the settings repo at
// each call, so a change applies at the next tick without a restart. Bounds and defaults come from @keith/contracts.
import {
  PROTOCOL_SETTINGS_DEFAULTS,
  type ProtocolSettings,
  ProtocolSettingsSchema,
  type ProtocolSettingsSet,
} from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'

/** The settings keys (the stored value is an integer). */
export const PROTOCOL_SETTING_KEYS = {
  tickMs: 'protocols.tickMs',
  maxPerPerson: 'protocols.maxPerPerson',
  maxPerPersonRunsPerDay: 'protocols.maxPerPersonRunsPerDay',
} as const

export interface ProtocolSettingsReader {
  /** The engine tick in milliseconds. */
  tickMs(): number
  /** Protocols one person may own. */
  maxPerPerson(): number
  /** Runs a person may start in a UTC day across their protocols. */
  maxPerPersonRunsPerDay(): number
  /** All three values in force. */
  values(): ProtocolSettings
  /**
   * Stores the given keys. Every value is checked first: a value outside its bounds throws `RangeError` and nothing is
   * written. Returns the previous and the new value of each key given (the audit detail `{ from, to }`).
   */
  set(change: ProtocolSettingsSet): {
    from: Partial<ProtocolSettings>
    to: Partial<ProtocolSettings>
  }
}

type Key = keyof typeof PROTOCOL_SETTING_KEYS

/** A corrupt or out-of-bound stored value reads as the default, never as an unbounded value. */
function read(settings: Pick<SettingsRepo, 'get'>, key: Key): number {
  const stored = settings.get<unknown>(PROTOCOL_SETTING_KEYS[key])
  const parsed = ProtocolSettingsSchema.shape[key].safeParse(stored)
  return parsed.success ? parsed.data : PROTOCOL_SETTINGS_DEFAULTS[key]
}

export function createProtocolSettings(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
): ProtocolSettingsReader {
  const values = (): ProtocolSettings => ({
    tickMs: read(settings, 'tickMs'),
    maxPerPerson: read(settings, 'maxPerPerson'),
    maxPerPersonRunsPerDay: read(settings, 'maxPerPersonRunsPerDay'),
  })
  return {
    tickMs: () => read(settings, 'tickMs'),
    maxPerPerson: () => read(settings, 'maxPerPerson'),
    maxPerPersonRunsPerDay: () => read(settings, 'maxPerPersonRunsPerDay'),
    values,
    set(change) {
      const keys = Object.keys(change) as Key[]
      for (const key of keys) {
        const parsed = ProtocolSettingsSchema.shape[key].safeParse(change[key])
        if (!parsed.success)
          throw new RangeError(
            `${PROTOCOL_SETTING_KEYS[key]} is out of range: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
          )
      }
      const before = values()
      const from: Partial<ProtocolSettings> = {}
      const to: Partial<ProtocolSettings> = {}
      for (const key of keys) {
        const value = change[key] as number
        from[key] = before[key]
        to[key] = value
        settings.set(PROTOCOL_SETTING_KEYS[key], value)
      }
      return { from, to }
    },
  }
}
