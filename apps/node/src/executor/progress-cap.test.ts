import { describe, expect, test } from 'bun:test'
import {
  createProgressCap,
  PROGRESS_LINE_CAP,
  PROGRESS_MARKER,
  type ProgressStream,
} from './progress-cap.ts'

function harness(options: { bytesCap?: number; lineCap?: number; chunksPerSecond?: number } = {}) {
  const sent: { chunk: string; stream: ProgressStream }[] = []
  let clock = 0
  const cap = createProgressCap({
    send: (chunk, stream) => sent.push({ chunk, stream }),
    now: () => clock,
    ...options,
  })
  return {
    cap,
    sent,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('progress cap (node-drivers.md, "Progress caps")', () => {
  test('small progress passes through unchanged, stream kept', () => {
    const h = harness()
    h.cap.push('one\n')
    h.cap.push('two', 'stderr')
    expect(h.sent).toEqual([
      { chunk: 'one\n', stream: 'stdout' },
      { chunk: 'two', stream: 'stderr' },
    ])
    expect(h.cap.closed).toBe(false)
  })

  test('a line longer than the line cap keeps its first characters; the next line is intact', () => {
    const h = harness()
    h.cap.push(`${'a'.repeat(PROGRESS_LINE_CAP + 500)}\nnext\n`)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.chunk).toBe(`${'a'.repeat(PROGRESS_LINE_CAP)}\nnext\n`)
    expect(h.cap.closed).toBe(false)
  })

  test('a line that continues across chunks is capped as one line', () => {
    const h = harness({ lineCap: 10 })
    h.cap.push('abcdef')
    h.cap.push('ghijkl')
    h.cap.push('mn\nxy')
    expect(h.sent.map((s) => s.chunk).join('')).toBe('abcdefghij\nxy')
  })

  test('the byte cap sends exactly what fits, then one marker, then nothing', () => {
    const h = harness({ bytesCap: 10, lineCap: 1000 })
    h.cap.push('12345678') // 8 bytes
    h.cap.push('abcdef') // 2 fit, the rest does not
    h.cap.push('late')
    expect(h.sent.map((s) => s.chunk)).toEqual(['12345678', 'ab', `${PROGRESS_MARKER}\n`])
    expect(h.cap.closed).toBe(true)
  })

  test('the byte cap counts UTF-8 bytes and never splits a character', () => {
    const h = harness({ bytesCap: 5, lineCap: 1000 })
    h.cap.push('ééé') // 6 bytes: two characters fit (4 bytes), the third does not
    expect(h.sent.map((s) => s.chunk)).toEqual(['éé', `${PROGRESS_MARKER}\n`])
  })

  test('the default byte cap is 64 KiB: a stream of 1 KiB lines is cut in one marker', () => {
    const h = harness({ chunksPerSecond: 1_000_000 })
    const line = `${'x'.repeat(1023)}\n`
    for (let i = 0; i < 100; i++) h.cap.push(line)
    const total = h.sent.filter((s) => s.chunk !== `${PROGRESS_MARKER}\n`)
    const bytes = total.reduce((n, s) => n + new TextEncoder().encode(s.chunk).length, 0)
    expect(bytes).toBe(64 * 1024)
    expect(h.sent.filter((s) => s.chunk === `${PROGRESS_MARKER}\n`)).toHaveLength(1)
    expect(h.sent.at(-1)?.chunk).toBe(`${PROGRESS_MARKER}\n`)
  })

  test('the rate cap: more chunks than the limit in one second closes the call with one marker', () => {
    const h = harness({ chunksPerSecond: 3 })
    h.cap.push('1')
    h.cap.push('2')
    h.cap.push('3')
    h.cap.push('4', 'stderr')
    h.cap.push('5')
    expect(h.sent).toEqual([
      { chunk: '1', stream: 'stdout' },
      { chunk: '2', stream: 'stdout' },
      { chunk: '3', stream: 'stdout' },
      { chunk: `${PROGRESS_MARKER}\n`, stream: 'stderr' },
    ])
  })

  test('the rate window restarts after a second', () => {
    const h = harness({ chunksPerSecond: 2 })
    h.cap.push('a')
    h.cap.push('b')
    h.tick(1000)
    h.cap.push('c')
    h.cap.push('d')
    expect(h.sent.map((s) => s.chunk)).toEqual(['a', 'b', 'c', 'd'])
    expect(h.cap.closed).toBe(false)
  })

  test('the push never throws and never waits: a closed call ignores everything', () => {
    const h = harness({ bytesCap: 1 })
    h.cap.push('xx')
    const before = h.sent.length
    for (let i = 0; i < 1000; i++) h.cap.push('more')
    expect(h.sent.length).toBe(before)
  })
})
