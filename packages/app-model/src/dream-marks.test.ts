import { describe, expect, test } from 'bun:test'
import { type DreamMark, marksWith, withDreamMarks } from './dream-marks.ts'
import type { ChatItem } from './message-text.ts'

const user = (id: string): ChatItem => ({ id, kind: 'user', text: id })

describe('marksWith', () => {
  test('a finished run after the mount gets one mark, after the item last at its end', () => {
    const finishes = [
      { seq: 2, id: 'run-a', text: 'dream finished · 3 reviewed · nothing to change' },
    ]
    const marks = marksWith([], finishes, 1, 'm2')
    expect(marks).toEqual([
      { id: 'run-a', text: 'dream finished · 3 reviewed · nothing to change', after: 'm2' },
    ])
    // the same run again is not a second mark
    expect(marksWith(marks, finishes, 1, 'm9')).toBe(marks)
  })

  test('the dividers finished before the mount are not shown', () => {
    expect(marksWith([], [{ seq: 1, id: 'old', text: 'x' }], 1, undefined)).toEqual([])
  })
})

describe('withDreamMarks', () => {
  test('a divider sits right after the item it follows, in time order', () => {
    const marks: DreamMark[] = [{ id: 'run-a', text: 'dream finished', after: 'm2' }]
    const out = withDreamMarks([user('m1'), user('m2'), user('m3')], marks)
    expect(out.map((i) => i.id)).toEqual(['m1', 'm2', 'dream:run-a', 'm3'])
    expect(out[2]).toEqual({ id: 'dream:run-a', kind: 'divider', text: 'dream finished' })
  })

  test('no mark: the items unchanged; a mark with no item before it leads; a gone item sends it to the end', () => {
    const items = [user('m1')]
    expect(withDreamMarks(items, [])).toEqual(items)
    const top = withDreamMarks(items, [{ id: 'a', text: 'top', after: undefined }])
    expect(top.map((i) => i.id)).toEqual(['dream:a', 'm1'])
    const gone = withDreamMarks(items, [{ id: 'b', text: 'end', after: 'missing' }])
    expect(gone.map((i) => i.id)).toEqual(['m1', 'dream:b'])
  })
})
