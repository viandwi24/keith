import { describe, expect, test } from 'bun:test'
import { ROLE_CAPABILITIES } from '@keith/contracts'
import { canOpen, sectionHref, sectionsFor, splitFact } from './sections.ts'

const owner = { capabilities: [...ROLE_CAPABILITIES.owner] }
const member = { capabilities: [...ROLE_CAPABILITIES.member] }

describe('sectionsFor', () => {
  test('the owner has every section, Logs included, in the list order', () => {
    const ids = sectionsFor(owner).map((s) => s.id)
    expect(ids[0]).toBe('overview')
    expect(ids).toContain('logs')
    expect(ids).toContain('succession')
    expect(ids.indexOf('budget')).toBeLessThan(ids.indexOf('logs'))
  })

  test('a member has no owner-only section', () => {
    const ids = sectionsFor(member).map((s) => s.id)
    for (const id of ['people', 'groups', 'plugins', 'reviews', 'access', 'persona', 'succession'])
      expect(ids).not.toContain(id)
    expect(ids).toContain('overview')
    expect(ids).toContain('privacy')
  })

  test('nobody known, nothing shown', () => {
    expect(sectionsFor(undefined)).toEqual([])
    expect(canOpen(undefined, 'overview')).toBe(false)
  })

  test('canOpen follows the capabilities', () => {
    expect(canOpen(owner, 'people')).toBe(true)
    expect(canOpen(member, 'people')).toBe(false)
  })
})

test('sectionHref sits under the base', () => {
  expect(sectionHref('/app', 'people')).toBe('/app/manage/people')
})

describe('splitFact', () => {
  test('a label column of two or more spaces', () => {
    expect(splitFact('mode      local')).toEqual({ label: 'mode', value: 'local' })
    expect(splitFact('last sign  3 days ago')).toEqual({ label: 'last sign', value: '3 days ago' })
  })
  test('a plain sentence is all value', () => {
    expect(splitFact('Only the owner changes the succession.')).toEqual({
      label: '',
      value: 'Only the owner changes the succession.',
    })
  })
})
