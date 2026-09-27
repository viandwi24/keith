import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { person, testId } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { AuthTokenRecord, NodeRecord } from './types.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await db.repos.persons.create(person(1))
})
afterEach(() => db.close())

function token(hash: string, expiresAt: number): AuthTokenRecord {
  return { tokenHash: hash, personId: testId('per', 1), nodeId: null, expiresAt, createdAt: 1 }
}

describe('auth tokens', () => {
  test('round-trips a token and fills its node', async () => {
    await db.repos.authTokens.create(token('a', 100))
    expect(await db.repos.authTokens.get('a')).toEqual(token('a', 100))
    await db.repos.authTokens.setNode('a', testId('nod', 1))
    expect((await db.repos.authTokens.get('a'))?.nodeId).toBe(testId('nod', 1))
    await db.repos.authTokens.delete('a')
    expect(await db.repos.authTokens.get('a')).toBeNull()
  })

  test('deletes expired tokens and returns how many', async () => {
    await db.repos.authTokens.create(token('old', 10))
    await db.repos.authTokens.create(token('edge', 20))
    await db.repos.authTokens.create(token('new', 30))
    expect(await db.repos.authTokens.deleteExpired(20)).toBe(2)
    expect(await db.repos.authTokens.get('new')).not.toBeNull()
    expect(await db.repos.authTokens.get('old')).toBeNull()
  })
})

describe('nodes', () => {
  test('upserts, round-trips and touches a node', async () => {
    const node: NodeRecord = {
      id: testId('nod', 1),
      name: 'tui',
      kind: 'attended',
      capabilities: ['text.in', 'text.out'],
      lastSeenAt: null,
    }
    await db.repos.nodes.upsert(node)
    expect(await db.repos.nodes.get(node.id)).toEqual(node)
    await db.repos.nodes.upsert({ ...node, name: 'web', capabilities: [] })
    expect(await db.repos.nodes.get(node.id)).toEqual({ ...node, name: 'web', capabilities: [] })
    await db.repos.nodes.touch(node.id, 55)
    expect((await db.repos.nodes.get(node.id))?.lastSeenAt).toBe(55)
    expect(await db.repos.nodes.get(testId('nod', 2))).toBeNull()
  })
})
