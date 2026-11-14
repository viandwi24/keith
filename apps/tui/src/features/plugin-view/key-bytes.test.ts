import { describe, expect, test } from 'bun:test'
import type { Key } from 'ink'
import { isHome, isLeave, keyBytes } from './key-bytes.ts'

const ESC = '\u001b'
const key = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  eventType: 'press',
  ...over,
})

describe('keyBytes', () => {
  test('arrows, home, end, paging and delete are the xterm sequences', () => {
    expect(keyBytes('', key({ upArrow: true }))).toBe(`${ESC}[A`)
    expect(keyBytes('', key({ downArrow: true }))).toBe(`${ESC}[B`)
    expect(keyBytes('', key({ rightArrow: true }))).toBe(`${ESC}[C`)
    expect(keyBytes('', key({ leftArrow: true }))).toBe(`${ESC}[D`)
    expect(keyBytes('', key({ home: true }))).toBe(`${ESC}[H`)
    expect(keyBytes('', key({ end: true }))).toBe(`${ESC}[F`)
    expect(keyBytes('', key({ pageUp: true }))).toBe(`${ESC}[5~`)
    expect(keyBytes('', key({ pageDown: true }))).toBe(`${ESC}[6~`)
    expect(keyBytes('', key({ delete: true }))).toBe(`${ESC}[3~`)
  })
  test('modifiers go in the parameter: shift 2, alt 3, ctrl 5', () => {
    expect(keyBytes('', key({ upArrow: true, shift: true }))).toBe(`${ESC}[1;2A`)
    expect(keyBytes('', key({ rightArrow: true, meta: true }))).toBe(`${ESC}[1;3C`)
    expect(keyBytes('', key({ leftArrow: true, ctrl: true }))).toBe(`${ESC}[1;5D`)
  })
  test('enter, tab, shift+tab and backspace', () => {
    expect(keyBytes('', key({ return: true }))).toBe('\r')
    expect(keyBytes('', key({ tab: true }))).toBe('\t')
    expect(keyBytes('', key({ tab: true, shift: true }))).toBe(`${ESC}[Z`)
    expect(keyBytes('', key({ backspace: true }))).toBe('\u007f')
  })
  test('printable text goes as it is, alt prefixes an escape, ctrl letters are control codes', () => {
    expect(keyBytes('a', key())).toBe('a')
    expect(keyBytes('héllo ✓', key())).toBe('héllo ✓')
    expect(keyBytes('x', key({ meta: true }))).toBe(`${ESC}x`)
    expect(keyBytes('l', key({ ctrl: true }))).toBe('\u000c')
    expect(keyBytes('A', key({ ctrl: true }))).toBe('\u0001')
  })
  test('the reserved keys and ctrl+c are never sent', () => {
    expect(keyBytes('', key({ escape: true }))).toBeUndefined()
    expect(keyBytes('g', key({ ctrl: true }))).toBeUndefined()
    expect(keyBytes('c', key({ ctrl: true }))).toBeUndefined()
    expect(isLeave(key({ escape: true }))).toBe(true)
    expect(isHome('g', key({ ctrl: true }))).toBe(true)
    expect(isHome('g', key())).toBe(false)
  })
  test('a paste keeps its newlines and tabs but loses every other control and any escape', () => {
    expect(keyBytes(`one\ntwo\tthree`, key())).toBe('one\ntwo\tthree')
    expect(keyBytes(`a${ESC}]52;c;AAAA\u0007b\u009bc`, key())).toBe('a]52;c;AAAAbc')
    expect(keyBytes(`${ESC}\u0007`, key())).toBeUndefined()
    expect(keyBytes('', key())).toBeUndefined()
  })
})
