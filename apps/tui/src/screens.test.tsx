import { afterEach, describe, expect, test } from 'bun:test'
import { node, task } from './testing/fixtures.ts'
import { frameUntil, typeLine } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

afterEach(stopCores)

const now = Date.now()
const rpc = {
  'tasks/list': () => [
    task({ id: 't1', description: 'find disk usage on laptop-e', createdAt: now - 42_000 }),
    task({ id: 't2', agent: 'cortex.news', description: 'morning brief', status: 'waiting' }),
    task({ id: 't3', status: 'done', description: 'compare laptop prices under $800' }),
  ],
  'nodes/list': () => [
    node({ id: 'n1', name: 'laptop-e', os: 'darwin', arch: 'arm64', version: '0.9.0' }),
    node({ id: 'n2', name: 'pi-garage', status: 'offline', allowShell: false, lastSeenAt: 1 }),
  ],
}
const budget = {
  spentUsd: 4,
  limitUsd: 20,
  people: [
    {
      personId: 'o',
      username: 'vian',
      name: 'Vian',
      limitUsd: null,
      spentUsd: 2.5,
      reservedUsd: 0,
      remainingUsd: null,
    },
  ],
}

/** Each framed screen: the command that opens it, what proves it is open, its label tag. */
const SCREENS: ReadonlyArray<[string, string, string]> = [
  ['/help', 'Commands', '╭─ Help ─╮'],
  ['/tasks', 'morning brief', '╭─ Tasks ─╮'],
  ['/nodes', 'pi-garage', '╭─ Nodes ─╮'],
  ['/budget', 'Monthly limit', '╭─ Budget ─╮'],
  ['/brain trace', 'No brain events yet', '╭─ Brain trace ─╮'],
]

describe('the framed screens', () => {
  test.each(
    SCREENS.flatMap(([cmd, proof, tag]) =>
      [60, 80, 100, 120].map((columns) => [cmd, proof, tag, columns] as const),
    ),
  )(
    '%s at %i columns: no row wider than the terminal, one legend without …',
    async (cmd, proof, tag, columns) => {
      const rows = 30
      const { lastFrame, stdin, unmount } = await setupApp({ columns, rows, rpc, budget })
      await frameUntil(lastFrame, (f) => f.includes('type a message'))
      await Bun.sleep(150)
      await typeLine(stdin, cmd)
      // the title row is the one place the label can be hidden (60 columns): the content is the proof
      const f = await frameUntil(lastFrame, (x) => x.includes(proof) && x.includes('[esc] back'))
      const lines = f.split('\n')
      expect(Math.max(...lines.map((l) => Bun.stringWidth(l)))).toBeLessThanOrEqual(columns)
      expect(lines.length).toBeLessThanOrEqual(rows)
      expect(f).toContain('K E I T H')
      if (columns >= 80) expect(f).toContain(tag)
      // one legend, never truncated
      const legends = lines.filter((l) => l.includes('[esc] back'))
      expect(legends).toHaveLength(1)
      expect(legends[0]).not.toContain('…')
      expect(f).not.toContain('type a message') // the chat's input is not drawn under a screen
      unmount()
    },
  )

  test('the chat is on the same margins: a blank row at the bottom', async () => {
    const { lastFrame, unmount } = await setupApp({ columns: 100, rows: 30, rpc })
    await frameUntil(lastFrame, (f) => f.includes('type a message'))
    const lines = (lastFrame() ?? '').split('\n')
    expect(lines).toHaveLength(30)
    expect(lines.at(-1)?.trim()).toBe('') // the bottom margin row
    expect(lines.at(-2)).toContain('[enter] send') // the legend, under the input's bottom rule
    unmount()
  })
})
