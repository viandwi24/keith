import { describe, expect, test } from 'bun:test'
import type { SettingsRepo } from '@keith/db'
import {
  createNodeCallLimit,
  createNodeCallLimitSettings,
  NODE_CALL_LIMIT_DEFAULT,
  NODE_CALL_LIMIT_KEY,
} from './settings.ts'

/** A settings repo in memory: the two methods the limit reads and writes. */
function memorySettings(): Pick<SettingsRepo, 'get' | 'set'> {
  const values = new Map<string, unknown>()
  return {
    get: (<T>(key: string) => values.get(key) as T) as SettingsRepo['get'],
    set: ((key: string, value: unknown) => {
      values.set(key, value)
    }) as SettingsRepo['set'],
  }
}

describe('the sandbox calls per hour (motor/settings.ts, node-drivers.md "Settings")', () => {
  test('the default is 60 until the owner stores a value; the owner set is read at the next call', () => {
    const settings = memorySettings()
    const limit = createNodeCallLimit(settings)
    const owner = createNodeCallLimitSettings(settings)
    expect(limit()).toBe(NODE_CALL_LIMIT_DEFAULT)
    expect(owner.set(2)).toEqual({
      from: { maxPerHourPerPerson: 60 },
      to: { maxPerHourPerPerson: 2 },
    })
    expect(limit()).toBe(2)
    expect(owner.get()).toEqual({ maxPerHourPerPerson: 2 })
  })

  test('a value out of bounds throws RangeError and writes nothing', () => {
    const settings = memorySettings()
    const owner = createNodeCallLimitSettings(settings)
    for (const bad of [0, 1001, 1.5, Number.NaN]) expect(() => owner.set(bad)).toThrow(RangeError)
    expect(settings.get(NODE_CALL_LIMIT_KEY)).toBeUndefined()
  })

  test('a corrupt stored value reads as the default, never as unlimited', () => {
    const settings = memorySettings()
    settings.set(NODE_CALL_LIMIT_KEY, 5000)
    expect(createNodeCallLimit(settings)()).toBe(NODE_CALL_LIMIT_DEFAULT)
    settings.set(NODE_CALL_LIMIT_KEY, 'lots')
    expect(createNodeCallLimit(settings)()).toBe(NODE_CALL_LIMIT_DEFAULT)
  })
})
