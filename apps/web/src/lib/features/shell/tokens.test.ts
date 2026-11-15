import { describe, expect, test } from 'bun:test'
import { DARK, LIGHT } from '@keith/ui/tokens'
import { applyThemeMode, parseThemeMode } from './theme.ts'
import { tokensCss } from './tokens.ts'

describe('tokensCss', () => {
  const css = tokensCss()
  test('dark is the default; light follows the media query and data-theme overrides it', () => {
    expect(css).toContain(`:root{--k-bg:${DARK.bg.hex};`)
    expect(css).toContain('@media (prefers-color-scheme: light){:root:not([data-theme="dark"])')
    expect(css).toContain(`:root[data-theme="light"]{--k-bg:${LIGHT.bg.hex}`)
    expect(css).toContain(`:root[data-theme="dark"]{--k-bg:${DARK.bg.hex}`)
  })
  test('every token is a --k custom property', () => {
    for (const token of Object.keys(DARK)) expect(css).toContain(`--k-${token}:`)
    expect(css).toContain('--k-accent:#8ab4f8')
  })
})

describe('theme mode', () => {
  test('parses unknown values as system', () => {
    expect(parseThemeMode('dark')).toBe('dark')
    expect(parseThemeMode('purple')).toBe('system')
    expect(parseThemeMode(null)).toBe('system')
  })
  test('system removes the override; dark and light set it', () => {
    const attrs = new Map<string, string>()
    const root = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement
    applyThemeMode(root, 'light')
    expect(attrs.get('data-theme')).toBe('light')
    applyThemeMode(root, 'system')
    expect(attrs.has('data-theme')).toBe(false)
  })
})
