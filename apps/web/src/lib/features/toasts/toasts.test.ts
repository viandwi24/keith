import { describe, expect, test } from 'bun:test'
import { TOAST_GLYPH, TOAST_MAX, TOAST_MS, type Toast, withoutToast, withToast } from './toasts.ts'

const toast = (id: number): Toast => ({ id, text: `t${id}`, level: 'info', ms: TOAST_MS })

describe('toast queue', () => {
  test('holds three, newest last; a fourth drops the oldest', () => {
    let list: Toast[] = []
    for (const id of [1, 2, 3, 4]) list = withToast(list, toast(id))
    expect(TOAST_MAX).toBe(3)
    expect(list.map((t) => t.id)).toEqual([2, 3, 4])
  })
  test('dismiss removes one', () => {
    expect(withoutToast([toast(1), toast(2)], 1).map((t) => t.id)).toEqual([2])
  })
  test('uses the TUI default time and level glyphs', () => {
    expect(TOAST_MS).toBe(5000)
    expect(TOAST_GLYPH).toEqual({ info: '·', success: '✓', warning: '!', error: '✕' })
  })
})
