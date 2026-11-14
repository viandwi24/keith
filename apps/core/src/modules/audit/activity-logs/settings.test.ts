import { describe, expect, test } from 'bun:test'
import { LogsSettingsSchema } from '@keith/contracts'
import { migrateDatabase, openDatabase, settingsRepo } from '@keith/db'
import { createActivityLogSettings, logsKey } from './settings.ts'

function fresh() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const settings = settingsRepo(sqlite)
  return { settings, store: createActivityLogSettings(settings) }
}

const DEFAULTS = LogsSettingsSchema.parse({})

describe('activity log settings', () => {
  test('defaults: bodies on for owners, guest bodies off, 14 and 365 days, 512 KB cap', () => {
    const { store } = fresh()
    expect(store.get()).toEqual({
      captureBodies: true,
      guestBodies: false,
      bodyRetentionDays: 14,
      metaRetentionDays: 365,
      maxBodyBytes: 512 * 1024,
    })
    expect(store.get()).toEqual(DEFAULTS)
  })

  test('a partial set changes the given fields only and survives a new store over the same table', () => {
    const { settings, store } = fresh()
    const after = store.set({ captureBodies: false, bodyRetentionDays: 7 })
    expect(after).toEqual({ ...DEFAULTS, captureBodies: false, bodyRetentionDays: 7 })
    expect(settings.get(logsKey('captureBodies'))).toBe(false)
    expect(settings.get(logsKey('metaRetentionDays'))).toBeUndefined()
    expect(createActivityLogSettings(settings).get()).toEqual(after)
  })

  test('a value out of bounds or bodies outliving figures is refused and nothing is written', () => {
    const { settings, store } = fresh()
    expect(() => store.set({ bodyRetentionDays: 0 })).toThrow(RangeError)
    expect(() => store.set({ maxBodyBytes: 10 })).toThrow(RangeError)
    expect(() => store.set({ bodyRetentionDays: 90, metaRetentionDays: 30 })).toThrow(RangeError)
    expect(() => store.set({ bodyRetentionDays: 60 })).not.toThrow()
    expect(() => store.set({ metaRetentionDays: 30 })).toThrow(RangeError)
    expect(settings.get(logsKey('metaRetentionDays'))).toBeUndefined()
    expect(store.get().bodyRetentionDays).toBe(60)
  })

  test('a corrupt stored value reads as its default and never throws', () => {
    const { settings, store } = fresh()
    settings.set(logsKey('captureBodies'), 'yes')
    settings.set(logsKey('maxBodyBytes'), -1)
    expect(store.get().captureBodies).toBe(true)
    expect(store.get().maxBodyBytes).toBe(512 * 1024)
  })

  test('a stored retention pair that breaks the rule reads both retention fields as default', () => {
    const { settings, store } = fresh()
    settings.set(logsKey('bodyRetentionDays'), 90)
    settings.set(logsKey('metaRetentionDays'), 30)
    settings.set(logsKey('guestBodies'), true)
    const read = store.get()
    expect(read.bodyRetentionDays).toBe(14)
    expect(read.metaRetentionDays).toBe(365)
    expect(read.guestBodies).toBe(true)
  })

  test('a throwing store read falls back to defaults', () => {
    const store = createActivityLogSettings({
      get: () => {
        throw new Error('db closed')
      },
      set: () => {},
    })
    expect(store.get()).toEqual(DEFAULTS)
  })
})
