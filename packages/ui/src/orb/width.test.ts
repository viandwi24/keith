import { describe, expect, test } from 'bun:test'
import { cells } from '../text-width.ts'
import { advanceShown, retargetShown } from './typewriter.ts'
import { pureCells } from './width.ts'
import { subtitleRowsWith, wordWrapWith } from './wrap.ts'

describe('pureCells', () => {
  test('agrees with the terminal width on the common cases', () => {
    for (const s of ['hello', 'a b c', '日本語', 'café', 'é', 'ok ✓', ''])
      expect(pureCells(s), s).toBe(cells(s))
  })
})

describe('wordWrapWith', () => {
  test('wraps with the width function it is given', () => {
    expect(wordWrapWith('one two three four', 9, pureCells)).toEqual(['one two', 'three', 'four'])
    // a function that counts every character as 2 halves the room
    expect(wordWrapWith('ab cd ef', 4, (t) => t.length * 2)).toEqual(['ab', 'cd', 'ef'])
  })
  test('subtitleRowsWith keeps the newest rows', () => {
    expect(subtitleRowsWith('a b c d e f', 3, pureCells)).toEqual(['c d', 'e f'])
  })
})

describe('typewriter', () => {
  test('a continued text keeps its progress, another restarts', () => {
    expect(retargetShown('hello', 3, 'hello world')).toBe(3)
    expect(retargetShown('hello', 3, 'bye')).toBe(0)
  })
  test('types at least one character and catches up when far behind', () => {
    expect(advanceShown(0, 100, 0)).toBe(1)
    expect(advanceShown(0, 10, 0.05)).toBe(5)
    expect(advanceShown(0, 1000, 0.1)).toBe(27)
    expect(advanceShown(8, 10, 1)).toBe(10)
  })
})
