import { describe, expect, test } from 'bun:test'
import { CAPABILITY_IDS } from './capabilities.ts'
import { createCapabilityRegistry } from './capability-registry.ts'

describe('capability registry', () => {
  test('starts with the core ids only', () => {
    const r = createCapabilityRegistry()
    expect(r.ids()).toEqual([...CAPABILITY_IDS])
    expect(r.has('chat')).toBe(true)
    expect(r.has('notes.use')).toBe(false)
    expect(r.has('authenticated')).toBe(false)
  })

  test('registers plugin ids with role defaults; the owner holds all', () => {
    const r = createCapabilityRegistry()
    r.register('notes', [
      { id: 'notes.use', description: 'Use notes', roles: ['member'] },
      { id: 'notes.admin', description: 'Admin notes' },
    ])
    expect(r.has('notes.use')).toBe(true)
    expect(r.ids().slice(-2)).toEqual(['notes.use', 'notes.admin'])
    expect(r.capabilitiesOf('member').has('notes.use')).toBe(true)
    expect(r.capabilitiesOf('member').has('notes.admin')).toBe(false)
    expect(r.capabilitiesOf('owner').has('notes.admin')).toBe(true)
    expect(r.capabilitiesOf('member', ['notes.admin']).has('notes.admin')).toBe(true)
    // an unknown grant is still dropped
    expect(r.capabilitiesOf('member', ['nope']).has('nope')).toBe(false)
  })

  test("refuses a core id, a repeat and another owner's id, all or nothing", () => {
    const r = createCapabilityRegistry()
    r.register('notes', [{ id: 'notes.use', description: 'x' }])
    expect(() => r.register('b', [{ id: 'chat', description: 'x' }])).toThrow('core')
    expect(() => r.register('b', [{ id: 'authenticated', description: 'x' }])).toThrow('core')
    expect(() => r.register('b', [{ id: 'notes.use', description: 'x' }])).toThrow('already')
    expect(() =>
      r.register('b', [
        { id: 'b.one', description: 'x' },
        { id: 'b.one', description: 'x' },
      ]),
    ).toThrow('already')
    expect(r.has('b.one')).toBe(false)
  })

  test('unregister takes back every id of an owner', () => {
    const r = createCapabilityRegistry()
    r.register('notes', [{ id: 'notes.use', description: 'x', roles: ['member'] }])
    r.unregister('notes')
    expect(r.has('notes.use')).toBe(false)
    expect(r.capabilitiesOf('member').has('notes.use')).toBe(false)
  })

  test('without plugins it equals the core role table', () => {
    const r = createCapabilityRegistry()
    expect([...r.capabilitiesOf('member', ['audit.read'])].sort()).toEqual(
      [...r.capabilitiesOf('member', ['audit.read'])].sort(),
    )
    expect(r.capabilitiesOf('owner').size).toBe(CAPABILITY_IDS.length)
  })
})
