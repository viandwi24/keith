import { describe, expect, test } from 'bun:test'
import {
  type FrontGenerationsRepo,
  frontGenerationsRepo,
  migrateDatabase,
  openDatabase,
} from '@keith/db'
import { frontGenerations } from './generations.ts'

// The generation map (P34.2.1): generation 0 without a row, load reads the stored rows, a bump writes the row and then the
// map, and a failed write leaves the map unchanged.

const db = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

describe('frontGenerations', () => {
  test('a person without a row is generation 0; a bump writes the row and the map', () => {
    const sqlite = db()
    const repo = frontGenerationsRepo(sqlite)
    const port = frontGenerations(repo)
    port.load()
    expect(port.current('ana')).toBe(0)

    expect(port.bump('ana', 100)).toBe(1)
    expect(port.current('ana')).toBe(1)
    expect(repo.get('ana')).toEqual({ personId: 'ana', generation: 1, updatedAt: 100 })
    expect(port.bump('ana', 200)).toBe(2)
    expect(port.current('ana')).toBe(2)
    expect(port.current('bob')).toBe(0)
    sqlite.close()
  })

  test('load reads the stored rows, so a restart keeps the generation', () => {
    const sqlite = db()
    frontGenerationsRepo(sqlite).bump('ana', 100)
    frontGenerationsRepo(sqlite).bump('ana', 110)
    frontGenerationsRepo(sqlite).bump('zoe', 120)

    const port = frontGenerations(frontGenerationsRepo(sqlite))
    expect(port.current('ana')).toBe(0) // nothing read before load
    port.load()
    expect(port.current('ana')).toBe(2)
    expect(port.current('zoe')).toBe(1)
    expect(port.current('bob')).toBe(0)
    sqlite.close()
  })

  test('a failed write leaves the map unchanged', () => {
    const sqlite = db()
    const real = frontGenerationsRepo(sqlite)
    const failing: FrontGenerationsRepo = {
      get: real.get,
      list: real.list,
      delete: real.delete,
      bump: () => {
        throw new Error('disk full')
      },
    }
    const port = frontGenerations(failing)
    port.load()
    expect(() => port.bump('ana', 100)).toThrow(/disk full/)
    expect(port.current('ana')).toBe(0)
    expect(real.get('ana')).toBeUndefined()
    sqlite.close()
  })

  test('forget drops the person from the map: the next read is generation 0', () => {
    const port = frontGenerations(frontGenerationsRepo(db()))
    port.load()
    port.bump('ana', 100)
    port.forget('ana')
    expect(port.current('ana')).toBe(0)
  })
})
