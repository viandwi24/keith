import { afterEach, expect, test } from 'bun:test'
import { BrainTrace, resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { initialBrain, viewOf } from './features/brain/brain-state.ts'
import { BRAIN_ROWS, Sidebar } from './sidebar.tsx'
import { SIDEBAR_GRAPH_ROWS } from './sidebar-head.tsx'
import { node, task } from './testing/fixtures.ts'

afterEach(cleanup)

const trace = new BrainTrace()

async function draw(columns: number, rows: number, width: 32 | 40, withOrb = true) {
  // the column's height as the app gives it: the terminal rows less the margin, the input band and the top blank row
  const height = rows - 1 - 7
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <Sidebar
        width={width}
        height={height}
        view={viewOf(initialBrain, 0)}
        brain={initialBrain}
        waiting={0}
        tasks={[task()]}
        nodes={[node(), node({ id: 'n2', name: 'pi-garage', status: 'offline' })]}
        showBrain
        showTasks
        {...(withOrb ? { orb: { mode: 'idle', trace, cellAspect: 0.46, running: false } } : {})}
      />
    </ThemeProvider>,
    { columns, rows },
  )
  await Bun.sleep(40)
  return { lines: (view.lastFrame() ?? '').split('\n'), height }
}

test.each([
  [100, 40, 32, 8],
  [120, 44, 32, 12],
  [120, 60, 32, 14],
  [160, 50, 40, 18],
  [190, 45, 40, 13],
] as const)(
  'at %ix%i the column (%i wide) reads orb (%i rows), wave graph, Brain, Tasks, Nodes',
  async (columns, rows, width, orbRows) => {
    const { lines, height } = await draw(columns, rows, width)
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle))
    // the orb has no colour here: a static dot and the mode word, centred in its rows
    const orb = at('● idle')
    expect(orb).toBeGreaterThanOrEqual(0)
    expect(orb).toBeLessThan(orbRows)
    // centred in its rows
    expect(orb).toBe(Math.floor((orbRows - 1) / 2))
    // frames: wave graph (tagged with the mode), Brain, Tasks, Nodes, in this order
    const graph = lines.findIndex((l, i) => i >= orbRows && l.includes('╭─ idle'))
    expect(graph).toBe(orbRows)
    expect(at('Brain')).toBe(orbRows + SIDEBAR_GRAPH_ROWS)
    expect(at('Tasks')).toBe(orbRows + SIDEBAR_GRAPH_ROWS + BRAIN_ROWS)
    expect(at('Nodes')).toBeGreaterThan(at('Tasks'))
    expect(at('no activity yet')).toBeGreaterThan(graph)
    expect(at('laptop-e')).toBeGreaterThan(at('Nodes'))
    // nothing past the column or under the last row
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width)
    expect(lines.filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(height)
    expect(lines.findLastIndex((l) => l.includes('╯'))).toBeLessThan(height)
  },
)

test('the narrow mode (no orb): Brain at the top, nothing of the orb or the graph', async () => {
  const { lines } = await draw(100, 35, 32, false)
  expect(lines[0]).toContain('Brain')
  expect(lines.some((l) => l.includes('● idle'))).toBe(false)
})

test('a column too short for orb, graph, Brain and Tasks draws no orb at all (it stays in the header)', async () => {
  // 8 + 7 + 9 + 4 + 4 = 32 rows are needed: 29 do not fit
  const view = render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <Sidebar
        width={32}
        height={29}
        view={viewOf(initialBrain, 0)}
        brain={initialBrain}
        waiting={0}
        tasks={[]}
        nodes={[]}
        showBrain
        showTasks
        orb={{ mode: 'idle', trace, cellAspect: 0.46, running: false }}
      />
    </ThemeProvider>,
    { columns: 100, rows: 35 },
  )
  await Bun.sleep(40)
  const frame = view.lastFrame() ?? ''
  expect(frame).not.toContain('● idle')
  expect(frame).not.toContain('╭─ idle')
  expect(frame).toContain('Brain')
})
