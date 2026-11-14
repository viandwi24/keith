import { afterEach, describe, expect, test } from 'bun:test'
import { MotionProvider } from './motion-context.tsx'
import { stripAnsi } from './orb/color.ts'
import { OrbCanvas, type OrbCanvasProps } from './orb-canvas.tsx'
import { cleanup, render } from './testing/render.ts'
import { resolveTheme } from './theme.ts'
import { ThemeProvider } from './theme-context.tsx'

afterEach(cleanup)

const wait = (ms: number) => Bun.sleep(ms)

// one theme object for every render: a new one would rebuild the palette and restart the orb
const TRUECOLOR = resolveTheme({ theme: 'dark', depth: 'truecolor' })

/** An orb under a truecolor theme, with the still flag on or off (the app's `--disable-orb`). */
const orb = (props: Partial<OrbCanvasProps>, orbStatic: boolean) => (
  <ThemeProvider theme={TRUECOLOR}>
    <MotionProvider orbStatic={orbStatic}>
      <OrbCanvas mode="idle" width={40} height={16} {...props} />
    </MotionProvider>
  </ThemeProvider>
)

describe('OrbCanvas with orbStatic (--disable-orb)', () => {
  test('two ticks of a fake clock give identical frames', async () => {
    const view = render(orb({ clock: { tick: 1, dt: 0.1 } }, true), { columns: 80, rows: 30 })
    await wait(40)
    const first = view.lastFrame()
    view.rerender(orb({ clock: { tick: 2, dt: 0.1 } }, true))
    await wait(40)
    view.rerender(orb({ clock: { tick: 9, dt: 0.5 } }, true))
    await wait(40)
    expect(first).toMatch(/[⠁-⣿]/)
    expect(view.lastFrame()).toBe(first)
    cleanup()
  })

  test('its own timer is never started: no frames arrive over time', async () => {
    const view = render(orb({}, true), { columns: 80, rows: 30 })
    await wait(40)
    const n = view.frames.length
    const frame = view.lastFrame()
    await wait(400)
    expect(view.frames.length).toBe(n)
    expect(view.lastFrame()).toBe(frame)
    cleanup()
  })

  test('a colour change (the state) re-renders the frame: same shape, other colour', async () => {
    const view = render(orb({ mode: 'idle' }, true), { columns: 80, rows: 30 })
    await wait(40)
    const idle = view.lastFrame() ?? ''
    view.rerender(orb({ mode: 'alert' }, true))
    await wait(40)
    const alert = view.lastFrame() ?? ''
    expect(alert).not.toBe(idle)
    expect(stripAnsi(alert)).toBe(stripAnsi(idle))
    cleanup()
  })

  test('the still shape is the same in every state; only the colour moves', async () => {
    const shapes = new Set<string>()
    const colours = new Set<string>()
    for (const mode of ['idle', 'listening', 'thinking', 'speaking', 'alert'] as const) {
      const view = render(orb({ mode }, true), { columns: 80, rows: 30 })
      await wait(30)
      const frame = view.lastFrame() ?? ''
      shapes.add(stripAnsi(frame))
      colours.add(frame)
      cleanup()
    }
    expect(shapes.size).toBe(1)
    expect(colours.size).toBe(5)
  })
})

describe('OrbCanvas without orbStatic keeps animating', () => {
  test('two ticks of a clock give different frames', async () => {
    const view = render(orb({ clock: { tick: 1, dt: 0.1 } }, false), { columns: 80, rows: 30 })
    await wait(40)
    const first = view.lastFrame()
    // one step is at most 50 ms of the orb's time: advance ten ticks so the shape moves
    for (let tick = 2; tick <= 11; tick++) view.rerender(orb({ clock: { tick, dt: 0.1 } }, false))
    await wait(40)
    expect(view.lastFrame()).not.toBe(first)
    cleanup()
  })
})
