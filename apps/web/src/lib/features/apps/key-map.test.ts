import { describe, expect, test } from 'bun:test'
import { type KeyEventLike, keyLikeOf, releasesFocus, terminalBytesOf } from './key-map.ts'

const ESC = '\u001b'
const ev = (key: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
})

describe('key events as terminal bytes (the TUI mapping)', () => {
  test('named keys are the xterm sequences', () => {
    expect(terminalBytesOf(ev('ArrowUp'))).toBe(`${ESC}[A`)
    expect(terminalBytesOf(ev('ArrowLeft', { ctrlKey: true }))).toBe(`${ESC}[1;5D`)
    expect(terminalBytesOf(ev('ArrowRight', { shiftKey: true }))).toBe(`${ESC}[1;2C`)
    expect(terminalBytesOf(ev('PageDown'))).toBe(`${ESC}[6~`)
    expect(terminalBytesOf(ev('Delete'))).toBe(`${ESC}[3~`)
    expect(terminalBytesOf(ev('Enter'))).toBe('\r')
    expect(terminalBytesOf(ev('Tab'))).toBe('\t')
    expect(terminalBytesOf(ev('Tab', { shiftKey: true }))).toBe(`${ESC}[Z`)
    expect(terminalBytesOf(ev('Backspace'))).toBe('\u007f')
  })
  test('text, ctrl letters and alt', () => {
    expect(terminalBytesOf(ev('a'))).toBe('a')
    expect(terminalBytesOf(ev('A', { shiftKey: true }))).toBe('A')
    expect(terminalBytesOf(ev('✓'))).toBe('✓')
    expect(terminalBytesOf(ev('l', { ctrlKey: true }))).toBe('\u000c')
    expect(terminalBytesOf(ev('f', { altKey: true }))).toBe(`${ESC}f`)
  })
  test('alt on a Mac types a symbol: the physical key decides', () => {
    expect(terminalBytesOf(ev('ƒ', { altKey: true, code: 'KeyF' }))).toBe(`${ESC}f`)
  })
  test('a character typed with AltGr is plain text', () => {
    expect(terminalBytesOf(ev('@', { ctrlKey: true, altKey: true, altGraph: true }))).toBe('@')
  })
  test('the page keeps what is not a terminal key', () => {
    expect(terminalBytesOf(ev('Shift'))).toBeUndefined()
    expect(terminalBytesOf(ev('F5'))).toBeUndefined()
    expect(terminalBytesOf(ev('c', { metaKey: true }))).toBeUndefined()
    expect(terminalBytesOf(ev('a', { isComposing: true }))).toBeUndefined()
    expect(terminalBytesOf(ev('Escape'))).toBeUndefined()
    // ctrl+c and ctrl+g are reserved (the browser copies; the view never sees them)
    expect(terminalBytesOf(ev('c', { ctrlKey: true }))).toBeUndefined()
    expect(terminalBytesOf(ev('g', { ctrlKey: true }))).toBeUndefined()
  })
  test('esc releases the keyboard', () => {
    expect(releasesFocus(ev('Escape'))).toBe(true)
    expect(releasesFocus(ev('a'))).toBe(false)
  })
  test('the pair keeps alt as meta', () => {
    expect(keyLikeOf(ev('ArrowUp', { altKey: true }))?.key.meta).toBe(true)
  })
})
