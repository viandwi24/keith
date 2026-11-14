// The activity-log settings (ADR-0032 §6, docs/specs/activity-logs.md "Settings"): instance-wide, stored in the settings table
// under `logs.<name>` keys. `get()` is synchronous and never throws, so the capture path reads it per call and a change applies
// to the next call. A stored value that fails its contract schema reads as its default.
import {
  LOGS_SETTINGS_BOUNDS,
  type LogsSettings,
  LogsSettingsSchema,
  type LogsSettingsSet,
  LogsSettingsSetSchema,
} from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'

/** The settings table keys: `logs.captureBodies`, `logs.bodyRetentionDays`, ... */
export const logsKey = (name: keyof LogsSettings): string => `logs.${name}`

const FIELDS = Object.keys(LOGS_SETTINGS_BOUNDS).concat(['captureBodies', 'guestBodies']) as Array<
  keyof LogsSettings
>

export interface ActivityLogSettings {
  /** The settings now: each stored value that parses, else its default. Never throws. */
  get(): LogsSettings
  /**
   * Store the given fields (already typed; the contract schema checks bounds and the bodies-vs-figures rule). A refusal throws a
   * `RangeError` and writes nothing. Returns the settings after the change.
   */
  set(patch: LogsSettingsSet): LogsSettings
}

export function createActivityLogSettings(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
): ActivityLogSettings {
  const read = (): LogsSettings => {
    const out: Record<string, unknown> = {}
    for (const name of FIELDS) {
      const stored = safely(() => settings.get<unknown>(logsKey(name)))
      if (stored === undefined) continue
      const checked = LogsSettingsSchema.safeParse({ [name]: stored })
      if (checked.success) out[name] = (checked.data as Record<string, unknown>)[name]
    }
    const merged = LogsSettingsSchema.safeParse(out)
    if (merged.success) return merged.data
    // a stored pair that breaks bodies-no-longer-than-figures reads both retention fields as default
    const { bodyRetentionDays: _body, metaRetentionDays: _meta, ...rest } = out
    return LogsSettingsSchema.parse(rest)
  }
  return {
    get: read,
    set(patch) {
      const given = LogsSettingsSetSchema.safeParse(patch)
      if (!given.success) throw new RangeError(given.error.issues[0]?.message ?? 'bad logs setting')
      const current = read()
      const next = LogsSettingsSchema.safeParse({ ...current, ...given.data })
      if (!next.success) throw new RangeError(next.error.issues[0]?.message ?? 'bad logs setting')
      for (const name of FIELDS) {
        if (given.data[name] !== undefined) settings.set(logsKey(name), next.data[name])
      }
      return next.data
    },
  }
}

function safely<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}
