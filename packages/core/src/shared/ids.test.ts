import { describe, expect, test } from 'bun:test'
import { isPrefixedId } from '@keith/protocol'
import { createFakeClock } from '@keith/sdk/testing'
import { createIds } from './ids.ts'

describe('createIds', () => {
  test('generates valid prefixed ULIDs', () => {
    const ids = createIds({ clock: createFakeClock(1_700_000_000_000) })
    const id = ids.next('thr')
    expect(isPrefixedId('thr', id)).toBe(true)
    expect(isPrefixedId('per', ids.next('per'))).toBe(true)
  })

  test('encodes the clock time in the first 10 characters', () => {
    const clock = createFakeClock(0)
    const ids = createIds({ clock, randomBytes: (n) => new Uint8Array(n) })
    expect(ids.next('msg')).toBe(`msg_${'0'.repeat(26)}`)
    clock.set(32)
    expect(ids.next('msg')).toBe(`msg_${'0'.repeat(8)}10${'0'.repeat(16)}`)
  })

  test('is monotonic within the same millisecond and when the clock goes back', () => {
    const clock = createFakeClock(5_000)
    const ids = createIds({ clock })
    const made: string[] = []
    for (let i = 0; i < 50; i++) made.push(ids.next('msg'))
    clock.set(4_000)
    for (let i = 0; i < 5; i++) made.push(ids.next('msg'))
    expect([...made].sort()).toEqual(made)
    expect(new Set(made).size).toBe(made.length)
  })

  test('carries into the time part when the random part overflows', () => {
    const clock = createFakeClock(0)
    const ids = createIds({ clock, randomBytes: (n) => new Uint8Array(n).fill(31) })
    const a = ids.next('tsk')
    const b = ids.next('tsk')
    expect(a < b).toBe(true)
    expect(isPrefixedId('tsk', b)).toBe(true)
  })
})
