import { describe, expect, test } from 'bun:test'
import { type ComposerKey, composerAction } from './composer-keys.ts'

const key = (k: string, over: Partial<ComposerKey> = {}): ComposerKey => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...over,
})
const idle = { menu: false, busy: false }

describe('composerAction', () => {
  test('Enter sends, Shift+Enter is a new line, an IME composition is left alone', () => {
    expect(composerAction(key('Enter'), idle)).toBe('send')
    expect(composerAction(key('Enter', { shiftKey: true }), idle)).toBe('newline')
    expect(composerAction(key('Enter', { isComposing: true }), idle)).toBe('none')
  })

  test('Esc closes the menu first, then stops a running turn', () => {
    expect(composerAction(key('Escape'), { menu: true, busy: true })).toBe('close-menu')
    expect(composerAction(key('Escape'), { menu: false, busy: true })).toBe('stop')
    expect(composerAction(key('Escape'), idle)).toBe('none')
  })

  test('the menu takes Tab and the arrows only while it is open', () => {
    const open = { menu: true, busy: false }
    expect(composerAction(key('Tab'), open)).toBe('complete')
    expect(composerAction(key('ArrowUp'), open)).toBe('menu-up')
    expect(composerAction(key('ArrowDown'), open)).toBe('menu-down')
    expect(composerAction(key('Tab'), idle)).toBe('none')
    expect(composerAction(key('ArrowUp'), idle)).toBe('none')
  })
})
