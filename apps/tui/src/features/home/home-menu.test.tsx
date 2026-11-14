import { describe, expect, test } from 'bun:test'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { render } from '@keith/ui/testing'
import { stripAnsi } from '../../testing/ansi.ts'
import { HomeMenu, type HomeMenuProps } from './home-menu.tsx'
import type { MenuItem } from './menu-state.ts'

// twelve leaves: far more than a short terminal has rows for
const items: MenuItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `item${i}`,
  title: `Entry ${i}`,
  target: { kind: 'help' },
}))

function menu(over: Partial<HomeMenuProps>) {
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })} spinner={false}>
      <HomeMenu items={items} selected={0} detail={undefined} columns={100} {...over} />
    </ThemeProvider>,
    { columns: 100, rows: 30 },
  )
  return stripAnsi(view.lastFrame() ?? '')
}

/** The entries the frame shows, by their number. */
const shown = (frame: string) =>
  [...frame.matchAll(/Entry (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)

describe('HomeMenu scrolling (A5, tui-design 5.16 Menu)', () => {
  test('control: without a row budget every entry is drawn', () => {
    expect(shown(menu({ selected: 0 }))).toEqual(items.map((_, i) => i))
  })

  test('A5: a menu taller than its rows shows the selection at the top of the window', () => {
    const f = menu({ selected: 0, maxRows: 4 })
    expect(shown(f)).toEqual([0, 1, 2, 3])
    expect(f).toContain('▸')
  })

  test('A5: a selection below the window scrolls it so the selection stays visible', () => {
    const f = menu({ selected: 9, maxRows: 4 })
    expect(shown(f)).toContain(9)
    expect(shown(f)).toHaveLength(4)
    expect(shown(f)).not.toContain(0)
  })

  test('A5: the last entry stays visible at the bottom of the window', () => {
    const f = menu({ selected: 11, maxRows: 4 })
    expect(shown(f)).toEqual([8, 9, 10, 11])
    expect(f).toContain('▸ Entry 11')
  })

  test('A5: a group title takes one of the rows, the selection still shows', () => {
    const f = menu({ selected: 11, maxRows: 5, title: 'Models & budget' })
    expect(f).toContain('Models & budget')
    expect(shown(f)).toContain(11)
    expect(shown(f)).toHaveLength(4)
  })
})
