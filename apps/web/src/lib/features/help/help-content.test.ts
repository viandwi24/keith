import { describe, expect, test } from 'bun:test'
import { NAV } from '../shell/nav.ts'
import { COMMANDS, DOC_LINKS, ON_A_PAGE, SCREENS, SHORTCUTS } from './help-content.ts'

describe('help content', () => {
  test('every screen it names is a built destination of the app', () => {
    const paths = new Set(NAV.map((i) => i.path))
    for (const s of SCREENS) expect(paths.has(s.path)).toBe(true)
  })
  test('the commands are the composer commands', () => {
    expect(COMMANDS.map((c) => c.name)).toContain('/new')
    expect(COMMANDS.every((c) => c.hint !== '')).toBe(true)
  })
  test('terminal commands point at pages that exist', () => {
    const paths = new Set([...NAV.map((i) => i.path), '/me/memory'])
    for (const row of ON_A_PAGE) expect(paths.has(row.path)).toBe(true)
  })
  test('shortcuts and links are filled in; links are https', () => {
    expect(SHORTCUTS.some((s) => s.keys.includes('K'))).toBe(true)
    for (const l of DOC_LINKS) expect(l.href.startsWith('https://')).toBe(true)
  })
})
