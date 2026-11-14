import { describe, expect, test } from 'bun:test'
import type { AclActor, Entry } from '@keith/contracts'
import { Bits } from '@keith/contracts'
import { check, type ResourceAccess } from './check.ts'
import { defineKinds } from './kinds.ts'
import type { Membership } from './membership.ts'
import { CASE_KINDS } from './testing/index.ts'

const people = new Set(['olga', 'mia', 'ben', 'cai', 'boss'])
const groups: Record<string, string[]> = { A: ['mia'], C: ['cai'] }
const membership: Membership = {
  isActive: (id) => people.has(id),
  isMember: (g, p) => groups[g]?.includes(p) ?? false,
}
const user = (id: string, role: 'owner' | 'member' = 'member'): AclActor => ({
  kind: 'user',
  id,
  role,
})
const guest: AclActor = { kind: 'guest', id: 'guest:1', role: null }

const res = (over: Partial<ResourceAccess> = {}): ResourceAccess => ({
  kind: 'note',
  ownerId: 'olga',
  groupId: null,
  mode: 0o600,
  entries: [],
  ...over,
})
const run = (actor: AclActor, resource: ResourceAccess, want: number) =>
  check({ actor, resource, want, kinds: CASE_KINDS, membership })
const allow = (subject: string, bits: number): Entry => ({ subject, bits, effect: 'allow' })
const deny = (subject: string, bits: number): Entry => ({ subject, bits, effect: 'deny' })

describe('check', () => {
  test('private by default: only the owner, and the owner can write', () => {
    expect(run(user('olga'), res(), Bits.RW).allowed).toBe(true)
    expect(run(user('mia'), res(), Bits.R).allowed).toBe(false)
  })

  test('the team class applies to members of the group only', () => {
    const r = res({ groupId: 'A', mode: 0o640 })
    expect(run(user('mia'), r, Bits.R).allowed).toBe(true)
    expect(run(user('mia'), r, Bits.W).allowed).toBe(false)
    expect(run(user('ben'), r, Bits.R).allowed).toBe(false)
  })

  test('deny beats the owner, the team, the public bits and every allow', () => {
    const r = res({
      groupId: 'A',
      mode: 0o666,
      entries: [allow('user:mia', Bits.RW), deny('user:mia', Bits.W), deny('@public', Bits.R)],
    })
    expect(run(user('mia'), r, Bits.R).allowed).toBe(false)
    expect(run(user('mia'), r, Bits.W).allowed).toBe(false)
    expect(run(user('olga'), r, Bits.W).allowed).toBe(true) // the deny covers read only
    expect(run(user('olga'), r, Bits.RW).allowed).toBe(false) // the owner is not exempt from a deny
    expect(run(user('olga'), r, Bits.R).allowed).toBe(false)
  })

  test('the instance owner reads through a deny, audited; never writes', () => {
    const r = res({ entries: [deny('user:boss', Bits.R)] })
    const d = run(user('boss', 'owner'), r, Bits.R)
    expect(d).toEqual({ allowed: true, effective: Bits.R, ownerAccess: true })
    expect(run(user('boss', 'owner'), r, Bits.W).allowed).toBe(false)
  })

  test('the root read is not flagged when the rules already allow it', () => {
    const own = res({ ownerId: 'boss' })
    expect(run(user('boss', 'owner'), own, Bits.R).ownerAccess).toBe(false)
    const shared = res({ mode: 0o604 })
    expect(run(user('boss', 'owner'), shared, Bits.R).ownerAccess).toBe(false)
  })

  test('guest ceiling: read on a leaf at most, never write, never @users or a group', () => {
    const open = res({
      mode: 0o666,
      groupId: 'A',
      entries: [allow('@users', Bits.RW), allow('group:A', Bits.RW)],
    })
    expect(run(guest, open, Bits.R).allowed).toBe(true)
    expect(run(guest, open, Bits.W).allowed).toBe(false)
    expect(run(guest, res({ entries: [allow('@users', Bits.R)] }), Bits.R).allowed).toBe(false)
    expect(run(guest, res({ groupId: 'A', mode: 0o640 }), Bits.R).allowed).toBe(false)
    expect(run(guest, res({ entries: [allow('user:guest:1', Bits.R)] }), Bits.R).allowed).toBe(
      false,
    )
    expect(run(guest, res({ entries: [allow('@public', Bits.R)] }), Bits.R).allowed).toBe(true)
  })

  test('a guest is never the owner, even when the stored owner is its id', () => {
    expect(run(guest, res({ ownerId: 'guest:1' }), Bits.R).allowed).toBe(false)
  })

  test('a guest holds no write but may execute a public operation', () => {
    const tool = { ...res({ kind: 'tool', mode: 0o605 }) }
    expect(run(guest, tool, Bits.X).allowed).toBe(true)
    expect(run(guest, tool, Bits.R).allowed).toBe(false) // ceiling of an operation is x
    expect(run(guest, { ...tool, mode: 0o600 }, Bits.X).allowed).toBe(false)
  })

  test('a suspended, left or unknown person is denied everything, root included', () => {
    expect(run(user('ghost'), res({ ownerId: 'ghost', mode: 0o777 }), Bits.R).allowed).toBe(false)
    expect(run(user('ghost', 'owner'), res(), Bits.R).allowed).toBe(false)
  })

  test('group membership is read at check time', () => {
    const r = res({ entries: [allow('group:A', Bits.R)] })
    expect(run(user('mia'), r, Bits.R).allowed).toBe(true)
    groups.A = []
    expect(run(user('mia'), r, Bits.R).allowed).toBe(false)
    groups.A = ['mia']
  })

  test('an unknown kind, an empty want and bits outside the class are denied', () => {
    expect(run(user('olga'), res({ kind: 'mystery' }), Bits.R).allowed).toBe(false)
    expect(run(user('olga'), res(), 0).allowed).toBe(false)
    expect(run(user('olga'), res(), 8).allowed).toBe(false)
    expect(run(user('olga'), res({ mode: 0o700 }), Bits.X).allowed).toBe(false) // x on a leaf means nothing
    expect(run(user('olga'), res({ kind: 'tool', mode: 0o700 }), Bits.W).allowed).toBe(false)
  })

  describe('bits by class', () => {
    test('container: r lists, w creates, x opens a child', () => {
      const book = res({ kind: 'notebook', mode: 0o750, groupId: 'A' })
      expect(run(user('olga'), book, Bits.ALL).allowed).toBe(true)
      expect(run(user('mia'), book, Bits.R | Bits.X).allowed).toBe(true)
      expect(run(user('mia'), book, Bits.W).allowed).toBe(false)
    })
    test('operation: x invokes', () => {
      const tool = res({ kind: 'tool', mode: 0o705 })
      expect(run(user('mia'), tool, Bits.X).allowed).toBe(true)
      expect(run(user('olga'), tool, Bits.RX).allowed).toBe(true)
    })
    test('action: x lets it fire', () => {
      const rem = res({ kind: 'reminder', mode: 0o710 })
      expect(run(user('olga'), rem, Bits.X).allowed).toBe(true)
      expect(
        run(user('mia'), res({ kind: 'reminder', mode: 0o610, groupId: 'A' }), Bits.X).allowed,
      ).toBe(true)
    })
  })

  test('a custom registry changes the class of a kind', () => {
    const kinds = defineKinds({ note: { class: 'container' } })
    const d = check({
      actor: user('olga'),
      resource: res({ mode: 0o700 }),
      want: Bits.X,
      kinds,
      membership,
    })
    expect(d.allowed).toBe(true)
  })
})
