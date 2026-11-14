import { describe, expect, test } from 'bun:test'
import type { AclActor } from '@keith/contracts'
import { AclError } from './errors.ts'
import { type MemoryAcl, memoryAcl } from './memory.ts'
import { requireAccess } from './store.ts'
import {
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  type LeakOperations,
  leakCheck,
} from './testing/index.ts'

const actors = {
  owner: CASE_ACTORS.owner,
  outsider: CASE_ACTORS.outsider,
  groupMember: CASE_ACTORS.a,
  guest: CASE_ACTORS.guest,
}

interface Note {
  title: string
  body: string
}

/** A toy plugin over the in-memory store: the shape P16's Notes will have. `bug` plants one mistake. */
function toy(bug?: 'post-filter-count' | 'forbidden-text' | 'snippet' | 'write-unchecked') {
  const store: MemoryAcl = memoryAcl({ kinds: CASE_KINDS })
  for (const p of CASE_PEOPLE) store.activate(p)
  for (const [group, people] of Object.entries(CASE_GROUPS)) {
    store.createGroup({ id: group, name: group.toLowerCase().repeat(2), createdBy: 'boss' })
    for (const p of people) store.addMember(group, p, 'boss')
  }
  const notes = new Map<string, Note>()
  const seeded = (id: string) => notes.has(id)
  const ops: LeakOperations = {
    list: (a: AclActor) =>
      store.visibleIds(a, 'note', 4).map((id) => ({ id, title: notes.get(id)?.title })),
    count: (a: AclActor) =>
      bug === 'post-filter-count' ? notes.size : store.visibleIds(a, 'note', 4).length,
    search: (a: AclActor, term: string) => {
      const hits = store
        .visibleIds(a, 'note', 4)
        .filter((id) => notes.get(id)?.body.includes(term))
        .map((id) => ({ id }))
      if (bug === 'snippet') {
        const leaked = [...notes.entries()].find(([, n]) => n.body.includes(term))
        return hits.length === 0 && leaked !== undefined
          ? { hits, hint: leaked[1].title }
          : { hits }
      }
      return { hits }
    },
    get: (a: AclActor, id: string) => {
      if (bug === 'forbidden-text' && seeded(id) && !store.check(a, 'note', id, 4).allowed)
        throw new AclError('FORBIDDEN')
      requireAccess(store, a, 'note', id, 4)
      return notes.get(id)
    },
    update: (a: AclActor, id: string) => {
      if (bug !== 'write-unchecked') requireAccess(store, a, 'note', id, 2)
      const n = notes.get(id)
      if (n === undefined) throw new AclError('NOT_FOUND')
      n.body = 'edited'
      return { ok: true }
    },
    delete: (a: AclActor, id: string) => {
      if (bug !== 'write-unchecked') requireAccess(store, a, 'note', id, 2)
      if (!notes.delete(id)) throw new AclError('NOT_FOUND')
      store.removeResource('note', id)
      return { ok: true }
    },
  }
  const seed = () => {
    store.createResource({ kind: 'note', id: 'n-secret', ownerId: actors.owner.id })
    notes.set('n-secret', { title: 'Tax plan', body: 'offshore marmalade fund' })
    return {
      id: 'n-secret',
      missingId: 'n-absent',
      secrets: ['Tax plan', 'offshore marmalade fund'],
    }
  }
  return { ops, seed }
}

describe('leakCheck', () => {
  test('a plugin that filters in the store and answers not-found passes', async () => {
    const { ops, seed } = toy()
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
  })

  test('a count taken before the filter is caught', async () => {
    const { ops, seed } = toy('post-filter-count')
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.ok).toBe(false)
    expect(report.problems.join('\n')).toContain('count changed')
  })

  test('forbidden for a private resource but not found for a missing one is caught', async () => {
    const { ops, seed } = toy('forbidden-text')
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.problems.join('\n')).toContain('get on a private resource differs')
  })

  test('a search that leaks a title through a hint is caught', async () => {
    const { ops, seed } = toy('snippet')
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.problems.join('\n')).toMatch(/search/)
    expect(report.problems.join('\n')).toContain('Tax plan')
  })

  test('a write that skips the check is caught', async () => {
    const { ops, seed } = toy('write-unchecked')
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.problems.join('\n')).toMatch(/update|delete/)
  })

  test('a fixture the owner cannot read is reported, not passed', async () => {
    const { ops, seed } = toy()
    const report = await leakCheck({
      operations: {
        ...ops,
        get: () => {
          throw new AclError('NOT_FOUND')
        },
      },
      actors,
      seed,
      term: 'marmalade',
    })
    expect(report.problems.join('\n')).toContain('vacuous')
  })

  test('works without a guest and with only some operations', async () => {
    const { ops, seed } = toy()
    const { guest: _guest, ...noGuest } = actors
    const report = await leakCheck({
      operations: { get: (a, id) => ops.get?.(a, id) },
      actors: noGuest,
      seed,
      term: 'marmalade',
    })
    expect(report.ok).toBe(true)
  })
})
