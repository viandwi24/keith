import { describe, expect, test } from 'bun:test'
import { PALETTES, resolveTheme, type Token } from './theme.ts'

const TOKENS = Object.keys(PALETTES.dark) as Token[]

const luminance = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('resolveTheme', () => {
  test('truecolor gives the hex values, 256 gives ansi256(n), for both themes', () => {
    const dark = resolveTheme({ theme: 'dark', depth: 'truecolor' })
    expect(dark.color('accent')).toBe('#8ab4f8')
    expect(dark.color('bg')).toBe('#16181d')
    const light = resolveTheme({ theme: 'light', depth: '256' })
    expect(light.color('accent')).toBe('ansi256(26)')
    expect(light.color('border')).toBe('ansi256(252)')
  })

  test('every token has a hex and a 256 value in both palettes', () => {
    for (const palette of Object.values(PALETTES)) {
      for (const token of TOKENS) {
        expect(palette[token].hex).toMatch(/^#[0-9a-f]{6}$/)
        expect(palette[token].ansi).toBeGreaterThanOrEqual(16)
        expect(palette[token].ansi).toBeLessThanOrEqual(255)
      }
    }
  })

  test('16 colours: ANSI names for foregrounds, text and tool unset, `bg` unset', () => {
    const t = resolveTheme({ theme: 'dark', depth: '16' })
    expect(t.color('text-muted')).toBe('gray')
    expect(t.color('accent')).toBe('blue')
    expect(t.color('success')).toBe('green')
    expect(t.color('warning')).toBe('yellow')
    expect(t.color('danger')).toBe('red')
    expect(t.color('info')).toBe('cyan')
    expect(t.color('text')).toBeUndefined()
    expect(t.color('tool')).toBeUndefined()
    expect(t.color('assistant-message')).toBeUndefined()
    expect(t.color('bg')).toBeUndefined()
    expect(t.fg('accent')).toEqual({ color: 'blue' })
  })

  test('bg: only a fill token gives backgroundColor, and only with colour depth', () => {
    expect(resolveTheme({ theme: 'dark', depth: 'truecolor' }).bg('user-message')).toEqual({
      backgroundColor: '#22252c',
    })
    expect(resolveTheme({ theme: 'light', depth: '256' }).bg('user-message')).toEqual({
      backgroundColor: 'ansi256(254)',
    })
    expect(resolveTheme({ theme: 'dark', depth: '16' }).bg('user-message')).toEqual({})
    expect(resolveTheme({ theme: 'dark', depth: 'none' }).bg('user-message')).toEqual({})
  })

  test('none: no colour prop at all, muted is dim', () => {
    const t = resolveTheme({ theme: 'light', depth: 'none' })
    for (const token of TOKENS) {
      expect(t.color(token)).toBeUndefined()
      expect(t.fg(token)).toEqual({})
    }
    expect(t.muted()).toEqual({ dimColor: true })
  })

  test('muted is the muted colour wherever colour exists', () => {
    expect(resolveTheme({ theme: 'dark', depth: 'truecolor' }).muted()).toEqual({
      color: PALETTES.dark['text-muted'].hex,
    })
    expect(resolveTheme({ theme: 'dark', depth: '16' }).muted()).toEqual({ color: 'gray' })
  })
})

describe('contrast (WCAG AA, 4.5)', () => {
  // nothing is painted: every colour is read against the terminal background the palette was tuned for
  for (const name of ['dark', 'light'] as const) {
    test(`${name}: text and muted text read on the background`, () => {
      const p = PALETTES[name]
      expect(contrast(p.text.hex, p.bg.hex)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p['text-muted'].hex, p.bg.hex)).toBeGreaterThanOrEqual(4.5)
    })
    test(`${name}: text, muted text and accent read on the user-message fill`, () => {
      const p = PALETTES[name]
      for (const token of ['text', 'text-muted', 'accent'] as const) {
        expect(contrast(p[token].hex, p['user-message'].hex)).toBeGreaterThanOrEqual(4.5)
      }
    })
    test(`${name}: status colours read on the background`, () => {
      const p = PALETTES[name]
      for (const token of ['accent', 'success', 'warning', 'danger', 'info'] as const) {
        expect(contrast(p[token].hex, p.bg.hex)).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})

describe('orb tokens', () => {
  const ORB: Token[] = [
    'orb-idle',
    'orb-thinking',
    'orb-speaking',
    'region-wernicke',
    'region-hippocampus',
    'region-parietal',
    'region-hypothalamus',
    'region-corpus-callosum',
    'region-prefrontal',
  ]
  test('both palettes define them as hex and 256 values; none depth resolves to nothing', () => {
    for (const palette of Object.values(PALETTES)) {
      for (const token of ORB) expect(palette[token].hex).toMatch(/^#[0-9a-f]{6}$/)
    }
    const t = resolveTheme({ theme: 'light', depth: 'none' })
    for (const token of ORB) expect(t.color(token)).toBeUndefined()
  })
  for (const name of ['dark', 'light'] as const) {
    test(`${name}: orb colours read on the terminal background (3.0)`, () => {
      const p = PALETTES[name]
      for (const token of ORB) expect(contrast(p[token].hex, p.bg.hex)).toBeGreaterThanOrEqual(3)
    })
  }
})
