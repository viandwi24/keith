import { afterEach, describe, expect, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import type { ChatGeneration } from '@keith/contracts'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { frameUntil, pressUntil } from '../../testing/ink.ts'
import { HistoryScreen } from './history-screen.tsx'

afterEach(cleanup)

const ESC = '\u001b'
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime()

function fakeClient(result: ChatGeneration[] | Error) {
  const generations = { calls: 0 }
  const client = {
    chatContext: {
      generations: async () => {
        generations.calls++
        if (result instanceof Error) throw result
        return result
      },
    },
  } as unknown as KeithClient
  return { client, generations }
}

function mount(client: KeithClient, onClose = () => {}) {
  return render(
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <HistoryScreen
        client={client as never}
        width={80}
        rows={24}
        status={{ connection: 'live' }}
        onClose={onClose}
      />
    </ThemeProvider>,
    { columns: 80, rows: 24 },
  )
}

describe('the /history screen', () => {
  test('a generation a /compact shortened shows compacted N×, in its header line', async () => {
    const { client } = fakeClient([
      { generation: 0, startedAt: at(10, 9), messages: 4, compactions: 2 },
      { generation: 1, startedAt: at(11, 8), messages: 2, compactions: 0 },
    ])
    const app = mount(client)
    const f = await frameUntil(app.lastFrame, (x) => x.includes('Context 1'))
    expect(f).toContain('First context · 4 messages · compacted 2×')
    expect(f).toContain('Context 1 · 2 messages')
    expect(f).not.toContain('Context 1 · 2 messages · compacted')
    app.unmount()
  })

  test('lists the generations newest first, with their start, end and size; read only', async () => {
    const { client, generations } = fakeClient([
      { generation: 0, startedAt: at(10, 9), messages: 4, compactions: 0 },
      { generation: 1, startedAt: at(11, 8), messages: 2, compactions: 0 },
    ])
    const app = mount(client)
    const f = await frameUntil(app.lastFrame, (x) => x.includes('Context 1'))
    expect(generations.calls).toBe(1)
    expect(f).toContain('History')
    expect(f).toContain('[esc] back')
    expect(f.indexOf('Context 1')).toBeLessThan(f.indexOf('First context'))
    expect(f).toContain('ended Nov 11 08:00 by /new')
    expect(f).toContain('running now')
    expect(f).toContain('2 messages')
    expect(f).toContain('Read only')
    app.unmount()
  })

  test('an empty history says so', async () => {
    const { client } = fakeClient([])
    const app = mount(client)
    await frameUntil(app.lastFrame, (x) => x.includes('No earlier conversations yet.'))
    app.unmount()
  })

  test('a failed read shows the reason in words', async () => {
    const { client } = fakeClient(new Error('the core is busy'))
    const app = mount(client)
    await frameUntil(app.lastFrame, (x) => x.includes('the core is busy'))
    app.unmount()
  })

  test('esc closes it and nothing else does', async () => {
    const { client } = fakeClient([
      { generation: 0, startedAt: at(10, 9), messages: 1, compactions: 0 },
    ])
    let closed = 0
    const app = mount(client, () => void closed++)
    await frameUntil(app.lastFrame, (x) => x.includes('First context'))
    app.stdin.write('x')
    await Bun.sleep(30)
    expect(closed).toBe(0)
    await pressUntil(app.stdin, app.lastFrame, ESC, () => closed > 0)
    expect(closed).toBe(1)
    app.unmount()
  })
})
