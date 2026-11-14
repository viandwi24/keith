import { afterEach, describe, expect, test } from 'bun:test'
import { Text } from 'ink'
import { stripAnsi } from './orb/color.ts'
import { ScreenFrame } from './screen-frame.tsx'
import { cleanup } from './testing/render.ts'
import { show } from './testing/show.tsx'

afterEach(cleanup)

const LEGEND = [
  { key: '↑↓', action: 'select' },
  { key: 'enter', action: 'open' },
  { key: 'esc', action: 'back' },
  { key: '/help', action: '' },
]

const screen = (width: number, rows: number, legend = LEGEND) => (
  <ScreenFrame
    width={width}
    height={rows}
    label="Manage"
    status={{ connection: 'live' }}
    legend={legend}
  >
    <Text>content</Text>
  </ScreenFrame>
)

describe('ScreenFrame', () => {
  test('margins, the title row, the content and one legend with a blank row before and after', async () => {
    const rows = (await show(screen(60, 14), { columns: 60, rows: 14 })).frame().split('\n')
    expect(rows[0]).toBe('')
    expect(rows[1]).toContain('╭─ Manage ─╮')
    expect(rows[1]?.startsWith('  ╭')).toBe(true)
    // no colour: the glyph has no tone to carry the state, so the word is there
    expect(rows[1]).toContain('✳ K E I T H online')
    expect(rows[2]).toBe('')
    expect(rows[3]).toBe('  content')
    // legend on the second-to-last row (the last is the bottom margin), a blank above it
    const legendAt = rows.findIndex((r) => r.includes('[↑↓] select'))
    expect(legendAt).toBe(12)
    expect(rows[legendAt]).toBe('  [↑↓] select    [enter] open    [esc] back    /help')
    expect(rows[legendAt - 1]).toBe('')
    expect(rows[13] ?? '').toBe('')
  })

  test('a legend that does not fit loses its lowest-priority hints, never half a hint, and keeps /help', async () => {
    const f = (await show(screen(40, 12), { columns: 40, rows: 12 })).frame()
    const row = f.split('\n').find((r) => r.includes('[↑↓]')) ?? ''
    expect(row).not.toContain('…')
    expect(row).toContain('/help')
    expect(row.trimEnd().length).toBeLessThanOrEqual(40)
    expect(row).not.toContain('[esc] back')
  })

  test('the label tag gives way on a row too narrow for it and the name', async () => {
    const f = (await show(screen(30, 10), { columns: 30, rows: 10 })).frame()
    expect(f.split('\n')[1]).toContain('K E I T H')
    expect(f.split('\n')[1]).not.toContain('Manage')
  })

  test('without a legend there is no legend row, and the frame has the same look at every depth', async () => {
    for (const depth of ['truecolor', '16', 'none'] as const) {
      const f = (
        await show(
          <ScreenFrame width={40} height={8} label="Tasks">
            <Text>x</Text>
          </ScreenFrame>,
          { depth, columns: 40, rows: 8 },
        )
      ).frame()
      expect(stripAnsi(f).split('\n')[1]).toContain('╭─ Tasks ─╮')
      expect(stripAnsi(f)).not.toContain('[')
    }
  })
})
