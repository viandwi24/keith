import { describe, expect, test } from 'bun:test'
import { defineKinds, memoryAcl } from '@keith/acl'
import type { AclWriteAudit, AclWriteCaller } from './access.ts'
import { auditedAcl } from './acl-audited.ts'

const mia: AclWriteCaller = { by: 'mia', via: 'tcp', session: 's1' }

function setup(caller: AclWriteCaller | null = mia) {
  const store = memoryAcl({ kinds: defineKinds({ note: { class: 'leaf' } }) })
  store.activate('mia')
  const created: Array<{ by: AclWriteCaller; resource: unknown }> = []
  const removed: Array<{ by: AclWriteCaller; resource: unknown }> = []
  const audit: AclWriteAudit = {
    created: (by, resource) => created.push({ by, resource }),
    removed: (by, resource) => removed.push({ by, resource }),
  }
  const k = auditedAcl(store, audit, () => caller)
  return { store, k, created, removed }
}

describe('k.acl writes are audited as the caller who made them', () => {
  test('createResource writes one acl.create with the resource fields', () => {
    const { k, created } = setup()
    k.createResource({ kind: 'note', id: 'n1', ownerId: 'mia' })
    expect(created).toEqual([
      {
        by: mia,
        resource: { kind: 'note', id: 'n1', owner: 'mia', mode: expect.any(Number) },
      },
    ])
  })

  test('removeResource writes acl.remove only when something was removed', () => {
    const { k, removed } = setup()
    k.createResource({ kind: 'note', id: 'n1', ownerId: 'mia' })
    expect(k.removeResource('note', 'missing')).toBe(false)
    expect(removed).toHaveLength(0)
    expect(k.removeResource('note', 'n1')).toBe(true)
    expect(removed).toEqual([{ by: mia, resource: { kind: 'note', id: 'n1', owner: 'mia' } }])
  })

  test('an actor that is not a person (a guest) writes nothing, the resource is still made', () => {
    const { k, store, created } = setup(null)
    k.createResource({ kind: 'note', id: 'g1', ownerId: 'mia' })
    expect(created).toHaveLength(0)
    expect(store.getResource('note', 'g1')?.ownerId).toBe('mia')
  })

  test('every other method is the store own, bound to it', () => {
    const { k, store } = setup()
    k.createResource({ kind: 'note', id: 'n1', ownerId: 'mia' })
    expect(k.getResource('note', 'n1')).toEqual(store.getResource('note', 'n1'))
    expect(k.check({ kind: 'user', id: 'mia', role: 'member' }, 'note', 'n1', 4).allowed).toBe(true)
  })

  test('without an audit port the store is returned as it is', () => {
    const store = memoryAcl({ kinds: defineKinds({ note: { class: 'leaf' } }) })
    expect(auditedAcl(store, undefined, () => mia)).toBe(store)
  })
})
