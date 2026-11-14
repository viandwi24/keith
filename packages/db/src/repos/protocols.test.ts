import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { protocolProposalsRepo, protocolsRepo } from './protocols.ts'

// Repos of the protocol and proposal tables (P28.1.5, docs/specs/hypothalamus.md "Data model"): versions with a
// compare-and-set on the current version, the built-in and name guards, and proposals that only leave `pending` once.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const def = (text: string) => JSON.stringify({ steps: [{ text }] })

describe('protocols', () => {
  test('create writes version 1 and its version row; the name and the built-in are unique per owner', () => {
    const repo = protocolsRepo(db())
    const created = repo.create(
      {
        id: 'p1',
        owner: 'keith',
        name: 'approval-stale',
        builtIn: 'approval-stale',
        definition: def('a'),
        savedBy: 'keith',
      },
      100,
    )
    expect(created).toMatchObject({
      ok: true,
      protocol: {
        id: 'p1',
        owner: 'keith',
        enabled: true,
        pausedUntil: null,
        version: 1,
        createdAt: 100,
      },
    })
    expect(repo.version('p1', 1)).toMatchObject({
      definition: def('a'),
      approvals: '[]',
      savedBy: 'keith',
    })

    expect(
      repo.create(
        {
          id: 'p2',
          owner: 'keith',
          name: 'approval-stale',
          definition: def('b'),
          savedBy: 'keith',
        },
        101,
      ),
    ).toEqual({ ok: false, reason: 'name' })
    expect(
      repo.create(
        {
          id: 'p3',
          owner: 'keith',
          name: 'other',
          builtIn: 'approval-stale',
          definition: def('c'),
          savedBy: 'keith',
        },
        102,
      ),
    ).toEqual({ ok: false, reason: 'built-in' })
    // another owner may have the same name and the same built-in
    expect(
      repo.create(
        {
          id: 'p4',
          owner: 'ana',
          name: 'approval-stale',
          builtIn: 'approval-stale',
          definition: def('d'),
          savedBy: 'ana',
        },
        103,
      ).ok,
    ).toBe(true)
    expect(repo.findBuiltIn('keith', 'approval-stale')?.id).toBe('p1')
    expect(repo.list('ana').map((p) => p.id)).toEqual(['p4'])
    expect(repo.list().map((p) => p.id)).toEqual(['p4', 'p1'])
  })

  test('saveVersion moves the current version by compare-and-set and keeps every old row', () => {
    const repo = protocolsRepo(db())
    repo.create(
      { id: 'p1', owner: 'ana', name: 'stand up', definition: def('a'), savedBy: 'ana' },
      100,
    )

    expect(
      repo.saveVersion(
        'p1',
        1,
        { definition: def('b'), approvals: '[{"stepId":"x"}]', savedBy: 'ana' },
        200,
      ),
    ).toEqual({ ok: true, version: 2 })
    // a caller that still holds version 1 is refused and writes nothing
    expect(repo.saveVersion('p1', 1, { definition: def('c'), savedBy: 'ana' }, 300)).toEqual({
      ok: false,
      reason: 'conflict',
      current: 2,
    })
    expect(repo.saveVersion('missing', 1, { definition: def('c'), savedBy: 'ana' }, 300)).toEqual({
      ok: false,
      reason: 'not-found',
    })

    expect(repo.get('p1')).toMatchObject({ version: 2, updatedAt: 200 })
    expect(repo.versions('p1').map((v) => [v.version, v.definition])).toEqual([
      [1, def('a')],
      [2, def('b')],
    ])
    expect(repo.version('p1', 2)?.approvals).toBe('[{"stepId":"x"}]')
  })

  test('two saves from the same version: one wins, the other is a conflict', () => {
    const repo = protocolsRepo(db())
    repo.create({ id: 'p1', owner: 'ana', name: 'n', definition: def('a'), savedBy: 'ana' }, 1)
    const first = repo.saveVersion('p1', 1, { definition: def('b'), savedBy: 'ana' }, 2)
    const second = repo.saveVersion('p1', 1, { definition: def('c'), savedBy: 'ana' }, 3)
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'conflict', current: 2 })
    expect(repo.versions('p1')).toHaveLength(2)
  })

  test('enable, pause and remove; removing a protocol removes its versions', () => {
    const sqlite = db()
    const repo = protocolsRepo(sqlite)
    repo.create({ id: 'p1', owner: 'ana', name: 'n', definition: def('a'), savedBy: 'ana' }, 1)
    expect(repo.setEnabled('p1', false, 5)).toBe(true)
    expect(repo.setPausedUntil('p1', 900, 6)).toBe(true)
    expect(repo.get('p1')).toMatchObject({ enabled: false, pausedUntil: 900, updatedAt: 6 })
    expect(repo.setPausedUntil('p1', null, 7)).toBe(true)
    expect(repo.get('p1')?.pausedUntil).toBeNull()
    expect(repo.setEnabled('nope', true, 8)).toBe(false)

    expect(repo.remove('p1')).toBe(true)
    expect(repo.get('p1')).toBeUndefined()
    expect(repo.versions('p1')).toEqual([])
    expect(repo.remove('p1')).toBe(false)
  })
})

describe('protocol proposals', () => {
  const input = (id: string, person = 'ana') => ({
    id,
    person,
    definition: def('keep quiet'),
    reason: 'you said meeting at 9',
    source: '{"session":"s1","message":"m1"}',
    expiresAt: 1_000 + 7 * 86_400_000,
  })

  test('a proposal is pending until it is decided once; expireDue ends only pending ones past their expiry', () => {
    const repo = protocolProposalsRepo(db())
    expect(repo.create(input('x1'), 1_000)).toMatchObject({ status: 'pending', createdAt: 1_000 })
    repo.create(input('x2'), 1_000)
    repo.create({ ...input('x3'), expiresAt: 500 }, 1_000)

    expect(repo.decide('x1', 'confirmed')).toBe(true)
    expect(repo.decide('x1', 'dismissed')).toBe(false)
    expect(repo.get('x1')?.status).toBe('confirmed')

    expect(repo.expireDue(1_000)).toBe(1)
    expect(repo.get('x3')?.status).toBe('expired')
    expect(repo.get('x2')?.status).toBe('pending')
    expect(repo.decide('x3', 'confirmed')).toBe(false)
  })

  test('list is per person and newest first, optionally by status', () => {
    const repo = protocolProposalsRepo(db())
    repo.create(input('old'), 1)
    repo.create(input('new'), 2)
    repo.create(input('theirs', 'bob'), 3)
    repo.decide('old', 'dismissed')
    expect(repo.list('ana').map((p) => p.id)).toEqual(['new', 'old'])
    expect(repo.list('ana', 'pending').map((p) => p.id)).toEqual(['new'])
    expect(repo.list('bob').map((p) => p.id)).toEqual(['theirs'])
  })
})
