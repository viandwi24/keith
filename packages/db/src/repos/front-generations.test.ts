import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { frontGenerationsRepo } from './front-generations.ts'

// The current front generation per person (P34.2.1): a missing row is generation 0, a bump is one transaction that moves the
// row by one, the rows are independent per person, and a refused write leaves the table as it was.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

describe('frontGenerationsRepo', () => {
  test('a person without a row has no record; the first bump writes generation 1', () => {
    const repo = frontGenerationsRepo(db())
    expect(repo.get('ana')).toBeUndefined()
    expect(repo.list()).toEqual([])

    expect(repo.bump('ana', 100)).toBe(1)
    expect(repo.get('ana')).toEqual({ personId: 'ana', generation: 1, updatedAt: 100 })
  })

  test('each bump moves the row by one and stores its time', () => {
    const repo = frontGenerationsRepo(db())
    expect(repo.bump('ana', 100)).toBe(1)
    expect(repo.bump('ana', 200)).toBe(2)
    expect(repo.bump('ana', 300)).toBe(3)
    expect(repo.get('ana')).toEqual({ personId: 'ana', generation: 3, updatedAt: 300 })
  })

  test('the rows of two people are independent; list orders them by person', () => {
    const repo = frontGenerationsRepo(db())
    repo.bump('zoe', 10)
    repo.bump('zoe', 20)
    repo.bump('ana', 30)
    expect(repo.get('bob')).toBeUndefined()
    expect(repo.list()).toEqual([
      { personId: 'ana', generation: 1, updatedAt: 30 },
      { personId: 'zoe', generation: 2, updatedAt: 20 },
    ])
  })

  test('a bump that fails inside the transaction leaves the row unchanged', () => {
    const sqlite = db()
    const repo = frontGenerationsRepo(sqlite)
    repo.bump('ana', 100)
    // a trigger that refuses the new row makes the write throw inside the transaction
    sqlite.exec(
      `CREATE TRIGGER refuse_gen2 BEFORE UPDATE ON front_generations WHEN NEW.generation = 2
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    )
    expect(() => repo.bump('ana', 200)).toThrow(/refused/)
    expect(repo.get('ana')).toEqual({ personId: 'ana', generation: 1, updatedAt: 100 })
  })

  test('delete removes the row of one person; the next reset starts again at generation 1', () => {
    const repo = frontGenerationsRepo(db())
    repo.bump('ana', 100)
    repo.bump('zoe', 100)
    expect(repo.delete('ana')).toBe(true)
    expect(repo.delete('ana')).toBe(false)
    expect(repo.get('ana')).toBeUndefined()
    expect(repo.get('zoe')).toEqual({ personId: 'zoe', generation: 1, updatedAt: 100 })
    expect(repo.bump('ana', 300)).toBe(1)
  })
})
