import { afterEach, describe, expect, test } from 'bun:test'
import { Box } from 'ink'
import { useEffect } from 'react'
import { MotionProvider } from './motion-context.tsx'
import { cleanup, manualScheduler, render } from './testing/index.ts'
import { type ColorDepth, resolveTheme } from './theme.ts'
import { ThemeProvider } from './theme-context.tsx'
import { ToastStack } from './toast.tsx'
import { type ToastOptions, ToastProvider, useToast } from './use-toasts.tsx'

afterEach(cleanup)
const flush = () => new Promise((r) => setTimeout(r, 15))

type Push = (text: string, options?: ToastOptions) => number

function setup(depth: ColorDepth, columns = 60, reduced = false) {
  const sched = manualScheduler()
  let push: Push = () => 0
  const Grab = () => {
    const api = useToast()
    useEffect(() => {
      push = api.push
    }, [api])
    return null
  }
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth })}>
      <MotionProvider scheduler={sched} reduced={reduced}>
        <ToastProvider>
          <Grab />
          <Box height={10} width={columns} />
          <ToastStack columns={columns} />
        </ToastProvider>
      </MotionProvider>
    </ThemeProvider>,
    { columns, rows: 24 },
  )
  return { sched, view, push: (t: string, o?: ToastOptions) => push(t, o) }
}

describe('toasts', () => {
  test('lives 5 s, fades for 300 ms, then is removed; no timer left', async () => {
    const { sched, view, push } = setup('truecolor')
    await flush()
    expect(sched.active()).toBe(0)
    push('hello there')
    await flush()
    sched.advance(150)
    await flush()
    expect(view.lastFrame()).toContain('hello there')
    sched.advance(4700)
    await flush()
    expect(view.lastFrame()).toContain('hello there')
    sched.advance(500)
    await flush()
    expect(view.lastFrame()).not.toContain('hello there')
    expect(sched.active()).toBe(0)
  })

  test('a long text wraps on words, continuation rows under the text, four rows then an ellipsis', async () => {
    const { view, push } = setup('none', 50)
    await flush()
    push(`${'word '.repeat(40)}end`, { level: 'warning' })
    await flush()
    const rows = (view.lastFrame() ?? '').split('\n')
    const first = rows.findIndex((r) => r.includes('! word'))
    expect(first).toBeGreaterThan(-1)
    expect(rows[first + 1]?.trimStart().startsWith('word')).toBe(true)
    expect(rows[first + 3]?.trimEnd().endsWith('…')).toBe(true)
    expect(rows[first + 4]?.includes('word')).toBe(false)
  })

  test('two rows on a terminal under twenty rows', async () => {
    const sched = manualScheduler()
    let push: Push = () => 0
    const Grab = () => {
      const api = useToast()
      useEffect(() => {
        push = api.push
      }, [api])
      return null
    }
    const view = render(
      <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
        <MotionProvider scheduler={sched} reduced={false}>
          <ToastProvider>
            <Grab />
            <Box height={10} width={50} />
            <ToastStack columns={50} rows={12} />
          </ToastProvider>
        </MotionProvider>
      </ThemeProvider>,
      { columns: 50, rows: 12 },
    )
    await flush()
    push(`${'word '.repeat(40)}end`, { level: 'error' })
    await flush()
    const rows = (view.lastFrame() ?? '').split('\n')
    const first = rows.findIndex((r) => r.includes('✕ word'))
    expect(rows[first + 1]?.trimEnd().endsWith('…')).toBe(true)
    expect(rows[first + 2]?.includes('word')).toBe(false)
  })

  test('sits at the top-right, glyph by level, text clipped to the width', async () => {
    const { view, push } = setup('none', 50)
    await flush()
    push('done', { level: 'success' })
    push('x'.repeat(100), { level: 'error' })
    await flush()
    const rows = (view.lastFrame() ?? '').split('\n')
    expect(rows.slice(0, 2).join('')).not.toContain('done')
    expect(rows[2]).toContain('✓ done')
    expect(rows[2]?.trimEnd().length).toBeGreaterThan(40)
    expect(rows[3]).toContain('✕ xxx')
    // 100 characters in rows of 40: three rows, no ellipsis
    expect(rows.slice(3, 6).join('').split('x').length - 1).toBe(100)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(50)
  })

  test('shows at most three: the oldest is dropped', async () => {
    const { view, push } = setup('none')
    await flush()
    for (const t of ['one', 'two', 'three', 'four']) push(t)
    await flush()
    const f = view.lastFrame() ?? ''
    expect(f).not.toContain('one')
    for (const t of ['two', 'three', 'four']) expect(f).toContain(t)
  })

  test('none depth and reduced motion: it appears and disappears at ms, with no fade', async () => {
    for (const s of [setup('none'), setup('truecolor', 60, true)]) {
      await flush()
      s.push('plain', { ms: 1000 })
      await flush()
      expect(s.view.lastFrame()).toContain('plain')
      s.sched.advance(1001)
      await flush()
      expect(s.view.lastFrame()).not.toContain('plain')
      expect(s.sched.active()).toBe(0)
    }
  })

  test('unmounting clears every timer', async () => {
    const { sched, view, push } = setup('truecolor')
    await flush()
    push('a')
    push('b')
    await flush()
    expect(sched.active()).toBeGreaterThan(0)
    view.unmount()
    expect(sched.active()).toBe(0)
  })
})
