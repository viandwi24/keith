import { expect, test } from 'bun:test'
import { DARK } from '@keith/ui/tokens'
import { darkTokenStyle } from './dark-tokens.ts'

test('every dark token becomes a custom property of the window body', () => {
  const style = darkTokenStyle()
  for (const [token, { hex }] of Object.entries(DARK))
    expect(style).toContain(`--k-${token}:${hex}`)
  expect(style.endsWith('color-scheme:dark')).toBe(true)
})
