import { expect, test } from 'bun:test'
import { VtScreen } from './vt-screen.ts'

const ESC = '\u001b'
const csi = (s: string): string => `${ESC}[${s}`

test('plain text, newlines and the alternate screen', () => {
  const vt = new VtScreen(20, 4)
  vt.feed(`junk${csi('?1049h')}one\ntwo`)
  expect(vt.lines()).toEqual(['one', 'two', '', ''])
})

test('an incremental update: move to a column, erase to the end, write only the change', () => {
  const vt = new VtScreen(20, 3)
  vt.feed('› hello world\nsecond row')
  // the third letter changes: up one row, to column 9, erase, write
  vt.feed(`${csi('1A')}${csi('9G')}${csi('K')}there`)
  expect(vt.lines()).toEqual(['› hello there', 'second row', ''])
})

test('next line (E) goes to column 1; cursor up moves over rows', () => {
  const vt = new VtScreen(20, 4)
  vt.feed('a\nb\nc')
  vt.feed(`${csi('2A')}${csi('2G')}x${csi('E')}y`)
  expect(vt.lines()).toEqual(['ax', 'y', 'c', ''])
})

test('wide glyphs take two cells and colour codes are ignored', () => {
  const vt = new VtScreen(10, 2)
  vt.feed(`${csi('38;2;1;2;3m')}a界b${csi('0m')}`)
  expect(vt.lines()[0]).toBe('a界b')
  vt.feed(`${csi('1G')}${csi('K')}z`)
  expect(vt.lines()[0]).toBe('z')
})

test('a multibyte glyph split between two chunks still lands whole', () => {
  const vt = new VtScreen(10, 2)
  const bytes = new TextEncoder().encode('›x')
  vt.feed(bytes.slice(0, 1))
  vt.feed(bytes.slice(1))
  expect(vt.lines()[0]).toBe('›x')
})

test('erase display clears everything; the last row scrolls instead of overflowing', () => {
  const vt = new VtScreen(10, 2)
  vt.feed('a\nb\nc')
  expect(vt.lines()).toEqual(['b', 'c'])
  vt.feed(csi('2J'))
  expect(vt.lines()).toEqual(['', ''])
})
