import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  aspectOfReplies,
  DETECT_MAX,
  DETECT_MIN,
  detectCellAspect,
  parseReplies,
  stepAspect,
} from './cell-size.ts'

const ESC = String.fromCharCode(27)

describe('parseReplies', () => {
  test('a cell reply and a window reply', () => {
    expect(parseReplies(`${ESC}[6;20;9t`)).toEqual([{ kind: 'cell', height: 20, width: 9 }])
    expect(parseReplies(`${ESC}[4;800;900t`)).toEqual([{ kind: 'window', height: 800, width: 900 }])
  })

  test('both replies in one read, with noise around them', () => {
    const got = parseReplies(`xx${ESC}[4;800;900t${ESC}[6;20;9tyy`)
    expect(got.map((r) => r.kind)).toEqual(['window', 'cell'])
  })

  test('garbage, a half reply and zeroes give nothing', () => {
    expect(parseReplies('hello')).toEqual([])
    expect(parseReplies(`${ESC}[6;20`)).toEqual([])
    expect(parseReplies(`${ESC}[6;0;9t`)).toEqual([])
    expect(parseReplies('')).toEqual([])
  })
})

describe('aspectOfReplies', () => {
  test('cell width over cell height', () => {
    expect(aspectOfReplies([{ kind: 'cell', height: 20, width: 9 }], 40, 120)).toBe(0.45)
  })

  test('the cell reply wins over the window one', () => {
    const got = aspectOfReplies(
      [
        { kind: 'window', height: 800, width: 1200 },
        { kind: 'cell', height: 20, width: 9 },
      ],
      40,
      120,
    )
    expect(got).toBe(0.45)
  })

  test('the window over rows and columns is the fallback', () => {
    expect(aspectOfReplies([{ kind: 'window', height: 800, width: 1080 }], 40, 120)).toBe(0.45)
  })

  test('absurd answers are clamped to 0.3..0.8', () => {
    expect(aspectOfReplies([{ kind: 'cell', height: 20, width: 1 }], 1, 1)).toBe(DETECT_MIN)
    expect(aspectOfReplies([{ kind: 'cell', height: 10, width: 40 }], 1, 1)).toBe(DETECT_MAX)
  })

  test('nothing to go on', () => {
    expect(aspectOfReplies([], 40, 120)).toBeUndefined()
    expect(aspectOfReplies([{ kind: 'window', height: 800, width: 900 }], 0, 0)).toBeUndefined()
  })
})

describe('stepAspect', () => {
  test('moves by 0.02 and stays in 0.25..0.8', () => {
    expect(stepAspect(0.46, 1)).toBe(0.48)
    expect(stepAspect(0.46, -1)).toBe(0.44)
    expect(stepAspect(0.25, -1)).toBe(0.25)
    expect(stepAspect(0.8, 1)).toBe(0.8)
  })
})

/** A TTY stdin that answers (or not) and remembers its raw mode. */
function fakeStreams(reply: string | undefined, tty = true) {
  const written: string[] = []
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: tty,
    isRaw: false,
    paused: true,
    isPaused() {
      return this.paused
    },
    setRawMode(v: boolean) {
      this.isRaw = v
    },
    resume() {
      this.paused = false
    },
    pause() {
      this.paused = true
    },
  })
  const stdout = {
    isTTY: tty,
    rows: 40,
    columns: 120,
    write(s: string) {
      written.push(s)
      if (reply !== undefined) setTimeout(() => stdin.emit('data', Buffer.from(reply)), 5)
    },
  }
  return { stdin, stdout, written }
}

describe('detectCellAspect', () => {
  test('reads the cell reply, restores raw mode and leaves no listener', async () => {
    const s = fakeStreams(`${ESC}[6;20;9t`)
    const got = await detectCellAspect(s as never, 200)
    expect(got).toBe(0.45)
    expect(s.stdin.isRaw).toBe(false)
    expect(s.stdin.paused).toBe(true)
    expect(s.stdin.listenerCount('data')).toBe(0)
    expect(s.written.join('')).toBe(`${ESC}[16t${ESC}[14t`)
  })

  test('no answer: undefined after the timeout, never longer', async () => {
    const s = fakeStreams(undefined)
    const t = Date.now()
    expect(await detectCellAspect(s as never, 60)).toBeUndefined()
    expect(Date.now() - t).toBeLessThan(400)
    expect(s.stdin.listenerCount('data')).toBe(0)
  })

  test('only a window reply: used after the timeout', async () => {
    const s = fakeStreams(`${ESC}[4;800;1080t`)
    expect(await detectCellAspect(s as never, 60)).toBe(0.45)
  })

  test('not a TTY: nothing is written', async () => {
    const s = fakeStreams(`${ESC}[6;20;9t`, false)
    expect(await detectCellAspect(s as never, 60)).toBeUndefined()
    expect(s.written).toEqual([])
  })
})
