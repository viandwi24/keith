// The room settings (docs/specs/corpus-callosum.md, "Settings"): read from the settings repo at each use, so a change applies
// to the next call without a restart. Bounds and defaults come from @keith/contracts; a corrupt stored value reads as the default.
import { ROOM_SETTINGS_DEFAULTS, type RoomSettings, RoomSettingsSchema } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'

/** The settings keys, one per value (`rooms.<name>`). */
export const ROOM_SETTING_KEYS = {
  maxMembers: 'rooms.maxMembers',
  inviteTtlMinutes: 'rooms.inviteTtlMinutes',
  maxTurnsPerHour: 'rooms.maxTurnsPerHour',
  maxQueue: 'rooms.maxQueue',
  windowMinutes: 'rooms.windowMinutes',
  windowEvents: 'rooms.windowEvents',
} as const

type Key = keyof typeof ROOM_SETTING_KEYS

/** A change: any of the six keys; an undefined key is not changed (the RPC input passes its optional keys through). */
export type RoomSettingsChange = { [K in keyof RoomSettings]?: RoomSettings[K] | undefined }

export interface RoomSettingsReader {
  maxMembers(): number
  inviteTtlMinutes(): number
  maxTurnsPerHour(): number
  maxQueue(): number
  windowMinutes(): number
  windowEvents(): number
  /** All six values in force. */
  values(): RoomSettings
  /**
   * Stores the given keys. Every value is checked first: one outside its bounds throws `RangeError` and nothing is written.
   * Returns the previous and the new value of each key given (the audit detail `{ from, to }`).
   */
  set(change: RoomSettingsChange): { from: Partial<RoomSettings>; to: Partial<RoomSettings> }
}

function read(settings: Pick<SettingsRepo, 'get'>, key: Key): number {
  const stored = settings.get<unknown>(ROOM_SETTING_KEYS[key])
  const parsed = RoomSettingsSchema.shape[key].safeParse(stored)
  return parsed.success ? parsed.data : ROOM_SETTINGS_DEFAULTS[key]
}

export function createRoomSettings(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
): RoomSettingsReader {
  const values = (): RoomSettings => ({
    maxMembers: read(settings, 'maxMembers'),
    inviteTtlMinutes: read(settings, 'inviteTtlMinutes'),
    maxTurnsPerHour: read(settings, 'maxTurnsPerHour'),
    maxQueue: read(settings, 'maxQueue'),
    windowMinutes: read(settings, 'windowMinutes'),
    windowEvents: read(settings, 'windowEvents'),
  })
  return {
    maxMembers: () => read(settings, 'maxMembers'),
    inviteTtlMinutes: () => read(settings, 'inviteTtlMinutes'),
    maxTurnsPerHour: () => read(settings, 'maxTurnsPerHour'),
    maxQueue: () => read(settings, 'maxQueue'),
    windowMinutes: () => read(settings, 'windowMinutes'),
    windowEvents: () => read(settings, 'windowEvents'),
    values,
    set(change) {
      const given = (Object.keys(change) as Key[]).flatMap((key) => {
        const value = change[key]
        return value === undefined ? [] : [{ key, value }]
      })
      for (const { key, value } of given) {
        if (!RoomSettingsSchema.shape[key].safeParse(value).success)
          throw new RangeError(`${ROOM_SETTING_KEYS[key]} is out of its bounds`)
      }
      const from: Partial<RoomSettings> = {}
      const to: Partial<RoomSettings> = {}
      for (const { key, value } of given) {
        from[key] = read(settings, key)
        to[key] = value
        settings.set(ROOM_SETTING_KEYS[key], value)
      }
      return { from, to }
    },
  }
}
