import { describe, expect, test } from 'bun:test'
import {
  parseClientViewMessage,
  parseServerViewMessage,
  TuiSlotSchema,
  VIEW_LIMITS,
  VIEW_PROTOCOL_VERSION,
  ViewMenuSchema,
} from './plugin-views.ts'

const hello = {
  v: VIEW_PROTOCOL_VERSION,
  type: 'hello',
  viewId: 'notes.list',
  cols: 80,
  rows: 24,
  colorDepth: 24,
}
const parse = (value: unknown) => parseClientViewMessage(JSON.stringify(value))

describe('client messages', () => {
  test('a valid hello, key, resize, close and ping', () => {
    expect(parse(hello).ok).toBe(true)
    expect(parse({ ...hello, params: { id: 'abc' } }).ok).toBe(true)
    expect(parse({ type: 'key', data: '\u001b[A' }).ok).toBe(true)
    expect(parse({ type: 'resize', cols: 100, rows: 30 }).ok).toBe(true)
    expect(parse({ type: 'close' }).ok).toBe(true)
    expect(parse({ type: 'ping' }).ok).toBe(true)
  })

  test('bad hellos', () => {
    for (const bad of [
      { ...hello, v: 2 },
      { ...hello, viewId: 'Notes.List' },
      { ...hello, viewId: 'notes' },
      { ...hello, cols: 5 },
      { ...hello, cols: VIEW_LIMITS.cols.max + 1 },
      { ...hello, rows: 3 },
      { ...hello, rows: 24.5 },
      { ...hello, colorDepth: 16 },
      { ...hello, extra: true },
      { ...hello, params: { a: 1 } },
      { ...hello, params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'x'])) },
    ]) {
      expect(parse(bad).ok).toBe(false)
    }
  })

  test('keys are bounded and never empty', () => {
    expect(parse({ type: 'key', data: '' }).ok).toBe(false)
    expect(parse({ type: 'key', data: 'x'.repeat(VIEW_LIMITS.keyMaxChars) }).ok).toBe(true)
    expect(parse({ type: 'key', data: 'x'.repeat(VIEW_LIMITS.keyMaxChars + 1) }).ok).toBe(false)
    expect(parse({ type: 'key', data: 'a', extra: 1 }).ok).toBe(false)
  })

  test('garbage never throws and never echoes input', () => {
    for (const text of ['', 'nope', '[]', 'null', '{"type":"x"}', '{"type":"key"}', '"hello"']) {
      const result = parseClientViewMessage(text)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.length).toBeLessThan(40)
    }
  })
})

describe('server messages', () => {
  const parseS = (value: unknown) => parseServerViewMessage(JSON.stringify(value))
  test('ready, frame, parts, closed, pong', () => {
    expect(parseS({ v: 1, type: 'ready', cols: 80, rows: 24 }).ok).toBe(true)
    expect(parseS({ type: 'frame', seq: 0, text: 'hi' }).ok).toBe(true)
    expect(parseS({ type: 'frame', seq: 3, text: 'part', more: true }).ok).toBe(true)
    expect(parseS({ type: 'frame', seq: 3, text: 'part', more: false }).ok).toBe(false)
    expect(parseS({ type: 'frame', seq: -1, text: '' }).ok).toBe(false)
    for (const reason of ['view', 'idle', 'revoked', 'limit', 'error', 'refused'])
      expect(parseS({ type: 'closed', reason }).ok).toBe(true)
    expect(parseS({ type: 'closed', reason: 'because' }).ok).toBe(false)
    expect(parseS({ type: 'pong' }).ok).toBe(true)
  })
})

describe('manifest slot and menu', () => {
  const load = () => Promise.resolve({})
  test('the slot', () => {
    expect(TuiSlotSchema.safeParse({}).success).toBe(true)
    const ok = TuiSlotSchema.safeParse({
      menu: [{ id: 'a', label: 'A', view: 'list' }],
      views: { list: load },
    })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.menu?.[0]?.audience).toBe('user')
    expect(TuiSlotSchema.safeParse({ views: { Bad: load } }).success).toBe(false)
    expect(TuiSlotSchema.safeParse({ views: { list: 'x' } }).success).toBe(false)
    const nine = Array.from({ length: 17 }, (_, i) => ({ id: `a${i}`, label: 'A', view: 'list' }))
    expect(TuiSlotSchema.safeParse({ menu: nine }).success).toBe(false)
  })

  test('a menu row', () => {
    expect(
      ViewMenuSchema.safeParse({
        items: [{ id: 'notes.browse', plugin: 'notes', label: 'Notes', viewId: 'notes.list' }],
      }).success,
    ).toBe(true)
  })
})
