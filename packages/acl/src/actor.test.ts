import { expect, test } from 'bun:test'
import type { Actor } from '@keith/contracts'
import { aclActorOf } from './actor.ts'

const base: Actor = {
  kind: 'user',
  personId: 'p1',
  principalId: 'p1',
  role: 'member',
  sessionId: 's1',
  methods: ['pin'],
  assurance: 1,
  elevated: false,
  zone: 'lan',
  via: 'tcp',
}

test('a user maps to id and role; a guest to its principal id; a system actor to none', () => {
  expect(aclActorOf(base)).toEqual({ kind: 'user', id: 'p1', role: 'member' })
  expect(
    aclActorOf({ ...base, kind: 'guest', personId: null, principalId: 'guest:9', role: null }),
  ).toEqual({
    kind: 'guest',
    id: 'guest:9',
    role: null,
  })
  expect(aclActorOf({ ...base, kind: 'system', personId: null, role: null })).toBeUndefined()
  expect(aclActorOf({ ...base, personId: null })).toBeUndefined()
})
