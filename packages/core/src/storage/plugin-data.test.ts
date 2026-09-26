import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTestDb, type TestDb } from './testing.ts'

let db: TestDb
beforeEach(() => {
  db = createTestDb()
})
afterEach(() => db.close())

describe('plugin data', () => {
  test('round-trips JSON values per plugin', async () => {
    const repo = db.repos.pluginData
    expect(await repo.get('weather', 'city')).toBeUndefined()
    await repo.set('weather', 'city', { name: 'Lyon', lat: 45.76 }, 1)
    await repo.set('weather', 'enabled', false, 1)
    await repo.set('notes', 'city', 'Paris', 1)
    expect(await repo.get('weather', 'city')).toEqual({ name: 'Lyon', lat: 45.76 })
    expect(await repo.get('weather', 'enabled')).toBe(false)
    await repo.set('weather', 'city', null, 2)
    expect(await repo.get('weather', 'city')).toBeNull()
    await repo.delete('weather', 'city')
    expect(await repo.get('weather', 'city')).toBeUndefined()
    expect(await repo.get('notes', 'city')).toBe('Paris')
  })

  test('lists keys, optionally by prefix', async () => {
    const repo = db.repos.pluginData
    for (const key of ['alert:2', 'alert:1', 'city', 'alert_x']) await repo.set('weather', key, 1, 1)
    await repo.set('other', 'alert:3', 1, 1)
    expect(await repo.list('weather')).toEqual(['alert:1', 'alert:2', 'alert_x', 'city'])
    expect(await repo.list('weather', 'alert:')).toEqual(['alert:1', 'alert:2'])
    expect(await repo.list('weather', 'al%')).toEqual([])
  })
})
