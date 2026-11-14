import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import {
  Box,
  render,
  Static,
  Text,
  Transform,
  useInput,
  usePaste,
  useStderr,
  useStdout,
  useWindowSize,
} from 'ink'
import { useEffect, useState } from 'react'
import { probeTimers } from './timer-probe.ts'
import { VirtualStdin, VirtualStdout } from './virtual-streams.ts'

// The spike of P18 step 2 (docs/specs/plugin-views.md, "Spike findings"): does Ink 8 run on virtual streams?

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Mounted {
  frames: string[]
  writes: string[]
  out: VirtualStdout
  input: VirtualStdin
  unmount(): void
}

/** Mount like the ViewHost will: virtual streams, debug frames, no console patching. */
function mount(element: React.ReactNode, cols = 80, rows = 24): Mounted {
  const out = new VirtualStdout(cols, rows)
  const input = new VirtualStdin()
  const writes: string[] = []
  out.onWrite = (chunk) => writes.push(chunk)
  const instance = render(element, {
    stdout: out as never,
    stdin: input as never,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    get frames() {
      return writes.filter((w) => w !== '' && !PRIVATE_MODE.test(w))
    },
    writes,
    out,
    input,
    unmount: () => {
      instance.unmount()
      out.dispose()
      input.dispose()
    },
  } as Mounted
}

// a private mode toggle Ink writes next to frames (bracketed paste, cursor): never a frame
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const PRIVATE_MODE = /^\u001b\[\?[0-9;]+[hl]$/
// everything a frame may hold: text, newlines and SGR
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ALLOWED = /^(?:[^\u0000-\u001f\u007f-\u009f]|\n|\u001b\[[0-9;]*m)*$/

const level = chalk.level
beforeEach(() => {
  chalk.level = 3
})
afterEach(() => {
  chalk.level = level
})

function Counter() {
  const [n, setN] = useState(0)
  const { columns, rows } = useWindowSize()
  useInput((input, key) => {
    if (key.downArrow) setN((x) => x + 1)
    else if (key.return) setN(100)
    else if (input !== '') setN((x) => x + 10)
  })
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold color="green">
        count {n}
      </Text>
      <Text>
        size {columns}x{rows}
      </Text>
    </Box>
  )
}

describe('Ink 8 on virtual streams', () => {
  test('keys: useInput works with setRawMode and isTTY, and Ink never touches process.stdin', async () => {
    const before = ['readable', 'data', 'keypress'].map((e) => process.stdin.listenerCount(e))
    const rawBefore = process.stdin.isRaw
    const view = mount(<Counter />)
    await wait(30)
    expect(view.input.rawMode).toBe(true)
    view.input.feed('\u001b[B') // down arrow
    await wait(30)
    expect(view.frames.at(-1)).toContain('count 1')
    view.input.feed('x')
    await wait(30)
    expect(view.frames.at(-1)).toContain('count 11')
    view.input.feed('\r')
    await wait(30)
    expect(view.frames.at(-1)).toContain('count 100')
    expect(['readable', 'data', 'keypress'].map((e) => process.stdin.listenerCount(e))).toEqual(
      before,
    )
    expect(process.stdin.isRaw).toBe(rawBefore)
    view.unmount()
    expect(view.input.rawMode).toBe(false)
  })

  test('resize: columns, rows and a resize event re-lay out the tree', async () => {
    const view = mount(<Counter />, 40, 10)
    await wait(30)
    expect(view.frames.at(-1)?.split('\n')[0]).toHaveLength(40)
    expect(view.frames.at(-1)).toContain('size 40x10')
    view.out.resize(60, 12)
    await wait(30)
    expect(view.frames.at(-1)?.split('\n')[0]).toHaveLength(60)
    expect(view.frames.at(-1)).toContain('size 60x12')
    view.out.resize(30, 8)
    await wait(30)
    expect(view.frames.at(-1)?.split('\n')[0]).toHaveLength(30)
    view.unmount()
  })

  test('frames in debug mode are whole, free of cursor and erase sequences, and not throttled by maxFps', async () => {
    function Burst() {
      const [n, setN] = useState(0)
      useEffect(() => {
        const timers = Array.from({ length: 100 }, (_, i) => setTimeout(() => setN(i + 1), i))
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, [])
      return <Text>n={n}</Text>
    }
    const view = mount(<Burst />)
    await wait(250)
    // open verification 3: no throttle, so the ViewHost coalesces to 8 frames per second itself
    expect(view.frames.length).toBeGreaterThan(50)
    expect(view.frames.at(-1)).toBe('n=100')
    for (const frame of view.frames) expect(frame).toMatch(ALLOWED)
    view.unmount()
  })

  test('writes that are not frames: private mode toggles and the empty write on clear and unmount', async () => {
    function Paste() {
      usePaste(() => {})
      return <Text>x</Text>
    }
    const view = mount(<Paste />)
    await wait(30)
    view.unmount()
    const control = view.writes.filter((w) => w === '' || PRIVATE_MODE.test(w))
    expect(control).toContain('\u001b[?2004h') // bracketed paste on
    expect(control).toContain('\u001b[?2004l')
    expect(control).toContain('\u001b[?25h') // show cursor at unmount
    // the host drops these: they are never frames
    // (an identical frame may come twice: the host drops a frame equal to the last one it sent)
    expect([...new Set(view.frames)]).toEqual(['x'])
  })

  test('Ink asks the terminal nothing by default (no kitty query, no device report request)', async () => {
    const view = mount(<Counter />)
    await wait(250) // longer than the 200 ms kitty detection timeout
    for (const write of view.writes) {
      expect(write).not.toContain('\u001b[?u')
      expect(write).not.toContain('\u001b[6n')
      expect(write).not.toContain('\u001b]')
    }
    view.unmount()
  })

  test('golden: typical components produce only text, newlines and SGR', async () => {
    const view = mount(
      <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
        <Text bold>bold </Text>
        <Text dimColor>dim</Text>
        <Text italic underline strikethrough inverse>
          styles
        </Text>
        <Text color="#ff8800" backgroundColor="blue">
          truecolor
        </Text>
        <Text color="redBright">日本語 and emoji 🙂 and é</Text>
        <Text wrap="truncate">{'long '.repeat(40)}</Text>
      </Box>,
      40,
      14,
    )
    await wait(30)
    const frame = view.frames.at(-1) as string
    expect(frame).toMatch(ALLOWED)
    expect(frame).toContain('\u001b[1m') // bold
    expect(frame).toContain('\u001b[2m') // dim
    expect(frame).toContain('\u001b[3m') // italic
    expect(frame).toContain('\u001b[4m') // underline
    expect(frame).toContain('\u001b[7m') // inverse
    expect(frame).toContain('\u001b[9m') // strikethrough
    expect(frame).toContain('\u001b[38;2;255;136;0m') // truecolor
    expect(frame).toContain('\u001b[91m') // bright colours
    expect(frame.split('\n').every((line) => line.length < 400)).toBe(true)
    view.unmount()
  })

  test('without chalk.level a non-TTY daemon renders no colour at all', async () => {
    chalk.level = 0
    const view = mount(<Text color="green">plain</Text>)
    await wait(20)
    expect(view.frames.at(-1)).toBe('plain')
    view.unmount()
  })

  test('<Static> accumulates in every frame: a view must not use it', async () => {
    function Log() {
      const [n, setN] = useState(1)
      useInput(() => setN((x) => x + 1))
      return (
        <>
          <Static items={Array.from({ length: n }, (_, i) => i)}>
            {(i) => <Text key={i}>line {i}</Text>}
          </Static>
          <Text>live</Text>
        </>
      )
    }
    const view = mount(<Log />)
    await wait(20)
    for (let i = 0; i < 3; i++) {
      view.input.feed('a')
      await wait(30)
    }
    expect(view.frames.at(-1)).toBe('line 0\nline 1\nline 2\nline 3\nlive')
    view.unmount()
  })

  test('Ink scrubs the content of <Text> and <Transform>, but useStdout().write and useStderr().write are raw', async () => {
    function Hostile() {
      const { write } = useStdout()
      const stderr = useStderr()
      useEffect(() => {
        write('raw\u001b]52;c;QQ==\u0007done\n')
        stderr.write('err\u001b]0;t\u0007')
      }, [write, stderr])
      return (
        <Transform transform={(line) => `${line}\u001b]0;tt\u0007`}>
          <Text>
            {
              'a\u001b]52;c;QQ==\u0007b\u001b]0;title\u0007c\u001b[6nd\u001bPdcs\u001b\\e\u202eg\u0007h'
            }
          </Text>
        </Transform>
      )
    }
    const out = new VirtualStdout(80, 24)
    const err = new VirtualStdout(80, 24)
    const writes: string[] = []
    const errors: string[] = []
    out.onWrite = (chunk) => writes.push(chunk)
    err.onWrite = (chunk) => errors.push(chunk)
    const instance = render(<Hostile />, {
      stdout: out as never,
      stderr: err as never,
      stdin: new VirtualStdin() as never,
      debug: true,
      interactive: true,
      patchConsole: false,
    })
    await wait(30)
    instance.unmount()
    // Text content: OSC, DCS, non-SGR CSI, BEL and bidi overrides are gone, SGR is kept
    expect(writes).toContain('abcdegh')
    // the hook writes the string as it is, in front of a frame: it reaches the sink raw
    expect(writes.some((w) => w.includes('\u001b]52;c;QQ=='))).toBe(true)
    expect(errors.some((w) => w.includes('\u001b]0;t'))).toBe(true)
    // so @keith/host/tui must not re-export useStdout, useStderr or useStdin, the host gives stderr
    // its own discarded sink, and the client sanitiser is the real defence
  })

  test('size of a frame: 80x24 typical, 200x60 worst case', async () => {
    const line = (c: number) => (
      <Text key={c}>
        {Array.from({ length: 12 }, (_, i) => (
          <Text
            key={i}
            color={`#${(((c * 12 + i) * 40503) % 0xffffff).toString(16).padStart(6, '0')}`}
          >
            {'word '.repeat(2)}
          </Text>
        ))}
      </Text>
    )
    const small = mount(
      <Box flexDirection="column">{Array.from({ length: 24 }, (_, i) => line(i))}</Box>,
      80,
      24,
    )
    await wait(30)
    const smallBytes = new TextEncoder().encode(small.frames.at(-1)).length
    small.unmount()
    // every cell of 200x60 a different truecolor: the largest a frame can get
    const cell = (c: number) => (
      <Text key={c}>
        {Array.from({ length: 200 }, (_, i) => (
          <Text
            key={i}
            color={`#${(((c * 200 + i) * 40503) % 0xffffff).toString(16).padStart(6, '0')}`}
          >
            x
          </Text>
        ))}
      </Text>
    )
    const big = mount(
      <Box flexDirection="column">{Array.from({ length: 60 }, (_, i) => cell(i))}</Box>,
      200,
      60,
    )
    await wait(60)
    const bigBytes = new TextEncoder().encode(big.frames.at(-1)).length
    big.unmount()
    // measured: 80x24 of coloured words about 8 KB; 200x60 with every cell its own truecolor about 225 KB
    expect(smallBytes).toBeGreaterThan(4000)
    expect(bigBytes).toBeGreaterThan(100_000)
    expect(smallBytes).toBeLessThan(16 * 1024)
    expect(bigBytes).toBeLessThan(256 * 1024)
  })

  test('unmount leaves no timer, no stdin or process listener and no pending frame', async () => {
    function Busy() {
      const [n, setN] = useState(0)
      useEffect(() => {
        const interval = setInterval(() => setN((x) => x + 1), 5)
        return () => clearInterval(interval)
      }, [])
      useInput(() => {})
      return <Text>tick {n}</Text>
    }
    const signals = () =>
      ['exit', 'SIGINT', 'SIGTERM', 'beforeExit'].map((e) => process.listenerCount(e))
    const baseline = signals()
    // only the timers this test and Ink create: another file's late timer is not a leak of this teardown
    const probe = probeTimers({ only: /node_modules\/ink\/|spike\.test\.tsx/ })
    try {
      const timersBefore = probe.live()
      const views = Array.from({ length: 5 }, () => mount(<Busy />))
      await wait(40)
      for (const view of views) view.unmount()
      await wait(300) // longer than every Ink timer (pending input flush, kitty detection, throttled render)
      expect(probe.live()).toBe(timersBefore)
      expect(signals()).toEqual(baseline)
      const framesAfter = views.map((v) => v.writes.length)
      await wait(60)
      expect(views.map((v) => v.writes.length)).toEqual(framesAfter)
    } finally {
      probe.stop()
    }
  })
})
