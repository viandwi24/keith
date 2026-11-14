import { describe, expect, test } from 'bun:test'
import { type CAPABILITY_IDS, ROLE_CAPABILITIES } from '@keith/contracts'
import { capsOf, clampRow, moveRow, type Nav, navReduce, visibleSections } from './manage-state.ts'
import { SECTIONS } from './sections.ts'

const ids = (role: 'owner' | 'member', grants: (typeof CAPABILITY_IDS)[number][] = []) =>
  visibleSections(SECTIONS, capsOf({ capabilities: [...ROLE_CAPABILITIES[role], ...grants] })).map(
    (s) => s.id,
  )

describe('visibleSections', () => {
  test('the owner sees every section', () => {
    expect(ids('owner')).toEqual([
      'overview',
      'people',
      'groups',
      'plugins',
      'reviews',
      'protocols',
      'devices',
      'nodes',
      'providers',
      'persona',
      'access',
      'succession',
      'budget',
      'privacy',
      'audit',
    ])
  })

  test('a member sees the sections their read capabilities open, never the manage-only ones', () => {
    expect(ids('member')).toEqual([
      'overview',
      'protocols',
      'nodes',
      'providers',
      'budget',
      'privacy',
    ])
  })

  test("Plugins and Reviews are the owner's: a member never sees them, even granted other manage rights", () => {
    expect(ids('member', ['people.manage', 'settings.manage'])).not.toContain('plugins')
    expect(ids('member', ['people.manage', 'settings.manage'])).not.toContain('reviews')
  })

  test('a grant from whoami opens its section for a member', () => {
    expect(ids('member', ['tokens.manage'])).toContain('devices')
  })

  test('a member sees Privacy and never Audit, even with a stale audit.read in the list', () => {
    expect(ids('member')).toContain('privacy')
    expect(ids('member')).not.toContain('audit')
    expect(ids('owner')).toContain('audit')
  })

  test('a section needs one of its capabilities; an empty set keeps only the overview', () => {
    const none = new Set<(typeof CAPABILITY_IDS)[number]>()
    expect(visibleSections(SECTIONS, none).map((s) => s.id)).toEqual(['overview'])
    const tokensOnly = new Set<(typeof CAPABILITY_IDS)[number]>(['tokens.manage'])
    expect(visibleSections(SECTIONS, tokensOnly).map((s) => s.id)).toEqual(['overview', 'devices'])
  })
})

describe('navReduce', () => {
  test('two panes: the list moves with up and down and stops at both ends', () => {
    let nav: Nav = { section: 0, pane: 'nav' }
    nav = navReduce(nav, 'up', 4, true)
    expect(nav.section).toBe(0)
    nav = navReduce(nav, 'down', 4, true)
    nav = navReduce(nav, 'down', 4, true)
    nav = navReduce(nav, 'down', 4, true)
    nav = navReduce(nav, 'down', 4, true)
    expect(nav.section).toBe(3)
  })

  test('two panes: enter or right gives the rows the keys, tab or left takes them back', () => {
    const start = { section: 1, pane: 'nav' as const }
    expect(navReduce(start, 'enter', 4, true).pane).toBe('content')
    expect(navReduce(start, 'right', 4, true).pane).toBe('content')
    const inside = { section: 1, pane: 'content' as const }
    expect(navReduce(inside, 'tab', 4, true).pane).toBe('nav')
    expect(navReduce(inside, 'left', 4, true).pane).toBe('nav')
    expect(navReduce(inside, 'down', 4, true)).toBe(inside)
  })

  test('one pane: tab and right go to the next section, left to the previous, wrapping', () => {
    const at = (section: number) => ({ section, pane: 'content' as const })
    expect(navReduce(at(0), 'tab', 3, false).section).toBe(1)
    expect(navReduce(at(2), 'right', 3, false).section).toBe(0)
    expect(navReduce(at(0), 'left', 3, false).section).toBe(2)
    expect(navReduce(at(1), 'down', 3, false)).toEqual(at(1))
  })
})

describe('rows', () => {
  test('moveRow and clampRow stay inside the list', () => {
    expect(moveRow(0, 'up', 3)).toBe(0)
    expect(moveRow(2, 'down', 3)).toBe(2)
    expect(moveRow(1, 'down', 3)).toBe(2)
    expect(clampRow(5, 3)).toBe(2)
    expect(clampRow(0, 0)).toBe(0)
  })
})
