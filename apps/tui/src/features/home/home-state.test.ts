import { describe, expect, test } from 'bun:test'
import { fitLegend } from '@keith/ui'
import { homeLegend, homeSize, ORB_MAX_ROWS } from './home-state.ts'

describe('homeSize', () => {
  test('the brain frame hides below 80 columns, the subtitle below 14 rows', () => {
    expect(homeSize(79, 30).frame).toBe(false)
    expect(homeSize(80, 30).frame).toBe(true)
    expect(homeSize(100, 13).subtitle).toBe(false)
    expect(homeSize(100, 14).subtitle).toBe(true)
  })

  test('the orb takes the rows left and is as wide as it is round', () => {
    const size = homeSize(100, 30, 0.5)
    expect(size.orbHeight).toBe(30 - 5 - 3 - 1)
    expect(size.orbWidth).toBe(size.orbHeight * 2)
    expect(homeSize(100, 14).orbHeight).toBe(14 - 5 - 3 - 1)
    expect(homeSize(100, 13).orbHeight).toBe(13 - 5 - 1)
  })

  test('a narrower cell makes a wider orb in cells, the same square on screen', () => {
    const wide = homeSize(200, 30, 0.5)
    const narrow = homeSize(200, 30, 0.42)
    expect(narrow.orbHeight).toBe(wide.orbHeight)
    expect(narrow.orbWidth).toBeGreaterThan(wide.orbWidth)
    // physical width (cells x aspect) equals physical height (rows), within a cell
    expect(Math.abs(narrow.orbWidth * 0.42 - narrow.orbHeight)).toBeLessThan(0.42)
    expect(Math.abs(wide.orbWidth * 0.5 - wide.orbHeight)).toBeLessThan(0.5)
  })

  test('the caption slot is reserved: two rows and a blank row; a tall screen caps the orb', () => {
    expect(homeSize(100, 30, 0.5).orbHeight).toBe(30 - 5 - 3 - 1)
    expect(homeSize(100, 30, 0.5).captionRows).toBe(2)
    expect(homeSize(100, 13, 0.5).captionRows).toBe(1)
    expect(homeSize(300, 100).orbHeight).toBe(ORB_MAX_ROWS)
    expect(homeSize(60, 20).orbWidth).toBeLessThanOrEqual(60)
  })
})

describe('homeLegend', () => {
  const base = { menuOpen: false, chatEnabled: true, loggedOut: false, busy: false }
  const text = (keys: ReturnType<typeof homeLegend>): string[] =>
    keys.map((k) => `[${k.key}] ${k.label}`)

  test('idle Home has no esc; a running turn adds [esc] stop last', () => {
    expect(text(homeLegend(base))).toEqual(['[space] menu', '[enter] chat'])
    expect(text(homeLegend({ ...base, busy: true }))).toEqual([
      '[space] menu',
      '[enter] chat',
      '[esc] stop',
    ])
  })

  test('logged out keeps [enter] log in; the menu has its own keys', () => {
    expect(text(homeLegend({ ...base, chatEnabled: false, loggedOut: true }))).toContain(
      '[enter] log in',
    )
    expect(text(homeLegend({ ...base, menuOpen: true, busy: true }))).toContain('[esc] close')
  })

  test('narrow: stop stays longest, then chat, the menu goes first; never a cut label', () => {
    const keys = homeLegend({ ...base, busy: true })
    const names = (width: number) => text(fitLegend(keys, width).keys)
    expect(names(80)).toEqual(['[space] menu', '[enter] chat', '[esc] stop'])
    expect(names(26)).toEqual(['[enter] chat', '[esc] stop'])
    expect(names(11)).toEqual(['[esc] stop'])
  })
})

describe('homeLegend offline', () => {
  const base = {
    menuOpen: false,
    chatEnabled: true,
    loggedOut: false,
    busy: false,
    askEnabled: true,
  }
  test('chat and ask are dimmed, the menu key stays (Logout needs no core), r retries', () => {
    const keys = homeLegend({ ...base, offline: true })
    const by = (k: string) => keys.find((x) => x.key === k)
    expect(by('enter')?.dim).toBe(true)
    expect(by('tab')?.dim).toBe(true)
    expect(by('space')?.dim).toBeUndefined()
    expect(by('r')).toMatchObject({ label: 'retry now' })
  })
  test('live: nothing is dimmed and there is no r', () => {
    const keys = homeLegend(base)
    expect(keys.some((k) => k.dim === true || k.key === 'r')).toBe(false)
  })
  test('the open menu offline dims details and open but keeps esc', () => {
    const keys = homeLegend({ ...base, menuOpen: true, offline: true })
    expect(keys.find((k) => k.key === 'esc')?.dim).toBeUndefined()
    expect(keys.find((k) => k.key === '→')?.dim).toBe(true)
  })
})
