import { describe, expect, test } from 'bun:test'
import type { Person } from '@keith/contracts'
import { personKinds, personRow } from './people-state.ts'

const person = (over: Partial<Person>): Person => ({
  id: 'p1',
  username: 'ana',
  name: 'Ana',
  role: 'member',
  status: 'active',
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  canLogin: true,
  ...over,
})

describe('personRow', () => {
  test('a person with sign-in off says so in the status cell', () => {
    const on = personRow(person({}), [])
    const off = personRow(person({ canLogin: false }), [])
    expect(on.cells[3]).toBe('● active')
    expect(off.cells[3]).toContain('active, no sign-in')
  })
})

describe('personKinds', () => {
  test('an active member can be suspended, removed, replaced and re-roled', () => {
    expect(personKinds(person({}))).toEqual({
      suspend: true,
      reactivate: false,
      remove: true,
      transfer: true,
      role: true,
    })
  })

  test('a suspended member is reactivated, not suspended, and cannot become the owner', () => {
    const k = personKinds(person({ status: 'suspended' }))
    expect(k.suspend).toBe(false)
    expect(k.reactivate).toBe(true)
    expect(k.transfer).toBe(false)
  })

  test('the owner is never suspended, removed or transferred from here', () => {
    expect(personKinds(person({ role: 'owner' }))).toEqual({
      suspend: false,
      reactivate: false,
      remove: false,
      transfer: false,
      role: false,
    })
  })
})

describe('personRow', () => {
  test('cells are username, name, role and status; a person without a username shows the id', () => {
    expect(personRow(person({}), []).cells).toEqual(['ana', 'Ana', 'member', '● active'])
    expect(personRow(person({ username: null }), []).cells[0]).toBe('p1')
  })

  test('a suspended person is drawn in warning', () => {
    expect(personRow(person({ status: 'suspended' }), []).tone).toBe('warning')
    expect(personRow(person({}), []).tone).toBeUndefined()
  })
})
