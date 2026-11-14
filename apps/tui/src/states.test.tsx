import { afterEach, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { render } from '@keith/ui/testing'
import type { UIMessage } from 'ai'
import { App } from './app.tsx'
import { type FakeCore, startFakeCore } from './testing/fake-core.ts'
import { approval } from './testing/fixtures.ts'
import { frameUntil } from './testing/ink.ts'
import { setupApp, stopCores } from './testing/setup-app.tsx'

let started: FakeCore | undefined
afterEach(() => {
  stopCores()
  started?.stop()
  started = undefined
})

/** The App straight on a fake core, without waiting for the chat (the states before it). */
function open(
  rpc: Record<string, (input: unknown) => unknown>,
  {
    revoke = false,
    down = false,
    start = 'chat',
  }: { revoke?: boolean; down?: boolean; start?: 'chat' | 'home' } = {},
) {
  started = startFakeCore({ rpc })
  if (revoke) started.revoke()
  // a port nothing listens on: the core is not there
  const client = createKeithClient({
    baseUrl: down ? 'http://127.0.0.1:1' : started.url,
    token: 't',
  })
  return render(
    <App start={start} client={client} core="unix:/tmp/keith/core.sock" columns={100} rows={30} />,
    {
      columns: 100,
      rows: 30,
    },
  )
}

/** The chat header's title row (`✳ KEITH  idle` and the facts at its right). */
const titleRow = (frame: string): string => frame.split('\n').find((l) => l.includes('KEITH')) ?? ''
/** The legend: the row under the input's bottom rule (a bare line of `─`, trimmed). */
const legendRow = (frame: string): string => {
  const rows = frame.split('\n')
  const rule = rows.map((r, i) => (/^─{20,}/.test(r) ? i : -1)).filter((i) => i >= 0)
  // the sidebar column's separator and frames sit to the right of the legend
  return (rows[(rule.at(-1) ?? -2) + 1] ?? '').replace(/\s*│.*$/, '').trim()
}

describe('the states before the conversation', () => {
  test('connecting: the header says so with the target, the conversation shows the empty state', async () => {
    const { lastFrame, unmount } = open({
      'auth/whoami': async () => {
        await Bun.sleep(600)
        return {
          personId: 'owner',
          name: 'Owner',
          role: 'owner',
          via: 'local',
          credentialKind: null,
        }
      },
    })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('connecting'))
    expect(f).toContain('connecting unix:/tmp/keith/core.sock')
    expect(f).toContain('Talk to keith.')
    expect(f).not.toContain('type a message')
    await frameUntil(lastFrame, (frame) => frame.includes('type a message'))
    unmount()
  })

  test('the core is down: ○ offline and a block naming the target and the command', async () => {
    const { lastFrame, unmount } = open({}, { down: true })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('Cannot reach the core at'))
    expect(f).toContain('offline')
    expect(f).toContain('unix:/tmp/keith/core.sock')
    expect(f).not.toContain('keith-core start')
    expect(f).toContain('╭─ Core down')
    expect(f).not.toContain('/login')
    expect(f).toContain('[ctrl+c] quit')
    expect(f).not.toContain('[enter] send')
    unmount()
  })

  test('a credential refused at start: ○ logged out and the logged-out block that offers the sign in', async () => {
    const { lastFrame, unmount } = open({}, { revoke: true })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('This device is logged out'))
    expect(f).toContain('logged out')
    expect(f).toContain('╭─ Sign in')
    expect(f).toContain('`enter` to sign in.')
    expect(f).toContain('Keith reconnects by itself after the login.')
    expect(f).toContain('[ctrl+c] quit')
    expect(f).not.toContain('type a message')
    unmount()
  })
})

describe('the problem panel', () => {
  test('the chat draws the Sign in panel; Home a two-row caption with the same key', async () => {
    const chat = open({}, { revoke: true })
    const c = await frameUntil(chat.lastFrame, (f) => f.includes('This device is logged out'))
    chat.unmount()
    stopCores()
    started?.stop()
    const home = open({}, { revoke: true, start: 'home' })
    const h = await frameUntil(home.lastFrame, (f) => f.includes('Signed out'))
    home.unmount()
    expect(c).toContain('╭─ Sign in')
    expect(h).not.toContain('╭─ Sign in')
    for (const f of [c, h]) {
      expect(f).toContain('sign in')
      expect(f).toContain('logged out')
    }
  })
})

describe('the header', () => {
  test('it shows only the connection, right-aligned: no core version, model, spend or person', async () => {
    const { lastFrame, unmount } = await setupApp({
      columns: 120,
      budget: { spentUsd: 3.21, limitUsd: 20 },
      rpc: {
        'models/roles/get': () => ({
          front: 'openrouter/anthropic/claude-sonnet-4.5',
          cortex: null,
        }),
      },
    })
    const first = titleRow(await frameUntil(lastFrame, (f) => f.includes('online')))
    // the chat header: `✳ KEITH  <mode>` at the left, the connection word (no colour) at the far end
    expect(first).toMatch(/✳ KEITH {2}idle\s+online/)
    for (const gone of ['core 0.0.0', 'claude-sonnet', '$3.21', 'owner']) {
      expect(first).not.toContain(gone)
    }
    unmount()
  })

  test('the compact status line (70 columns) is `K E I T H` centred and the connection, nothing else', async () => {
    const { lastFrame, unmount } = await setupApp({
      columns: 70,
      budget: { spentUsd: 3.21, limitUsd: 20 },
      rpc: { 'models/roles/get': () => ({ front: 'a/b', cortex: null }) },
    })
    const f = await frameUntil(lastFrame, (x) => x.includes('online'))
    // a blank margin row, then the status line
    expect((f.split('\n')[0] ?? '').trim()).toBe('')
    const first = f.split('\n')[1] ?? ''
    // the whole mark (glyph, name, word without colour) is centred inside the margins
    expect(first).toContain('✳ K E I T H online')
    const mark = Bun.stringWidth('✳ K E I T H online')
    expect(
      Math.abs(first.indexOf('✳') - (2 + Math.floor((70 - 4 - mark) / 2))),
    ).toBeLessThanOrEqual(1)
    expect(first).not.toContain('front b')
    expect(first).not.toContain('$3.21')
    unmount()
  })
})

describe('the footer', () => {
  test('idle chat hints; an approval adds tab approval first; the dialog keys replace them', async () => {
    const idle = await setupApp()
    const f = await frameUntil(idle.lastFrame, (frame) => frame.includes('[enter] send'))
    expect(legendRow(f)).toBe(
      '[enter] send    [ctrl+j] newline    [ctrl+b] sidebar    [esc] home    /help',
    )
    idle.unmount()
    stopCores()
    const waiting = await setupApp({ attention: [approval()] })
    const w = await frameUntil(waiting.lastFrame, (frame) => frame.includes('[tab] approval'))
    expect(legendRow(w)).toMatch(/^\[tab\] approval {2,}\[enter\] send/)
    waiting.stdin.write('\t')
    const focused = await frameUntil(waiting.lastFrame, (frame) => frame.includes('[y] allow'))
    // the dialog lists its keys once: the legend under the input says nothing while it has them
    expect(legendRow(focused)).toBe('')
    expect(focused.split('[y] allow')).toHaveLength(2)
    waiting.unmount()
  })

  test('while the answer runs the footer lists esc stop', async () => {
    const { lastFrame, frames, stdin, unmount } = await setupApp()
    for (const ch of 'hello') stdin.write(ch)
    await frameUntil(lastFrame, (f) => /^\s+hello\s*(│.*)?$/m.test(f))
    stdin.write('\r')
    await frameUntil(lastFrame, (f) => f.includes('● Hello from Keith.'))
    expect(frames.some((f) => f.includes('[esc] stop    [ctrl+g] home    [ctrl+b] sidebar'))).toBe(
      true,
    )
    unmount()
  })
})

describe('height', () => {
  const longHistory = (): UIMessage[] =>
    Array.from({ length: 4 }, (_, i) => ({
      id: `a${i}`,
      role: 'assistant',
      parts: [{ type: 'text', text: `answer ${i}` }],
    })) as UIMessage[]

  test('20 rows keep the margin row under the legend, 19 drop it (and the sidebar stays)', async () => {
    const tall = await setupApp({ rows: 20, history: longHistory() })
    const f20 = await frameUntil(tall.lastFrame, (f) => f.includes('answer 3'))
    expect(f20.split('\n')).toHaveLength(20)
    expect(f20).toContain('[enter] send')
    expect(f20.split('\n').at(-1)?.trim()).toBe('')
    tall.unmount()
    stopCores()
    const short = await setupApp({ rows: 19, history: longHistory() })
    const f19 = await frameUntil(short.lastFrame, (f) => f.includes('answer 3'))
    expect(f19.split('\n')).toHaveLength(19)
    // the sidebar stays (its Brain panel gives way to Tasks when the rows are too few)
    expect(f19).toContain('Tasks')
    // the legend stays and is the last row: the margin row went first
    expect(f19.split('\n').at(-1)).toContain('[enter] send')
    short.unmount()
  })

  test('12 rows keep the sidebar, 11 hide it at any width', async () => {
    const twelve = await setupApp({ rows: 12, columns: 200 })
    // the sidebar frames draw (their bottom corner is on screen); at 11 rows nothing of them is
    expect(await frameUntil(twelve.lastFrame, (f) => f.includes('╰──'))).toBeTruthy()
    twelve.unmount()
    stopCores()
    const eleven = await setupApp({ rows: 11, columns: 200 })
    const f = await frameUntil(eleven.lastFrame, (f2) => f2.includes('type a message'))
    expect(f).not.toContain('╰──')
    expect(f).not.toContain('╭')
    expect(f).not.toContain('nodes 0/0') // wide: no strip either
    expect(f.split('\n')).toHaveLength(11)
    eleven.unmount()
  })
})

describe('width', () => {
  const edgeOf = (frame: string, columns: number): number => {
    const row = frame.split('\n').find((l) => l.includes('Tasks')) ?? ''
    return columns - row.indexOf('╭')
  }

  test.each([
    [100, 32],
    [159, 32],
    [160, 40],
  ])(
    '%i columns: a %i-column sidebar, a 1-column gap, the title row margin at the right',
    async (columns, side) => {
      const { lastFrame, unmount } = await setupApp({ columns, rows: 30 })
      const f = await frameUntil(lastFrame, (frame) => frame.includes('Tasks'))
      expect(edgeOf(f, columns)).toBe(side + 2)
      const header = titleRow(f)
      expect(header.length).toBeLessThanOrEqual(columns)
      // the sidebar frames end where the header's status ends
      const frameRow = f.split('\n').find((l) => l.includes('Tasks')) ?? ''
      expect(frameRow.trimEnd().length).toBe(header.trimEnd().length)
      unmount()
    },
  )

  test('wide terminals: the prose fills the room up to the sidebar (no 100-column cap)', async () => {
    const text = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ')
    const history = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text }] }] as UIMessage[]
    const { lastFrame, unmount } = await setupApp({ columns: 240, rows: 30, history })
    const f = await frameUntil(lastFrame, (frame) => frame.includes('w119'))
    const rows = f.split('\n').filter((r) => /\bw\d+\b/.test(r))
    const widest = Math.max(
      ...rows.map(
        (r) => r.slice(0, r.search(/[│╭╰]/) === -1 ? r.length : r.search(/[│╭╰]/)).trimEnd().length,
      ),
    )
    // gutter 2 + dot 2, then the text runs up to the 40-column sidebar and its 1-column gap
    expect(widest).toBeGreaterThan(104)
    expect(widest).toBeLessThanOrEqual(240 - 40 - 1)
    unmount()
  })
})
