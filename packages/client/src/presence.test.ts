import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient } from './client.ts'
import { fileClientIdStore } from './identifier-memory.ts'
import {
  type ClientIdStore,
  createPresenceReporter,
  TERMINAL_CAPABILITIES,
  UnsupportedDelivery,
} from './presence.ts'

type Call = { path: string; body: Record<string, unknown> | undefined; auth: string | null }
const enc = new TextEncoder()
const ID = '0190a6a0-0000-4000-8000-000000000001'
const OTHER = '0190a6a0-0000-4000-8000-000000000002'

let calls: Call[] = []
let boot = 'b1'
let unauthorizedOnce = false
/** Ids the core refuses on register, with the core's message (a `CONFLICT`). */
let refusals = new Map<string, string>()
let streamRecords: string[] = []
/** How long the core takes to answer a register (the answer comes after the call is recorded). */
let registerDelayMs = 0

const sse = (seq: number, type: string, payload: unknown): string =>
  `id: ${seq}\nevent: activity\ndata: ${JSON.stringify({ seq, type, sessionId: null, agentId: null, payload, createdAt: 1 })}\n\n`

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/activity/stream') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              enc.encode(`event: boot\ndata: {"boot":"${boot}"}\n\n${streamRecords.join('')}`),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname === '/health')
      return Response.json({ status: 'ok', version: '0', sha: 'x', boot })
    const body =
      request.method === 'POST'
        ? ((await request.json()) as { json?: Record<string, unknown> }).json
        : undefined
    calls.push({ path: url.pathname, body, auth: request.headers.get('authorization') })
    if (url.pathname === '/rpc/presence/clients/register' && registerDelayMs > 0)
      await Bun.sleep(registerDelayMs)
    const refused = refusals.get(String(body?.id))
    if (url.pathname === '/rpc/presence/clients/register' && refused !== undefined) {
      return Response.json(
        {
          json: {
            defined: false,
            code: 'CONFLICT',
            status: 409,
            message: refused,
            data: undefined,
          },
          meta: [],
        },
        { status: 409 },
      )
    }
    if (url.pathname.startsWith('/rpc/presence/clients/heartbeat') && unauthorizedOnce) {
      unauthorizedOnce = false
      return Response.json({ json: undefined }, { status: 401 })
    }
    return Response.json({ json: { ok: true } })
  },
})
afterAll(() => server.stop(true))

const memoryStore = (initial?: string): ClientIdStore & { value: string | undefined } => {
  const box = { value: initial } as { value: string | undefined } & ClientIdStore
  return Object.assign(box, {
    read: () => box.value,
    write: (id: string) => {
      box.value = id
    },
  })
}

const paths = (): string[] => calls.map((c) => c.path)
const settle = (): Promise<void> => Bun.sleep(25)

beforeEach(() => {
  calls = []
  boot = 'b1'
  unauthorizedOnce = false
  refusals = new Map()
  streamRecords = []
  registerDelayMs = 0
})

const reporterFor = (
  overrides: Partial<Parameters<typeof createPresenceReporter>[1]> & {
    token?: string
    url?: string
  } = {},
) => {
  const ticks: Array<() => void> = []
  let now = 0
  const client = createKeithClient({
    baseUrl: overrides.url ?? server.url.href,
    token: overrides.token ?? 'keith_t',
  })
  const reporter = createPresenceReporter(client, {
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat', 'notify'],
    version: '1.0.0',
    store: memoryStore(ID),
    now: () => now,
    every: (_ms, fn) => {
      ticks.push(fn)
      return () => undefined
    },
    ...overrides,
  })
  return {
    reporter,
    client,
    ticks,
    clock: {
      set: (t: number) => {
        now = t
      },
    },
  }
}

test('the reporter registers once, then heartbeats on each tick with the bearer token', async () => {
  const { reporter, ticks } = reporterFor()
  reporter.start()
  await settle()
  expect(paths()).toEqual(['/rpc/presence/clients/register', '/rpc/presence/clients/heartbeat'])
  expect(calls[0]?.body).toEqual({
    id: ID,
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat', 'notify'],
    version: '1.0.0',
  })
  expect(calls[0]?.auth).toBe('Bearer keith_t')
  ticks[0]?.()
  await settle()
  ticks[0]?.()
  await settle()
  expect(paths().filter((p) => p.endsWith('/heartbeat'))).toHaveLength(3)
  expect(paths().filter((p) => p.endsWith('/register'))).toHaveLength(1)
  await reporter.stop()
})

test('reportNow heartbeats off the cadence with the new view; one during a step runs right after it', async () => {
  let view: { mode: 'ambient' | 'workspace'; desktopId?: string } = { mode: 'ambient' }
  const { reporter } = reporterFor({ view: () => view })
  reporter.reportNow()
  await settle()
  // not started: nothing
  expect(paths()).toEqual([])
  reporter.start()
  // the first step (register, heartbeat) is in flight: this one waits for it
  view = { mode: 'workspace', desktopId: 'd1' }
  reporter.reportNow()
  reporter.reportNow()
  await settle()
  const views = calls.filter((c) => c.path.endsWith('/heartbeat')).map((c) => c.body?.view)
  expect(views.at(-1)).toEqual({ mode: 'workspace', desktopId: 'd1' })
  expect(views).toHaveLength(2)
  await reporter.stop()
})

test('the view reader is read at each heartbeat; without one the beat carries no view', async () => {
  let view: { mode: 'ambient' | 'workspace'; desktopId?: string } | undefined = { mode: 'ambient' }
  const { reporter, ticks } = reporterFor({ view: () => view })
  reporter.start()
  await settle()
  view = { mode: 'workspace', desktopId: 'd2' }
  ticks[0]?.()
  await settle()
  view = undefined
  ticks[0]?.()
  await settle()
  const views = calls.filter((c) => c.path.endsWith('/heartbeat')).map((c) => c.body?.view)
  expect(views).toEqual([{ mode: 'ambient' }, { mode: 'workspace', desktopId: 'd2' }, undefined])
  await reporter.stop()
})

test('active is sent only when touch() ran in the last 30 seconds', async () => {
  const { reporter, ticks, clock } = reporterFor()
  clock.set(1_000)
  reporter.start()
  await settle()
  const actives = (): unknown[] =>
    calls.filter((c) => c.path.endsWith('/heartbeat')).map((c) => c.body?.active)
  expect(actives()).toEqual([false])
  reporter.touch()
  clock.set(10_000)
  ticks[0]?.()
  await settle()
  clock.set(31_001)
  ticks[0]?.()
  await settle()
  clock.set(31_000)
  expect(actives()).toEqual([false, true, false])
  await reporter.stop()
})

test('a core restart (new boot id) registers the client again', async () => {
  const { reporter, ticks } = reporterFor()
  reporter.start()
  await settle()
  boot = 'b2'
  ticks[0]?.()
  await settle()
  expect(paths().filter((p) => p.endsWith('/register'))).toHaveLength(2)
  await reporter.stop()
})

test('a failed heartbeat (401) registers the client again on the next step', async () => {
  const { reporter, ticks } = reporterFor()
  reporter.start()
  await settle()
  unauthorizedOnce = true
  ticks[0]?.()
  await settle()
  ticks[0]?.()
  await settle()
  expect(paths().slice(-2)).toEqual([
    '/rpc/presence/clients/register',
    '/rpc/presence/clients/heartbeat',
  ])
  await reporter.stop()
})

test('stop says goodbye once and sends nothing after it', async () => {
  const { reporter, ticks } = reporterFor()
  reporter.start()
  await settle()
  await reporter.stop()
  await reporter.stop()
  ticks[0]?.()
  await settle()
  const goodbyes = paths().filter((p) => p.endsWith('/goodbye'))
  expect(goodbyes).toHaveLength(1)
  expect(calls.find((c) => c.path.endsWith('/goodbye'))?.body).toEqual({ id: ID })
  expect(paths().filter((p) => p.endsWith('/heartbeat'))).toHaveLength(1)
})

test('a stop while the environment is still being read sends no register and no heartbeat', async () => {
  const { reporter } = reporterFor({
    environment: async () => {
      await Bun.sleep(60)
      return undefined
    },
  })
  reporter.start()
  await Bun.sleep(10)
  await reporter.stop()
  await Bun.sleep(100)
  expect(paths().filter((p) => p.endsWith('/register'))).toHaveLength(0)
  expect(paths().filter((p) => p.endsWith('/heartbeat'))).toHaveLength(0)
})

test('a stop while the first register is in flight still says goodbye once, and no heartbeat follows', async () => {
  const { reporter, ticks } = reporterFor()
  registerDelayMs = 80
  reporter.start()
  // wait until the register call reached the core: it is in flight now
  for (let i = 0; i < 200 && !paths().includes('/rpc/presence/clients/register'); i++)
    await Bun.sleep(5)
  expect(paths()).toContain('/rpc/presence/clients/register')
  await reporter.stop()
  ticks[0]?.()
  await settle()
  expect(paths().filter((p) => p.endsWith('/register'))).toHaveLength(1)
  expect(paths().filter((p) => p.endsWith('/goodbye'))).toHaveLength(1)
  expect(paths().filter((p) => p.endsWith('/heartbeat'))).toHaveLength(0)
})

test('a core that is down never throws; the reporter tries again when it is back', async () => {
  const dead = Bun.serve({ port: 0, fetch: () => new Response('no', { status: 503 }) })
  const url = dead.url.href
  dead.stop(true)
  const { reporter, ticks } = reporterFor({ url })
  expect(() => reporter.start()).not.toThrow()
  await settle()
  ticks[0]?.()
  await settle()
  await reporter.stop()
  expect(reporter.id).toBe(ID)
})

test('the id is kept across starts; a stored id that is not a uuid is replaced and saved', () => {
  const kept = memoryStore(ID)
  expect(
    createPresenceReporter(createKeithClient({ baseUrl: 'http://127.0.0.1:1' }), {
      kind: 'tui',
      label: 'x',
      capabilities: [],
      version: '1',
      store: kept,
    }).id,
  ).toBe(ID)
  const bad = memoryStore('not-a-uuid')
  const fresh = createPresenceReporter(createKeithClient({ baseUrl: 'http://127.0.0.1:1' }), {
    kind: 'tui',
    label: 'x',
    capabilities: [],
    version: '1',
    store: bad,
  })
  expect(fresh.id).not.toBe('not-a-uuid')
  expect(bad.value).toBe(fresh.id)
})

test('a delivery addressed to this client runs the handler and is acked with its answer', async () => {
  const delivered = {
    region: 'parietal',
    clientId: ID,
    deliveryId: 'd-1',
    capability: 'notify',
    name: 'reminder',
  }
  const other = { ...delivered, clientId: OTHER, deliveryId: 'd-other' }
  streamRecords = [
    sse(1, 'brain.parietal.deliver', delivered),
    sse(2, 'brain.parietal.deliver', other),
  ]
  const { reporter } = reporterFor()
  const seen: unknown[] = []
  const stop = reporter.onNotify((delivery) => {
    seen.push(delivery)
    return 'shown'
  })
  await Bun.sleep(80)
  const acks = calls.filter((c) => c.path.endsWith('/ack'))
  expect(seen).toEqual([{ deliveryId: 'd-1', capability: 'notify', name: 'reminder' }])
  expect(acks).toEqual([
    {
      path: '/rpc/presence/clients/ack',
      body: { id: ID, deliveryId: 'd-1', ok: true, result: 'shown' },
      auth: 'Bearer keith_t',
    },
  ])
  stop()
  await reporter.stop()
})

test('the notice text reaches the handler when the core sent one', async () => {
  streamRecords = [
    sse(1, 'brain.parietal.deliver', {
      region: 'parietal',
      clientId: ID,
      deliveryId: 'd-2',
      capability: 'notify',
      name: 'reminder',
      text: 'stand up at 9',
    }),
  ]
  const { reporter } = reporterFor()
  const seen: unknown[] = []
  const stop = reporter.onNotify((delivery) => {
    seen.push(delivery)
    return undefined
  })
  await Bun.sleep(80)
  expect(seen).toEqual([
    { deliveryId: 'd-2', capability: 'notify', name: 'reminder', text: 'stand up at 9' },
  ])
  stop()
  await reporter.stop()
})

test('a handler that throws acks ok false', async () => {
  streamRecords = [
    sse(1, 'brain.parietal.deliver', {
      region: 'parietal',
      clientId: ID,
      deliveryId: 'd-2',
      capability: 'notify',
      name: 'x',
    }),
  ]
  const { reporter } = reporterFor()
  reporter.onNotify(() => {
    throw new Error('no terminal')
  })
  await Bun.sleep(80)
  expect(calls.find((c) => c.path.endsWith('/ack'))?.body).toEqual({
    id: ID,
    deliveryId: 'd-2',
    ok: false,
  })
  await reporter.stop()
})

test('the terminal declares render.markdown on its first register', async () => {
  const { reporter } = reporterFor({ capabilities: [...TERMINAL_CAPABILITIES] })
  reporter.start()
  await settle()
  expect(paths()[0]).toBe('/rpc/presence/clients/register')
  expect(calls[0]?.body?.capabilities).toEqual(['chat', 'notify', 'open.view', 'render.markdown'])
  await reporter.stop()
})

test('an open.view delivery runs its handler with the view name and posts the result', async () => {
  streamRecords = [
    sse(1, 'brain.parietal.deliver', {
      region: 'parietal',
      clientId: ID,
      deliveryId: 'd-view',
      capability: 'open.view',
      name: 'plugin:notes:list',
    }),
  ]
  const { reporter } = reporterFor({ capabilities: [...TERMINAL_CAPABILITIES] })
  const seen: unknown[] = []
  const stop = reporter.onDeliver('open.view', (delivery) => {
    seen.push(delivery)
    return 'opened'
  })
  await Bun.sleep(80)
  expect(seen).toEqual([
    { deliveryId: 'd-view', capability: 'open.view', name: 'plugin:notes:list' },
  ])
  expect(calls.filter((c) => c.path.endsWith('/ack')).map((c) => c.body)).toEqual([
    { id: ID, deliveryId: 'd-view', ok: true, result: 'opened' },
  ])
  stop()
  await reporter.stop()
})

test('an open.view for a view the client cannot open is acked unsupported', async () => {
  streamRecords = [
    sse(1, 'brain.parietal.deliver', {
      region: 'parietal',
      clientId: ID,
      deliveryId: 'd-nope',
      capability: 'open.view',
      name: 'plugin:ghost:view',
    }),
  ]
  const { reporter } = reporterFor({ capabilities: [...TERMINAL_CAPABILITIES] })
  const stop = reporter.onDeliver('open.view', () => {
    throw new UnsupportedDelivery()
  })
  await Bun.sleep(80)
  expect(calls.filter((c) => c.path.endsWith('/ack')).map((c) => c.body)).toEqual([
    { id: ID, deliveryId: 'd-nope', ok: false, result: 'unsupported' },
  ])
  stop()
  await reporter.stop()
})

test('a capability this client did not declare is never handed out: acked unsupported', async () => {
  streamRecords = [
    sse(1, 'brain.parietal.deliver', {
      region: 'parietal',
      clientId: ID,
      deliveryId: 'd-loc',
      capability: 'location.share',
      name: 'city',
    }),
  ]
  const { reporter } = reporterFor()
  const seen: unknown[] = []
  const stopView = reporter.onDeliver('open.view', (delivery) => {
    seen.push(delivery)
    return 'opened'
  })
  const stopLocation = reporter.onDeliver('location.share', (delivery) => {
    seen.push(delivery)
    return undefined
  })
  await Bun.sleep(80)
  expect(seen).toEqual([])
  expect(calls.filter((c) => c.path.endsWith('/ack')).map((c) => c.body)).toEqual([
    { id: ID, deliveryId: 'd-loc', ok: false, result: 'unsupported' },
  ])
  stopView()
  stopLocation()
  await reporter.stop()
})

test('the environment is read once and sent with the register; a reader that fails sends none', async () => {
  let reads = 0
  const env = { host: 'laptop', os: 'linux', device: 'desktop', timezone: 'UTC' }
  const { reporter, ticks } = reporterFor({
    environment: async () => {
      reads++
      return env as never
    },
  })
  reporter.start()
  await settle()
  expect(calls[0]?.body).toMatchObject({ environment: env })
  ticks[0]?.()
  await settle()
  expect(reads).toBe(1)

  calls = []
  const failing = reporterFor({
    environment: async () => {
      throw new Error('no probe')
    },
  })
  failing.reporter.start()
  await settle()
  const register = calls.find((c) => c.path === '/rpc/presence/clients/register')
  expect(register?.body).toEqual({
    id: ID,
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat', 'notify'],
    version: '1.0.0',
  })
  await reporter.stop()
  await failing.reporter.stop()
})

test('a foreign CONFLICT on register gets one new id, saved for this person, and registers again once', async () => {
  refusals = new Map([[ID, 'that client belongs to another person']])
  const store = memoryStore(ID)
  const { reporter } = reporterFor({ store })
  reporter.start()
  await settle()
  const registers = calls.filter((c) => c.path === '/rpc/presence/clients/register')
  expect(registers.map((c) => c.body?.id)).toEqual([ID, reporter.id])
  expect(reporter.id).not.toBe(ID)
  expect(store.value).toBe(reporter.id)
  expect(paths().filter((p) => p.endsWith('/heartbeat'))).toHaveLength(1)
  await reporter.stop()
})

test('a CONFLICT for a full client list is not answered with a new id', async () => {
  refusals = new Map([[ID, 'a person may register at most 20 clients']])
  const store = memoryStore(ID)
  const { reporter } = reporterFor({ store })
  reporter.start()
  await settle()
  const registers = calls.filter((c) => c.path === '/rpc/presence/clients/register')
  expect(registers.map((c) => c.body?.id)).toEqual([ID])
  expect(reporter.id).toBe(ID)
  expect(store.value).toBe(ID)
  await reporter.stop()
})

test('two people on one terminal each register with their own id from the same file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-presence-'))
  try {
    const path = join(dir, 'client.json')
    const ana = createPresenceReporterFor(path, 'person-ana')
    const budi = createPresenceReporterFor(path, 'person-budi')
    ana.start()
    budi.start()
    await settle()
    const ids = calls
      .filter((c) => c.path === '/rpc/presence/clients/register')
      .map((c) => c.body?.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids).toContain(ana.id)
    expect(ids).toContain(budi.id)
    // the next start of each person reads back their own id
    expect(fileClientIdStore(path, 'person-ana').read()).toBe(ana.id)
    expect(fileClientIdStore(path, 'person-budi').read()).toBe(budi.id)
    await ana.stop()
    await budi.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an older client-state file (one clientId) is the fallback of the first person who registers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-presence-'))
  try {
    const path = join(dir, 'client.json')
    writeFileSync(join(dir, 'client-state.json'), JSON.stringify({ clientId: ID }))
    const ana = createPresenceReporterFor(path, 'person-ana')
    expect(ana.id).toBe(ID)
    ana.start()
    await settle()
    expect(JSON.parse(readFileSync(join(dir, 'client-state.json'), 'utf8'))).toEqual({
      clientId: ID,
      clientIds: { 'person-ana': ID },
    })
    await ana.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createPresenceReporterFor(path: string, personId: string) {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  return createPresenceReporter(client, {
    kind: 'tui',
    label: 'laptop',
    capabilities: ['chat'],
    version: '1.0.0',
    store: fileClientIdStore(path, personId),
    every: () => () => undefined,
  })
}
