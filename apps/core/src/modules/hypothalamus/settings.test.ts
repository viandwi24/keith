import { describe, expect, test } from 'bun:test'
import { PROTOCOL_SETTINGS_DEFAULTS, ProtocolSettingsSetSchema } from '@keith/contracts'
import { createProtocolSettings, PROTOCOL_SETTING_KEYS } from './settings.ts'

function memorySettings(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => {
      values.set(key, value)
    },
  }
}

describe('protocol settings', () => {
  test('defaults when nothing is stored: tick 15 s, 20 protocols and 20 runs a day per person', () => {
    const settings = createProtocolSettings(memorySettings())
    expect(settings.values()).toEqual({
      tickMs: 15_000,
      maxPerPerson: 20,
      maxPerPersonRunsPerDay: 20,
    })
    expect(PROTOCOL_SETTINGS_DEFAULTS.tickMs).toBe(15_000)
  })

  test('a corrupt or out-of-bound stored value reads as the default, never as a bound', () => {
    const settings = createProtocolSettings(
      memorySettings({
        [PROTOCOL_SETTING_KEYS.tickMs]: 'soon',
        [PROTOCOL_SETTING_KEYS.maxPerPerson]: 0,
        [PROTOCOL_SETTING_KEYS.maxPerPersonRunsPerDay]: 201,
      }),
    )
    expect(settings.values()).toEqual({
      tickMs: 15_000,
      maxPerPerson: 20,
      maxPerPersonRunsPerDay: 20,
    })
  })

  test('bounds: tick 5 000 to 60 000; a value of 4 999 or 60 001 is refused and nothing is written', () => {
    const store = memorySettings()
    const settings = createProtocolSettings(store)
    for (const bad of [4_999, 60_001, 1.5]) {
      expect(() => settings.set({ tickMs: bad })).toThrow(RangeError)
    }
    expect(store.get(PROTOCOL_SETTING_KEYS.tickMs)).toBeUndefined()
    expect(settings.tickMs()).toBe(15_000)
    settings.set({ tickMs: 5_000 })
    expect(settings.tickMs()).toBe(5_000)
    settings.set({ tickMs: 60_000 })
    expect(settings.tickMs()).toBe(60_000)
  })

  test('a refused change in a batch writes none of its keys', () => {
    const store = memorySettings()
    const settings = createProtocolSettings(store)
    expect(() => settings.set({ maxPerPerson: 30, maxPerPersonRunsPerDay: 0 })).toThrow(RangeError)
    expect(settings.values().maxPerPerson).toBe(20)
  })

  test('set returns the from and to of the keys given, and a stored value is read at once', () => {
    const store = memorySettings()
    const settings = createProtocolSettings(store)
    expect(settings.set({ maxPerPerson: 5 })).toEqual({
      from: { maxPerPerson: 20 },
      to: { maxPerPerson: 5 },
    })
    // written through the repo, read at the next call: no restart of the reader is needed
    store.set(PROTOCOL_SETTING_KEYS.tickMs, 30_000)
    expect(settings.tickMs()).toBe(30_000)
    expect(settings.maxPerPerson()).toBe(5)
    expect(settings.maxPerPersonRunsPerDay()).toBe(20)
  })

  test('the change schema takes any subset of the keys, at least one, within the same bounds', () => {
    expect(ProtocolSettingsSetSchema.safeParse({}).success).toBe(false)
    expect(ProtocolSettingsSetSchema.safeParse({ tickMs: 4_999 }).success).toBe(false)
    expect(ProtocolSettingsSetSchema.safeParse({ maxPerPersonRunsPerDay: 200 }).success).toBe(true)
    expect(ProtocolSettingsSetSchema.safeParse({ maxPerPerson: 101 }).success).toBe(false)
  })
})
