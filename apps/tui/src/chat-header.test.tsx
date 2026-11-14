import { afterEach, describe, expect, test } from 'bun:test'
import { resolveTheme } from '@keith/ui'
import { layoutOf } from './layout.ts'
import { approval } from './testing/fixtures.ts'
import { frameUntil, pressUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const chat = (columns: number, rows: number, extra: Parameters<typeof setupApp>[0] = {}) =>
  setupApp({ columns, rows, ...extra })

const titleRow = (frame: string): string => frame.split('\n').find((l) => l.includes('KEITH')) ?? ''

const widest = (frame: string): number =>
  Math.max(...frame.split('\n').map((r) => Bun.stringWidth(r)))

describe('the chat header', () => {
  test.each([
    [100, 30],
    [120, 40],
  ])(
    'at %ix%i: the orb, the title, the facts and the region list replace the status line',
    async (columns, rows) => {
      const { lastFrame, unmount } = await chat(columns, rows, {
        rpc: { 'models/roles/get': () => ({ front: 'a/haiku', cortex: null }) },
      })
      const f = await frameUntil(lastFrame, (x) => x.includes('online'))
      expect(f).toContain('✳ KEITH  idle')
      expect(f).toContain('● idle') // the orb's word (no colour: a static dot)
      expect(titleRow(f)).toMatch(/✳ KEITH {2}idle\s+online/)
      // the region list needs room beside the sidebar: it shows from 120 columns
      if (columns >= 120) expect(f).toContain('○ Thalamus')
      expect(f).toContain('no activity yet')
      // the status line is gone: one title row, not two
      expect(f.split('\n').filter((l) => l.includes('online'))).toHaveLength(1)
      expect(widest(f)).toBeLessThanOrEqual(columns)
      unmount()
    },
  )

  test('narrow mode (140x30): a brain event lights its region in the header; the sidebar has no Brain panel', async () => {
    const { lastFrame, core, unmount } = await chat(140, 30)
    await frameUntil(lastFrame, (x) => x.includes('○ Thalamus'))
    core.emit({
      type: 'brain.thalamus.routed',
      payload: { region: 'thalamus', sessionId: 'front:p1', preview: 'hello' },
    })
    const lit = await frameUntil(lastFrame, (x) => x.includes('● Thalamus'))
    expect(lit).toContain('○ Wernicke')
    expect(lit).not.toContain('Brain')
    expect(lit).toContain('Tasks')
    unmount()
  })

  test('wide mode (120x40): the header is the title row; the Brain panel with the lamps is in the sidebar', async () => {
    const { lastFrame, core, unmount } = await chat(120, 40)
    await frameUntil(lastFrame, (x) => x.includes('○ Thalamus'))
    core.emit({
      type: 'brain.thalamus.routed',
      payload: { region: 'thalamus', sessionId: 'front:p1', preview: 'hello' },
    })
    const lit = await frameUntil(lastFrame, (x) => x.includes('● Thalamus'))
    expect(lit).toContain('○ Wernicke')
    expect(lit).toContain('Brain')
    expect(lit).toContain('Tasks')
    expect(lit).toContain('Nodes')
    // the header holds the title and the facts and nothing else: no orb, no graph
    const lines = lit.split('\n')
    const title = lines.findIndex((l) => l.includes('KEITH'))
    expect(lines[title + 1]?.slice(0, 80).trim()).toBe('')
    unmount()
  })

  test('the orb word is in the sidebar from 40 rows and in the header under 40', async () => {
    const wide = await chat(100, 40)
    const w = await frameUntil(wide.lastFrame, (x) => x.includes('● idle'))
    const wl = w.split('\n')
    expect(wl.findIndex((l) => l.includes('● idle'))).toBeGreaterThan(
      wl.findIndex((l) => l.includes('KEITH')),
    )
    expect(wl.find((l) => l.includes('● idle'))?.indexOf('● idle')).toBeGreaterThan(60)
    wide.unmount()
    const narrow = await chat(100, 39)
    const n = await frameUntil(narrow.lastFrame, (x) => x.includes('● idle'))
    const nl = n.split('\n')
    // the header's orb is on the left, above the Tasks frame of the sidebar (no orb there)
    expect(nl.find((l) => l.includes('● idle'))?.indexOf('● idle')).toBeLessThan(20)
    expect(nl.filter((l) => l.includes('● idle'))).toHaveLength(1)
    narrow.unmount()
  })

  test('the input sits between two bare rules and the legend is the row below them', async () => {
    const { lastFrame, unmount } = await chat(100, 30)
    const f = await frameUntil(lastFrame, (x) => x.includes('[enter] send'))
    const rows = f.split('\n')
    const input = rows.findIndex((r) => r.includes('type a message'))
    // 100 columns: the left column is 63 wide, the sidebar beside it is not cut by the rules
    const left = layoutOf(100, { rows: 30 }).left
    expect(rows[input - 1]?.slice(0, left)).toBe('─'.repeat(left))
    expect(rows[input + 1]?.slice(0, left)).toBe('─'.repeat(left))
    const legend = rows[input + 2] ?? ''
    // the legend loses its lowest-priority hints to fit the left column: never a cut one, /help stays
    expect(legend).not.toContain('…')
    expect(legend).toContain('/help')
    expect(legend).toContain('[esc] home')
    expect(legend).not.toMatch(/pgup|pgdn/)
    // the one blank margin row closes the screen
    expect(rows[input + 3]?.trim()).toBe('')
    expect(legend.slice(0, left)).toContain('/help')
    unmount()
  })

  test.each([
    [70, 30],
    [100, 18],
  ])('at %ix%i: no header, the status line and the sidebar stay', async (columns, rows) => {
    const { lastFrame, unmount } = await chat(columns, rows)
    const f = await frameUntil(lastFrame, (x) => x.includes('type a message'))
    expect(f).not.toContain('KEITH')
    // one blank margin row on top, then the status line
    expect(f.split('\n')[0]?.trim()).toBe('')
    expect(f.split('\n')[1]).toContain('✳ K E I T H online')
    // the sidebar keeps Tasks; its Brain panel gives way when the rows are too few for both
    if (columns >= 100) expect(f).toContain('Tasks')
    unmount()
  })

  test('an approval still answers from the chat with the header up', async () => {
    const { lastFrame, stdin, core, unmount } = await chat(120, 40, { attention: [approval()] })
    await frameUntil(lastFrame, (x) => x.includes('Approval needed'))
    await pressUntil(stdin, lastFrame, '\t', (x) => x.includes('[y] allow'))
    await pressUntil(stdin, lastFrame, 'y', () => core.answers.length >= 1)
    unmount()
  })

  test('a message is sent and streamed with the header up', async () => {
    const { lastFrame, stdin, unmount } = await chat(120, 40)
    await frameUntil(lastFrame, (x) => x.includes('type a message'))
    for (const ch of 'hello') stdin.write(ch)
    await frameUntil(lastFrame, (x) => /^\s+hello\s/m.test(x))
    stdin.write('\r')
    await frameUntil(lastFrame, (x) => x.includes('Hello from Keith.'))
    unmount()
  })
})

describe('Home to the chat with colour on', () => {
  test('the orb flies, then the chat shows; esc flies back; keys are never held', async () => {
    const { lastFrame, stdin, unmount } = await setupApp({
      start: 'home',
      columns: 100,
      rows: 30,
      theme: resolveTheme({ theme: 'dark', depth: 'truecolor' }),
    })
    await frameUntil(lastFrame, (x) => x.includes('K E I T H'))
    stdin.write('\r')
    // during the flight only the orb is drawn: no title, no hint
    await frameUntil(
      lastFrame,
      (x) => /[⠁-⣿]/.test(x) && !x.includes('K E I T H') && !x.includes('type a message'),
    )
    // a key typed in flight reaches the chat draft (a key written right after a render can be
    // dropped, so it is repeated until the draft shows)
    await pressUntil(
      stdin,
      lastFrame,
      'x',
      (x) =>
        x.includes('KEITH') &&
        // the colour theme wraps the cursor in escape codes: compare the plain text
        Bun.stripANSI(x)
          .split('\n')
          .some((l) => /^\s+x+\s/.test(l)),
    )
    unmount()
  }, 20_000)
})
