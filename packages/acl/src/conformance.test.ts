import { describe, expect, test } from 'bun:test'
import { Bits } from '@keith/contracts'
import { type MemoryAcl, memoryAcl } from './memory.ts'
import {
  CASE_ACTOR_NAMES,
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  SHARING_CASES,
} from './testing/index.ts'

function world(): MemoryAcl {
  const store = memoryAcl({ kinds: CASE_KINDS })
  for (const p of CASE_PEOPLE) store.activate(p)
  for (const [group, people] of Object.entries(CASE_GROUPS)) {
    store.createGroup({ id: group, name: group.toLowerCase().repeat(2), createdBy: 'boss' })
    for (const p of people) store.addMember(group, p, 'boss')
  }
  return store
}

describe('the six sharing cases, eight actors and the root reader', () => {
  for (const c of SHARING_CASES) {
    test(c.name, () => {
      const store = world()
      store.createResource({
        kind: 'note',
        id: 'n1',
        ownerId: CASE_ACTORS.owner.id,
        mode: c.mode,
        entries: c.entries,
      })
      for (const name of CASE_ACTOR_NAMES) {
        const d = store.check(CASE_ACTORS[name], 'note', 'n1', Bits.R)
        const normal = c.readers.includes(name)
        // the instance owner always reads; it is audited exactly when the rules alone would not allow it
        expect(d.allowed).toBe(normal || name === 'boss')
        expect(d.ownerAccess).toBe(name === 'boss' && !normal)
        // nobody gets write from a read-only share, except the resource owner
        const w = store.check(CASE_ACTORS[name], 'note', 'n1', Bits.W)
        expect(w.allowed).toBe(name === 'owner')
      }
      const visible = (name: (typeof CASE_ACTOR_NAMES)[number]) =>
        store.visibleIds(CASE_ACTORS[name], 'note', Bits.R).length === 1
      for (const name of CASE_ACTOR_NAMES) {
        expect(visible(name)).toBe(c.readers.includes(name) || name === 'boss')
      }
    })
  }

  test('the same cases hold when a deny entry for an unrelated person is added', () => {
    for (const c of SHARING_CASES) {
      const store = world()
      store.createResource({
        kind: 'note',
        id: 'n1',
        ownerId: 'olga',
        mode: c.mode,
        entries: [...c.entries, { subject: 'user:nobody', bits: Bits.R, effect: 'deny' }],
      })
      for (const name of CASE_ACTOR_NAMES) {
        const d = store.check(CASE_ACTORS[name], 'note', 'n1', Bits.R)
        expect(d.allowed).toBe(c.readers.includes(name) || name === 'boss')
      }
    }
  })
})
