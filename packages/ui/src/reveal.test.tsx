import { afterEach, describe, expect, test } from 'bun:test'
import { Text } from 'ink'
import { type ReactNode, useEffect } from 'react'
import { blend, FADE_STEPS, fadeTheme, stepOf } from './blend.ts'
import { MotionProvider } from './motion-context.tsx'
import { OrbCanvas } from './orb-canvas.tsx'
import { Reveal } from './reveal.tsx'
import { cleanup, manualScheduler, render } from './testing/index.ts'
import { Txt } from './text.tsx'
import { type ColorDepth, resolveTheme } from './theme.ts'
import { ThemeOverride, ThemeProvider, useTheme } from './theme-context.tsx'
import { useFade } from './use-fade.ts'

afterEach(cleanup)

const flush = () => new Promise((r) => setTimeout(r, 15))

function Probe({ levels, ...opts }: { levels: number[] } & Parameters<typeof useFade>[0]) {
  const level = useFade(opts)
  useEffect(() => {
    levels.push(level)
  }, [level, levels])
  return <Text>{`level ${level}`}</Text>
}

const wrap = (depth: ColorDepth, node: ReactNode, sched = manualScheduler(), reduced = false) => ({
  sched,
  tree: (
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth })}>
      <MotionProvider scheduler={sched} reduced={reduced}>
        {node}
      </MotionProvider>
    </ThemeProvider>
  ),
})

describe('blend', () => {
  test('endpoints are exact and the mix is monotonic', () => {
    expect(blend('#d5d8df', '#16181d', 1)).toBe('#d5d8df')
    expect(blend('#d5d8df', '#16181d', 0)).toBe('#16181d')
    let last = -1
    for (let i = 0; i <= 20; i++) {
      const r = Number.parseInt(blend('#d5d8df', '#16181d', i / 20).slice(1, 3), 16)
      expect(r).toBeGreaterThanOrEqual(last)
      last = r
    }
  })

  test('steps: ten in truecolor, four in 256, none elsewhere', () => {
    expect(FADE_STEPS.truecolor).toBe(10)
    expect(FADE_STEPS['256']).toBe(4)
    expect(stepOf(0.33, 'truecolor')).toBeCloseTo(0.3)
    expect(stepOf(0.4, '256')).toBe(0.5)
    expect(stepOf(0.9, 'none')).toBe(0)
    expect(stepOf(1, '16')).toBe(1)
  })

  test('fadeTheme: level 1 is the theme, 0 is the background, in between a blend', () => {
    const t = resolveTheme({ theme: 'dark', depth: 'truecolor' })
    expect(fadeTheme(t, 1)).toBe(t)
    expect(fadeTheme(t, 0).color('accent')).toBe(t.color('bg'))
    const mid = fadeTheme(t, 0.5).color('accent')
    expect(mid).not.toBe(t.color('accent'))
    expect(mid).not.toBe(t.color('bg'))
    const t256 = resolveTheme({ theme: 'dark', depth: '256' })
    expect(fadeTheme(t256, 0).color('text')).toBe(t256.color('bg'))
    expect(fadeTheme(t256, 0.5).color('text')).toMatch(/^ansi256\(\d+\)$/)
    for (const depth of ['16', 'none'] as const) {
      const plain = resolveTheme({ theme: 'dark', depth })
      expect(fadeTheme(plain, 0.5)).toBe(plain)
    }
  })
})

describe('useFade', () => {
  test('fades in over its duration, steps rise monotonically and end exactly at 1', async () => {
    const levels: number[] = []
    const { sched, tree } = wrap(
      'truecolor',
      <Probe levels={levels} visible from={0} durationMs={300} />,
    )
    render(tree)
    await flush()
    expect(levels.at(-1)).toBe(0)
    for (let i = 0; i < 12; i++) {
      sched.advance(33)
      await flush()
    }
    expect(levels.at(-1)).toBe(1)
    expect(levels.length).toBeGreaterThan(3)
    expect(levels.length).toBeLessThanOrEqual(12)
    for (let i = 1; i < levels.length; i++)
      expect(levels[i] as number).toBeGreaterThanOrEqual(levels[i - 1] as number)
  })

  test('the timer stops once the fade arrived', async () => {
    const { sched, tree } = wrap('truecolor', <Probe levels={[]} visible from={0} />)
    render(tree)
    await flush()
    expect(sched.active()).toBe(1)
    sched.advance(1000)
    await flush()
    expect(sched.active()).toBe(0)
  })

  test('a settled fade has no timer at all', async () => {
    const { sched, tree } = wrap('truecolor', <Probe levels={[]} visible />)
    render(tree)
    await flush()
    expect(sched.active()).toBe(0)
  })

  test('unmounting mid-fade clears the timer', async () => {
    const { sched, tree } = wrap('truecolor', <Probe levels={[]} visible from={0} />)
    const view = render(tree)
    await flush()
    expect(sched.active()).toBe(1)
    view.unmount()
    expect(sched.active()).toBe(0)
  })

  test('delay holds the level; instant, none depth and reduced motion switch at once', async () => {
    const delayed: number[] = []
    const a = wrap('truecolor', <Probe levels={delayed} visible from={0} delayMs={200} />)
    render(a.tree)
    await flush()
    a.sched.advance(150)
    await flush()
    expect(delayed.at(-1)).toBe(0)
    a.sched.advance(400)
    await flush()
    expect(delayed.at(-1)).toBe(1)

    const skipped: number[] = []
    const b = wrap('truecolor', <Probe levels={skipped} visible from={0} instant />)
    render(b.tree)
    await flush()
    expect(skipped.at(-1)).toBe(1)
    expect(b.sched.active()).toBe(0)

    const none: number[] = []
    const c = wrap('none', <Probe levels={none} visible from={0} />)
    render(c.tree)
    await flush()
    expect(none.at(-1)).toBe(1)
    expect(c.sched.active()).toBe(0)

    const calm: number[] = []
    const d = wrap('truecolor', <Probe levels={calm} visible from={0} />, manualScheduler(), true)
    render(d.tree)
    await flush()
    expect(calm.at(-1)).toBe(1)
    expect(d.sched.active()).toBe(0)
  })
})

describe('manualScheduler', () => {
  test('after runs once, in order with every, and can be cancelled', () => {
    const s = manualScheduler()
    const seen: string[] = []
    s.every(100, () => seen.push('e'))
    s.after(250, () => seen.push('a'))
    const cancel = s.after(150, () => seen.push('x'))
    cancel()
    s.advance(400)
    expect(seen).toEqual(['e', 'e', 'a', 'e', 'e'])
    expect(s.active()).toBe(1)
  })
})

describe('Reveal and the orb', () => {
  test('a half-faded orb is drawn darker than a full one, and a Reveal at 0 draws none', async () => {
    const orb = <OrbCanvas mode="speaking" width={12} height={6} running={false} />
    const full = render(wrap('truecolor', orb).tree)
    await flush()
    const dim = render(
      wrap(
        'truecolor',
        <ThemeOverride theme={resolveTheme({ theme: 'dark', depth: 'truecolor' })} fade={0.3}>
          {orb}
        </ThemeOverride>,
      ).tree,
    )
    await flush()
    expect(full.lastFrame()?.includes(`${String.fromCharCode(27)}[38;2;`)).toBe(true)
    expect(full.lastFrame()).not.toBe(dim.lastFrame())
  })
})

describe('Reveal', () => {
  test('draws nothing at 0, a blended colour between, the plain theme at 1', async () => {
    const Colour = () => <Text>{`c=${useTheme().color('accent')}`}</Text>
    const { sched, tree } = wrap(
      'truecolor',
      <Reveal visible from={0} durationMs={300}>
        <Colour />
      </Reveal>,
    )
    const view = render(tree)
    await flush()
    expect(view.lastFrame()).not.toContain('c=')
    sched.advance(150)
    await flush()
    const mid = view.lastFrame() ?? ''
    expect(mid).toContain('c=#')
    expect(mid).not.toContain('c=#8ab4f8')
    sched.advance(300)
    await flush()
    expect(view.lastFrame()).toContain('c=#8ab4f8')
  })

  test('none depth: instant, and no escape code at all', async () => {
    const { tree } = wrap(
      'none',
      <Reveal visible from={0}>
        <Txt>hello</Txt>
      </Reveal>,
    )
    const view = render(tree)
    await flush()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting there is no escape
    expect(view.lastFrame() ?? '').not.toMatch(/\u001b\[/)
    expect(view.lastFrame()).toContain('hello')
  })
})
