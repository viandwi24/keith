import { expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import { workspacesRepo } from './workspaces.ts'

// One workspace document per person, written by compare and set on its version.

const repo = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return workspacesRepo(sqlite)
}

test('no row means version 0; the first write creates it, the next must name the version it replaces', () => {
  const r = repo()
  expect(r.get('ana')).toBeUndefined()
  expect(r.put('ana', 0, 1, '{"a":1}', 10)).toBe(true)
  expect(r.get('ana')).toEqual({ personId: 'ana', version: 1, doc: '{"a":1}', updatedAt: 10 })
  expect(r.put('ana', 0, 1, '{"late":1}', 11)).toBe(false) // a second first write lost the race
  expect(r.put('ana', 1, 2, '{"a":2}', 12)).toBe(true)
  expect(r.put('ana', 1, 2, '{"stale":1}', 13)).toBe(false)
  expect(r.get('ana')?.doc).toBe('{"a":2}')
})

test('rows are per person and a removed person loses theirs', () => {
  const r = repo()
  r.put('ana', 0, 1, '{}', 1)
  r.put('ben', 0, 1, '{}', 1)
  expect(r.delete('ana')).toBe(true)
  expect(r.get('ana')).toBeUndefined()
  expect(r.get('ben')?.version).toBe(1)
  expect(r.delete('ana')).toBe(false)
})
