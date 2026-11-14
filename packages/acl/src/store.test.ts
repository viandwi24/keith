import { describe, expect, test } from 'bun:test'
import { Bits } from '@keith/contracts'
import { AclError, type AclErrorCode } from './errors.ts'
import { defineKinds } from './kinds.ts'
import { memoryAcl } from './memory.ts'
import { requireAccess } from './store.ts'
import { CASE_ACTORS, CASE_KINDS } from './testing/index.ts'

const fresh = () => {
  const s = memoryAcl({ kinds: CASE_KINDS })
  for (const p of ['olga', 'mia', 'duta', 'boss']) s.activate(p)
  return s
}
const throwsCode = (fn: () => unknown, code: AclErrorCode) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AclError)
    expect((e as AclError).code).toBe(code)
    return
  }
  throw new Error('did not throw')
}

describe('memory store', () => {
  test('a new resource is private: 0600, no team, no entries', () => {
    const r = fresh().createResource({ kind: 'note', id: 'n1', ownerId: 'olga' })
    expect(r).toMatchObject({ mode: 0o600, groupId: null, entries: [] })
  })

  test('x bits on a leaf are refused in a mode and in an entry', () => {
    const s = fresh()
    throwsCode(
      () => s.createResource({ kind: 'note', id: 'n1', ownerId: 'olga', mode: 0o700 }),
      'INVALID',
    )
    s.createResource({ kind: 'note', id: 'n2', ownerId: 'olga' })
    throwsCode(() => s.setMode('note', 'n2', 0o610), 'INVALID')
    throwsCode(
      () =>
        s.setEntry('note', 'n2', { subject: 'user:duta', bits: Bits.X, effect: 'allow' }, 'olga'),
      'INVALID',
    )
    throwsCode(
      () => s.setEntry('note', 'n2', { subject: 'user:duta', bits: 0, effect: 'allow' }, 'olga'),
      'INVALID',
    )
  })

  test('an unknown kind cannot be created and denies every check', () => {
    const s = fresh()
    throwsCode(() => s.createResource({ kind: 'mystery', id: 'x', ownerId: 'olga' }), 'INVALID')
    expect(s.check(CASE_ACTORS.owner, 'mystery', 'x', Bits.R).allowed).toBe(false)
  })

  test('a kind default may not be wider than 0640', () => {
    expect(() => defineKinds({ note: { class: 'leaf', defaultMode: 0o604 } })).toThrow()
    expect(() => defineKinds({ note: { class: 'leaf', defaultMode: 0o660 } })).toThrow()
    expect(
      defineKinds({ note: { class: 'leaf', defaultMode: 0o640 } }).get('note')?.defaultMode,
    ).toBe(0o640)
  })

  test('setEntry replaces the same subject and effect; at most 64 entries', () => {
    const s = fresh()
    s.createResource({ kind: 'note', id: 'n1', ownerId: 'olga' })
    s.setEntry('note', 'n1', { subject: 'user:duta', bits: 4, effect: 'allow' }, 'olga')
    const r = s.setEntry('note', 'n1', { subject: 'user:duta', bits: 6, effect: 'allow' }, 'olga')
    expect(r?.entries).toEqual([{ subject: 'user:duta', bits: 6, effect: 'allow' }])
    for (let i = 0; i < 63; i++)
      s.setEntry('note', 'n1', { subject: `user:p${i}`, bits: 4, effect: 'allow' }, 'olga')
    throwsCode(
      () => s.setEntry('note', 'n1', { subject: 'user:extra', bits: 4, effect: 'allow' }, 'olga'),
      'INVALID',
    )
  })

  test('a suspended person is denied at the next check, a removed member loses the share at once', () => {
    const s = fresh()
    s.createGroup({ id: 'g1', name: 'friends', createdBy: 'boss' })
    s.addMember('g1', 'mia', 'boss')
    s.createResource({
      kind: 'note',
      id: 'n1',
      ownerId: 'olga',
      entries: [{ subject: 'group:g1', bits: 4, effect: 'allow' }],
    })
    expect(s.check(CASE_ACTORS.a, 'note', 'n1', Bits.R).allowed).toBe(true)
    s.removeMember('g1', 'mia')
    expect(s.check(CASE_ACTORS.a, 'note', 'n1', Bits.R).allowed).toBe(false)
    s.addMember('g1', 'mia', 'boss')
    s.deactivate('mia')
    expect(s.check(CASE_ACTORS.a, 'note', 'n1', Bits.R).allowed).toBe(false)
    expect(s.visibleIds(CASE_ACTORS.a, 'note', Bits.R)).toEqual([])
  })

  test('a group in use is not deleted; an unused one is', () => {
    const s = fresh()
    s.createGroup({ id: 'g1', name: 'friends', createdBy: 'boss' })
    s.createResource({ kind: 'note', id: 'n1', ownerId: 'olga', groupId: 'g1', mode: 0o640 })
    expect(s.groupUsage('g1')).toBe(1)
    throwsCode(() => s.deleteGroup('g1'), 'CONFLICT')
    s.removeResource('note', 'n1')
    expect(s.deleteGroup('g1')).toBe(true)
    s.createGroup({ id: 'g2', name: 'family', createdBy: 'boss' })
    throwsCode(() => s.createGroup({ id: 'g3', name: 'family', createdBy: 'boss' }), 'CONFLICT')
  })

  test('chown and chmod take effect on the next check', () => {
    const s = fresh()
    s.createResource({ kind: 'note', id: 'n1', ownerId: 'olga' })
    s.setOwner('note', 'n1', 'duta')
    expect(s.check(CASE_ACTORS.duta, 'note', 'n1', Bits.RW).allowed).toBe(true)
    expect(s.check(CASE_ACTORS.owner, 'note', 'n1', Bits.R).allowed).toBe(false)
    s.setMode('note', 'n1', 0o604)
    expect(s.check(CASE_ACTORS.guest, 'note', 'n1', Bits.R).allowed).toBe(true)
  })
})

describe('requireAccess: a denied read looks like not found', () => {
  test('missing and denied give the same error, message and code', () => {
    const s = fresh()
    s.createResource({ kind: 'note', id: 'secret', ownerId: 'olga' })
    const grab = (id: string) => {
      try {
        requireAccess(s, CASE_ACTORS.a, 'note', id, Bits.R)
      } catch (e) {
        return e as AclError
      }
      throw new Error('allowed')
    }
    const denied = grab('secret')
    const missing = grab('does-not-exist')
    expect(denied.code).toBe('NOT_FOUND')
    expect(denied.code).toBe(missing.code)
    expect(denied.message).toBe(missing.message)
    expect(denied.message).not.toContain('secret')
  })

  test('only a reader learns that write is missing', () => {
    const s = fresh()
    s.createResource({ kind: 'note', id: 'n1', ownerId: 'olga', mode: 0o604 })
    const code = (actor: typeof CASE_ACTORS.a, want: number) => {
      try {
        requireAccess(s, actor, 'note', 'n1', want)
        return 'ok'
      } catch (e) {
        return (e as AclError).code
      }
    }
    expect(code(CASE_ACTORS.a, Bits.R)).toBe('ok')
    expect(code(CASE_ACTORS.a, Bits.W)).toBe('FORBIDDEN')
    s.setMode('note', 'n1', 0o600)
    expect(code(CASE_ACTORS.a, Bits.W)).toBe('NOT_FOUND')
    expect(code(CASE_ACTORS.owner, Bits.W)).toBe('ok')
  })
})
