import { afterEach, describe, expect, mock, test } from 'bun:test'
import { logsFixtures, visibleSections } from '@keith/app-model/manage'
import type { KeithClient } from '@keith/client'
import {
  type LogsSessionsInput,
  type LogsSessionsOutput,
  SESSION_KIND_NAMES,
  type Whoami,
} from '@keith/contracts'
import { resolveTheme, ThemeProvider } from '@keith/ui'
import { cleanup, render } from '@keith/ui/testing'
import { frameUntil, pressUntil } from '../../../testing/ink.ts'
import type { ManageEnv } from '../manage-types.ts'
import { MANAGE_SECTIONS } from '../sections.ts'
import { LogsPane } from './logs-pane.tsx'

const { CALL_DETAIL, CALL_ERR, CALL_OK, RAW, SESSION, SESSION_DETAIL } = logsFixtures

afterEach(cleanup)

const OWNER = new Set(['logs.mine', 'logs.read'])
const MEMBER = new Set(['logs.mine'])
const ESC = '\u001b'
const DOWN = '\u001b[B'
const PGDN = '\u001b[6~'

type Sessions = (input: LogsSessionsInput) => Promise<LogsSessionsOutput>

const ALL: Sessions = async () => ({ sessions: [SESSION], nextCursor: null })

/** A client with the four read procedures; `list` answers `logs.sessions`. */
function fakeClient(list: Sessions = ALL) {
  return {
    logs: {
      sessions: mock(list),
      session: mock(async () => SESSION_DETAIL),
      call: mock(async () => CALL_DETAIL),
      raw: mock(async () => RAW),
    },
  }
}

type FakeClient = ReturnType<typeof fakeClient>

function Harness({
  client,
  caps,
  onClose,
  legend,
}: {
  client: FakeClient
  caps: ReadonlySet<string>
  onClose(): void
  legend: { key: string; action: string }[][]
}) {
  const env: ManageEnv = {
    client: client as unknown as KeithClient,
    guard: ((run: () => Promise<unknown>) => run()) as unknown as ManageEnv['guard'],
    me: {
      role: caps.has('logs.read') ? 'owner' : 'member',
      capabilities: [...caps],
    } as unknown as Whoami,
    caps,
    nodes: {} as ManageEnv['nodes'],
  }
  return (
    <ThemeProvider theme={resolveTheme({ theme: 'dark', depth: 'none' })}>
      <LogsPane
        env={env}
        width={96}
        height={24}
        count="8/9"
        {...(caps.has('logs.read') ? {} : { bottom: 'member' })}
        wide={false}
        focus
        active
        onLegend={(hints) => legend.push([...hints])}
        onNav={() => {}}
        onClose={onClose}
      />
    </ThemeProvider>
  )
}

function mount(client: FakeClient, caps: ReadonlySet<string>) {
  const onClose = mock(() => {})
  const legend: { key: string; action: string }[][] = []
  const app = render(<Harness client={client} caps={caps} onClose={onClose} legend={legend} />, {
    columns: 100,
    rows: 30,
  })
  const current = () => legend.at(-1) ?? []
  return { app, onClose, current }
}

describe('the sessions level', () => {
  test('the table: range, app, shortened id, model, provider, calls and cost', async () => {
    const { app } = mount(fakeClient(), OWNER)
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    expect(frame).toContain('Logs')
    expect(frame).toContain('Front')
    expect(frame).toContain('claude-sonnet-4.5')
    expect(frame).toContain('openrouter')
    expect(frame).toContain('$0.0456')
    expect(frame).toContain('all kinds · mine')
    app.unmount()
  })

  test('an empty list says what makes the first session; a filter with no match names its keys', async () => {
    const empty = mount(
      fakeClient(async () => ({ sessions: [], nextCursor: null })),
      MEMBER,
    )
    const none = await frameUntil(empty.app.lastFrame, (f) => f.includes('No model calls yet'))
    expect(none).toContain('A chat turn writes its first session here.')
    empty.app.unmount()

    const filtered = mount(
      fakeClient(async (input) =>
        input.q === undefined
          ? { sessions: [SESSION], nextCursor: null }
          : { sessions: [], nextCursor: null },
      ),
      MEMBER,
    )
    await frameUntil(filtered.app.lastFrame, (f) => f.includes('front:ana:g0'))
    filtered.app.stdin.write('/')
    await frameUntil(filtered.app.lastFrame, (f) => f.includes('session id prefix'))
    for (const ch of 'zz') filtered.app.stdin.write(ch)
    filtered.app.stdin.write('\r')
    const miss = await frameUntil(filtered.app.lastFrame, (f) => f.includes('No session matches'))
    expect(miss).toContain('/ changes the id filter')
    filtered.app.unmount()
  })

  test('an error says it failed and that r reads it again; the last good rows stay', async () => {
    let fail = false
    const client = fakeClient(async () => {
      if (fail) throw new Error('core busy')
      return { sessions: [], nextCursor: null }
    })
    const { app } = mount(client, MEMBER)
    await frameUntil(app.lastFrame, (f) => f.includes('No model calls yet'))
    fail = true
    await pressUntil(app.stdin, app.lastFrame, 'r', (f) => f.includes('failed to load: core busy'))
    const frame = await frameUntil(app.lastFrame, (f) => f.includes('Press r to try again.'))
    expect(frame).toContain('failed to load: core busy')
    app.unmount()
  })

  test('a session the core no longer has says it is gone and offers no retry (esc goes back)', async () => {
    const client = fakeClient()
    client.logs.session.mockImplementation(async () => {
      throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' })
    })
    const { app } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    const gone = await pressUntil(app.stdin, app.lastFrame, '\r', (f) =>
      f.includes('This session is gone. Press esc to go back.'),
    )
    expect(gone).not.toContain('Press r to try again.')
    app.unmount()
  })

  test('the owner: f cycles the kind, s reads everyone; the filter sends its text as the id prefix', async () => {
    const client = fakeClient()
    const { app, current } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    expect(current().map((h) => h.key)).toContain('s')

    await pressUntil(app.stdin, app.lastFrame, 'f', (f) =>
      f.includes(`${SESSION_KIND_NAMES[0]} · mine`),
    )
    expect(client.logs.sessions.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: SESSION_KIND_NAMES[0],
    })

    await pressUntil(app.stdin, app.lastFrame, 's', (f) => f.includes('everyone'))
    expect(client.logs.sessions.mock.calls.at(-1)?.[0]).toMatchObject({ person: 'everyone' })

    app.stdin.write('/')
    await frameUntil(app.lastFrame, (f) => f.includes('session id prefix'))
    for (const ch of 'front') app.stdin.write(ch)
    app.stdin.write('\r')
    await frameUntil(app.lastFrame, (f) => f.includes('filter front'))
    expect(client.logs.sessions.mock.calls.at(-1)?.[0]).toMatchObject({ q: 'front' })
    app.unmount()
  })

  test('a member has no scope key and s does nothing: every read stays on their own sessions', async () => {
    const client = fakeClient()
    const { app, current } = mount(client, MEMBER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    expect(current().map((h) => h.key)).not.toContain('s')
    app.stdin.write('s')
    await Bun.sleep(60)
    for (const [input] of client.logs.sessions.mock.calls) {
      expect(input).not.toHaveProperty('person')
    }
    app.unmount()
  })

  test('esc on the top level closes the pane', async () => {
    const { app, onClose } = mount(fakeClient(), MEMBER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    await pressUntil(app.stdin, app.lastFrame, ESC, () => onClose.mock.calls.length > 0)
    expect(onClose).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})

describe('drill down and back up', () => {
  test('enter: a session shows its overview and generations; enter on one: the figures; r: the raw JSON; esc steps up', async () => {
    const client = fakeClient()
    const { app, onClose } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))

    const session = await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    expect(session).toContain('claude-sonnet-4.5, gpt-4.1-mini')
    expect(session).toContain('● ok')
    expect(session).toContain('✕ error')
    expect(session).toContain('session front:ana:g0')

    const call = await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('latency'))
    expect(call).toContain('1.84 s · first chunk 410 ms')
    expect(call).toContain('185 tok/s')
    expect(call).toContain('messages sent')
    expect(call).toContain('You are Keith.')
    expect(call).toContain('motor_remote')
    expect(call).not.toContain('Checking the disk now.')
    const response = await pressUntil(app.stdin, app.lastFrame, PGDN, (f) =>
      f.includes('Checking the disk now.'),
    )
    expect(response).toContain('Checking the disk now.')

    const raw = await pressUntil(app.stdin, app.lastFrame, 'r', (f) =>
      f.includes('"model": "claude-sonnet-4.5"'),
    )
    expect(raw).toContain('truncated: the body was cut')
    expect(raw).toContain('"usage"')

    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('latency'))
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('requests'))
    // the sessions level is the only one whose frame names every kind
    await pressUntil(app.stdin, app.lastFrame, ESC, (f) => f.includes('all kinds'))
    expect(onClose).not.toHaveBeenCalled()
    app.unmount()
  })

  test('a generation under a low cache hit is marked ↓ and the legend says low cache hit', async () => {
    const client = fakeClient()
    client.logs.session = mock(async () => ({
      ...SESSION_DETAIL,
      generations: [
        { ...CALL_OK, cacheRead: 900 },
        { ...CALL_ERR, cacheRead: 0 },
      ],
    }))
    const { app } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    const frame = await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    expect(frame).toContain('↓ 0% · 0')
    expect(frame).toContain('75% · 900')
    expect(frame).toContain('low cache hit')
    expect(frame).toContain('cache hit')
    app.unmount()
  })

  test('a session with no generations says so under its overview', async () => {
    const client = fakeClient()
    client.logs.session = mock(async () => ({ ...SESSION_DETAIL, generations: [] }))
    const { app } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    const frame = await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    expect(frame).toContain('No model calls in this session.')
    app.unmount()
  })

  test('the raw JSON scrolls with the arrows and pages with pgdn', async () => {
    const client = fakeClient()
    client.logs.raw = mock(async () => ({
      ...RAW,
      truncated: false,
      request: JSON.stringify(
        Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
      ),
    }))
    const { app } = mount(client, OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('latency'))
    await pressUntil(app.stdin, app.lastFrame, 'r', (f) => f.includes('"k0": 0'))
    app.stdin.write(DOWN)
    await Bun.sleep(40)
    app.stdin.write(PGDN)
    await frameUntil(app.lastFrame, (f) => f.includes('"k35": 35') && !f.includes('"k0": 0'))
    app.unmount()
  })
})

describe('the states and the widths', () => {
  test('every level fits in 100 columns: no row is wider', async () => {
    const { app } = mount(fakeClient(), OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('latency'))
    const frame = await pressUntil(app.stdin, app.lastFrame, 'r', (f) => f.includes('"model"'))
    for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(100)
    app.unmount()
  })

  test('the legend of each level names only its keys (the owner sees scope, the member does not)', async () => {
    const { app, current } = mount(fakeClient(), OWNER)
    await frameUntil(app.lastFrame, (f) => f.includes('front:ana:g0'))
    expect(current().map((h) => h.key)).toEqual(
      expect.arrayContaining(['↑↓', 'enter', '/', 'f', 's', 'r', 'esc']),
    )
    await pressUntil(app.stdin, app.lastFrame, '\r', (f) => f.includes('requests'))
    expect(current().map((h) => h.key)).not.toContain('f')
    expect(current().map((h) => h.key)).toContain('enter')
    app.unmount()
  })
})

describe('the section list', () => {
  test('Logs sits in the list for every role that reads logs.mine, and for no other', () => {
    const member = visibleSections(MANAGE_SECTIONS, MEMBER)
    expect(member.map((s) => s.id)).toContain('logs')
    const owner = visibleSections(MANAGE_SECTIONS, OWNER)
    expect(owner.map((s) => s.id)).toContain('logs')
    const none = visibleSections(MANAGE_SECTIONS, new Set(['chat']))
    expect(none.map((s) => s.id)).not.toContain('logs')
  })

  test('Logs is listed before Privacy and after Budget', () => {
    const ids = MANAGE_SECTIONS.map((s) => s.id)
    expect(ids.indexOf('logs')).toBe(ids.indexOf('budget') + 1)
    expect(ids.indexOf('logs')).toBe(ids.indexOf('privacy') - 1)
  })
})
