import { describe, expect, test } from 'bun:test'
import { parseFrame } from '@keith/client/browser'
import { endText, TIMEOUT_TEXT } from './end-text.ts'
import { INITIAL, isOver, reduceView, type ViewEvent } from './phase.ts'

const run = (...events: ViewEvent[]) => events.reduce(reduceView, INITIAL)
const frame = parseFrame('hello')

describe('view phases', () => {
  test('connecting, slow, then open on ready; the first frame also opens', () => {
    expect(run({ type: 'slow' }).slow).toBe(true)
    const ready = run({ type: 'slow' }, { type: 'status', status: 'open' })
    expect(ready).toMatchObject({ phase: 'open', slow: false })
    expect(run({ type: 'frame', frame })).toMatchObject({ phase: 'open', frame })
  })
  test('an end keeps the last frame under its reason', () => {
    const s = run({ type: 'frame', frame }, { type: 'end', reason: 'idle' })
    expect(s).toMatchObject({ phase: 'ended', reason: 'idle', frame })
    expect(isOver(s)).toBe(true)
    // a late frame of an ended view changes nothing
    expect(reduceView(s, { type: 'frame', frame: parseFrame('late') })).toBe(s)
  })
  test('a timeout only happens while connecting, and its late end changes nothing', () => {
    const t = run({ type: 'timeout' })
    expect(t.phase).toBe('timeout')
    expect(reduceView(t, { type: 'end', reason: 'view' })).toBe(t)
    const open = run({ type: 'status', status: 'open' })
    expect(reduceView(open, { type: 'timeout' })).toBe(open)
  })
  test('reset starts a fresh attempt', () => {
    expect(reduceView(run({ type: 'end', reason: 'error' }), { type: 'reset' })).toEqual(INITIAL)
  })
})

describe('end texts', () => {
  test('a refused or revoked view is not offered again; the rest are', () => {
    expect(endText('refused').reopen).toBe(false)
    expect(endText('revoked').reopen).toBe(false)
    for (const r of [
      'view',
      'idle',
      'limit',
      'error',
      'disconnected',
      'unavailable',
      'protocol',
    ] as const)
      expect(endText(r).reopen).toBe(true)
    expect(endText('view').warning).toBe(false)
    expect(TIMEOUT_TEXT.reopen).toBe(true)
  })
})
