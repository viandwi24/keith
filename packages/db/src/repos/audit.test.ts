import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import { auditRepo } from './audit.ts'

function repo() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return auditRepo(sqlite)
}

describe('audit listFor', () => {
  test('finds rows by the subject fields of their kind and by the old personId key, never others', () => {
    const r = repo()
    r.add({ kind: 'person.secret.set', actor: 'own', via: 'local', detail: { subject: 'ana' } })
    r.add({ kind: 'person.update', actor: 'own', via: 'local', detail: { personId: 'ana' } }) // old row
    r.add({
      kind: 'acl.owner-access',
      actor: 'own',
      via: 'tcp',
      detail: { owner: 'ana', id: 'n1' },
    })
    r.add({ kind: 'acl.share', actor: 'ben', via: 'tcp', detail: { resourceOwner: 'ana' } })
    r.add({ kind: 'person.secret.set', actor: 'own', via: 'local', detail: { subject: 'ben' } })
    r.add({
      kind: 'acl.owner-access',
      actor: 'own',
      via: 'tcp',
      detail: { owner: 'ben', id: 'n2' },
    })
    // a kind that is not in the registry is never returned, whatever its detail says
    r.add({
      kind: 'auth.login.ok',
      actor: 'ana',
      via: 'tcp',
      detail: { personId: 'ana', subject: 'ana' },
    })
    const { rows, next } = r.listFor('ana', { limit: 50 })
    expect(rows.map((x) => x.kind)).toEqual([
      'acl.share',
      'acl.owner-access',
      'person.update',
      'person.secret.set',
    ])
    expect(next).toBeUndefined()
  })

  test('an array-valued subject field (room.read members) matches each id in it, and nothing else', () => {
    const r = repo()
    r.add({
      kind: 'room.read',
      actor: 'own',
      via: 'tcp',
      detail: { roomId: 'r1', owner: 'ana', members: ['ana', 'bob'] },
    })
    r.add({
      kind: 'room.read',
      actor: 'own',
      via: 'tcp',
      detail: { roomId: 'r2', owner: 'cy', members: ['cy', 'dan'] },
    })
    expect(r.listFor('bob', { limit: 50 }).rows.map((x) => x.detail.roomId)).toEqual(['r1'])
    expect(r.listFor('ana', { limit: 50 }).rows.map((x) => x.detail.roomId)).toEqual(['r1'])
    expect(r.listFor('eve', { limit: 50 }).rows).toEqual([])
    // an id that is only a substring of a member's id is not a match
    expect(r.listFor('b', { limit: 50 }).rows).toEqual([])
  })

  test('limit and before page newest first', () => {
    const r = repo()
    for (let i = 0; i < 5; i++)
      r.add({ kind: 'person.update', actor: 'own', via: 'local', detail: { subject: 'ana', i } })
    const first = r.listFor('ana', { limit: 2 })
    expect(first.rows.map((x) => x.detail.i)).toEqual([4, 3])
    expect(first.next).toBe(first.rows[1]?.id)
    const second = r.listFor('ana', { limit: 2, before: first.next as number })
    expect(second.rows.map((x) => x.detail.i)).toEqual([2, 1])
  })

  test('the scan bound stops one call: a short page comes with a cursor to read on', () => {
    const r = repo()
    r.add({ kind: 'person.update', actor: 'own', via: 'local', detail: { subject: 'ana' } })
    for (let i = 0; i < 10; i++)
      r.add({ kind: 'person.update', actor: 'own', via: 'local', detail: { subject: 'ben' } })
    const page = r.listFor('ana', { limit: 5, scan: 4 })
    expect(page.rows).toEqual([])
    expect(page.next).toBeDefined()
    let next = page.next
    let found = 0
    while (next !== undefined) {
      const more = r.listFor('ana', { limit: 5, scan: 4, before: next })
      found += more.rows.length
      next = more.next
    }
    expect(found).toBe(1)
  })
})
