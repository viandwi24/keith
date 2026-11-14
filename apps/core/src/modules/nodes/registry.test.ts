import { describe, expect, test } from 'bun:test'
import { type CoreToNode, type NodeManifest, PROTOCOL_VERSION } from '@keith/contracts'
import { migrateDatabase, nodesRepo, openDatabase } from '@keith/db'
import { inMemoryActivityStore } from 'eharness/activity'
import { createCoreNode } from './core-node.ts'
import { createRegistry } from './registry.ts'
import type { InvokeOutcome, NodeSocket } from './types.ts'

const manifest = (name: string): NodeManifest => ({
  name,
  os: 'linux',
  arch: 'arm64',
  version: '1.0.0',
  capabilities: ['system.info', 'shell.exec'],
  policy: { allowShell: true },
})

class FakeSocket implements NodeSocket {
  sent: CoreToNode[] = []
  closed: { code?: number; reason?: string } | undefined
  send(data: string): void {
    this.sent.push(JSON.parse(data) as CoreToNode)
  }
  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    }
  }
  /** The `invoke` messages core sent. */
  get invokes() {
    return this.sent.flatMap((m) => (m.type === 'invoke' ? [m] : []))
  }
  get cancels() {
    return this.sent.flatMap((m) => (m.type === 'cancel' ? [m] : []))
  }
}

function setup(options: { now?: () => number; heartbeatTimeoutMs?: number } = {}) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const nodes = nodesRepo(sqlite)
  const store = inMemoryActivityStore()
  const hub = createRegistry({
    nodes,
    store,
    local: createCoreNode({ allowShell: false, version: '0', env: {} }),
    timeoutGraceMs: 30,
    ...options,
  })
  const pair = (name: string) =>
    nodes.create({
      name,
      os: 'linux',
      arch: 'arm64',
      version: '1.0.0',
      manifest: manifest(name),
      allowShell: true,
      tokenHash: `hash-${name}`,
    })
  const connect = (name: string) => {
    const record = pair(name)
    const socket = new FakeSocket()
    expect(hub.connect(record.id, socket, manifest(name))).toBe(true)
    return { record, socket }
  }
  const events = async () =>
    (await store.read({ after: 0, limit: 100 })).map(
      (e) => e.payload as { node: { name: string; status: string } },
    )
  return { hub, nodes, store, pair, connect, events }
}

const ok = (callId: string, output: unknown) =>
  ({ v: PROTOCOL_VERSION, type: 'result', callId, ok: true, output, exitCode: 0 }) as const

describe('registry: state', () => {
  test('core is always listed first; paired nodes are offline until they connect, online while connected', async () => {
    const { hub, pair, events } = setup()
    const record = pair('laptop-e')
    expect(hub.list().map((n) => [n.name, n.status])).toEqual([
      ['core', 'online'],
      ['laptop-e', 'offline'],
    ])
    const socket = new FakeSocket()
    hub.connect(record.id, socket, manifest('laptop-e'))
    expect(hub.find('laptop-e')).toMatchObject({ status: 'online', os: 'linux', allowShell: true })
    expect(hub.find(record.id)?.name).toBe('laptop-e')
    hub.disconnect(record.id, socket)
    expect(hub.find('laptop-e')?.status).toBe('offline')
    expect((await events()).map((e) => e.node.status)).toEqual(['online', 'offline'])
  })

  test('an unknown or revoked node cannot connect', () => {
    const { hub, pair, nodes } = setup()
    expect(hub.connect('nope', new FakeSocket(), manifest('x'))).toBe(false)
    const record = pair('laptop-e')
    nodes.revoke(record.id)
    expect(hub.connect(record.id, new FakeSocket(), manifest('laptop-e'))).toBe(false)
  })

  test('a newer connection replaces the old one, and the old close does not take the node offline', () => {
    const { hub, pair } = setup()
    const record = pair('laptop-e')
    const first = new FakeSocket()
    const second = new FakeSocket()
    hub.connect(record.id, first, manifest('laptop-e'))
    hub.connect(record.id, second, manifest('laptop-e'))
    expect(first.closed?.code).toBe(4001)
    hub.disconnect(record.id, first)
    expect(hub.find('laptop-e')?.status).toBe('online')
  })

  test('no heartbeat for the timeout: the sweeper marks it offline and closes the socket; a heartbeat keeps it', () => {
    let now = 1_000
    const { hub, connect } = setup({ now: () => now, heartbeatTimeoutMs: 100 })
    const quiet = connect('quiet')
    const lively = connect('lively')
    now += 80
    hub.receive(lively.record.id, { v: 1, type: 'heartbeat', at: now })
    now += 50
    hub.sweep()
    expect(hub.find('quiet')?.status).toBe('offline')
    expect(quiet.socket.closed?.code).toBe(4008)
    expect(hub.find('lively')?.status).toBe('online')
  })

  test('after a crash no node counts as online until it connects (rows said online)', () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const nodes = nodesRepo(sqlite)
    const record = nodes.create({
      name: 'laptop-e',
      os: 'x',
      arch: 'y',
      version: '1',
      manifest: manifest('laptop-e'),
      allowShell: false,
      tokenHash: 'h',
    })
    nodes.setStatus(record.id, 'online', 5)
    createRegistry({
      nodes,
      store: inMemoryActivityStore(),
      local: createCoreNode({ allowShell: false, version: '0', env: {} }),
    })
    expect(nodes.get(record.id)?.status).toBe('offline')
  })
})

describe('registry: invoke', () => {
  test('a call goes out with a callId and comes back with the result, progress on the way', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const chunks: string[] = []
    const pending = hub.invoke(
      'laptop-e',
      'shell.exec',
      { command: 'ls' },
      { timeoutMs: 1000, onProgress: (c) => chunks.push(c) },
    )
    const [invoke] = socket.invokes
    expect(invoke).toMatchObject({
      v: PROTOCOL_VERSION,
      capability: 'shell.exec',
      input: { command: 'ls' },
      timeoutMs: 1000,
    })
    hub.receive(record.id, {
      v: 1,
      type: 'progress',
      callId: invoke?.callId ?? '',
      chunk: 'a\n',
      stream: 'stdout',
    })
    hub.receive(record.id, ok(invoke?.callId ?? '', 'a\n'))
    expect(await pending).toEqual({ ok: true, output: 'a\n', exitCode: 0 })
    expect(chunks).toEqual(['a\n'])
  })

  test('two calls at once are told apart by callId', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const a = hub.invoke('laptop-e', 'system.info', {}, { timeoutMs: 1000 })
    const b = hub.invoke('laptop-e', 'system.info', {}, { timeoutMs: 1000 })
    const [first, second] = socket.invokes
    hub.receive(record.id, ok(second?.callId ?? '', 'B'))
    hub.receive(record.id, ok(first?.callId ?? '', 'A'))
    expect(await a).toMatchObject({ output: 'A' })
    expect(await b).toMatchObject({ output: 'B' })
  })

  test('a node cannot answer the call of another node', async () => {
    const { hub, connect } = setup()
    const one = connect('node-one')
    const two = connect('node-two')
    const pending = hub.invoke('node-one', 'system.info', {}, { timeoutMs: 60 })
    hub.receive(two.record.id, ok(one.socket.invokes[0]?.callId ?? '', 'forged'))
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' })
  })

  test('failures that need no node: unknown node, unknown capability, offline', async () => {
    const { hub, pair } = setup()
    pair('laptop-e')
    expect(await hub.invoke('nope', 'system.info', {}, { timeoutMs: 10 })).toMatchObject({
      code: 'unknown-node',
    })
    expect(await hub.invoke('laptop-e', 'teleport', {}, { timeoutMs: 10 })).toMatchObject({
      code: 'unknown-capability',
    })
    expect(await hub.invoke('laptop-e', 'system.info', {}, { timeoutMs: 10 })).toEqual({
      ok: false,
      code: 'offline',
      message: 'node laptop-e is offline',
    })
  })

  test('abort sends cancel and settles cancelled; a late result is ignored', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const controller = new AbortController()
    const pending = hub.invoke(
      'laptop-e',
      'shell.exec',
      { command: 'sleep 9' },
      { timeoutMs: 5000, signal: controller.signal },
    )
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' })
    expect(socket.cancels.map((c) => c.callId)).toEqual([socket.invokes[0]?.callId ?? ''])
    hub.receive(record.id, ok(socket.invokes[0]?.callId ?? '', 'late'))
  })

  test('an already aborted signal sends nothing at all after the invoke is built', async () => {
    const { hub, connect } = setup()
    connect('laptop-e')
    const controller = new AbortController()
    controller.abort()
    const out = await hub.invoke(
      'laptop-e',
      'system.info',
      {},
      { timeoutMs: 1000, signal: controller.signal },
    )
    expect(out).toMatchObject({ ok: false, code: 'cancelled' })
  })

  test('the time limit (plus grace) settles timeout and sends cancel', async () => {
    const { hub, connect } = setup()
    const { socket } = connect('laptop-e')
    const out = await hub.invoke('laptop-e', 'shell.exec', { command: 'x' }, { timeoutMs: 40 })
    expect(out).toMatchObject({ ok: false, code: 'timeout' })
    expect(socket.cancels.length).toBe(1)
  })

  test('a node error keeps its code', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const pending = hub.invoke('laptop-e', 'shell.exec', { command: 'x' }, { timeoutMs: 1000 })
    hub.receive(record.id, {
      v: 1,
      type: 'result',
      callId: socket.invokes[0]?.callId ?? '',
      ok: false,
      error: { code: 'refused-by-policy', message: 'allowShell is off' },
    })
    expect(await pending).toEqual({
      ok: false,
      code: 'refused-by-policy',
      message: 'allowShell is off',
    })
  })

  test('a node busy keeps its code', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const pending = hub.invoke('laptop-e', 'shell.exec', { command: 'x' }, { timeoutMs: 1000 })
    hub.receive(record.id, {
      v: 1,
      type: 'result',
      callId: socket.invokes[0]?.callId ?? '',
      ok: false,
      error: { code: 'busy', message: 'two calls are running' },
    })
    expect(await pending).toEqual({ ok: false, code: 'busy', message: 'two calls are running' })
  })

  test('a dropped connection fails the calls in flight with "node disconnected"', async () => {
    const { hub, connect } = setup()
    const { record, socket } = connect('laptop-e')
    const pending = hub.invoke('laptop-e', 'shell.exec', { command: 'x' }, { timeoutMs: 5000 })
    hub.disconnect(record.id, socket)
    expect(await pending).toEqual({ ok: false, code: 'failed', message: 'node disconnected' })
  })

  test('revoke closes the socket, fails the calls and hides the node; core cannot be revoked', async () => {
    const { hub, connect, nodes } = setup()
    const { record, socket } = connect('laptop-e')
    const pending = hub.invoke('laptop-e', 'shell.exec', { command: 'x' }, { timeoutMs: 5000 })
    expect(hub.revoke('core')).toBeUndefined()
    expect(hub.revoke(record.id)?.status).toBe('revoked')
    expect(socket.closed?.code).toBe(4003)
    expect(await pending).toEqual({ ok: false, code: 'failed', message: 'node revoked' })
    expect(hub.list().map((n) => n.name)).toEqual(['core'])
    expect(nodes.findByTokenHash('hash-laptop-e')).toBeUndefined()
    expect(hub.revoke('nope')).toBeUndefined()
  })

  test('core runs through the same invoke', async () => {
    const { hub } = setup()
    const out: InvokeOutcome = await hub.invoke('core', 'system.info', {}, { timeoutMs: 1000 })
    expect(out.ok).toBe(true)
    expect(
      await hub.invoke('core', 'shell.exec', { command: 'echo x' }, { timeoutMs: 1000 }),
    ).toMatchObject({
      ok: false,
      code: 'refused-by-policy',
    })
  })

  test('closeAll closes every socket and marks the nodes offline', () => {
    const { hub, connect } = setup()
    const { socket } = connect('laptop-e')
    hub.closeAll()
    expect(socket.closed?.code).toBe(1001)
    expect(hub.find('laptop-e')?.status).toBe('offline')
  })
})

describe('registry: capabilities, drivers and refusals (P31.1.5)', () => {
  const identity = { os: 'linux', arch: 'arm64', version: '1.0.0', policy: { allowShell: true } }
  type Cap = { id: string; schemaVersion: number }
  const driver = (name: string, version: string, capabilities: Cap[]) => ({
    name,
    version,
    capabilities,
  })
  const v2 = (name: string, drivers: ReturnType<typeof driver>[]): NodeManifest =>
    ({ ...identity, name, manifestVersion: 2, drivers }) as unknown as NodeManifest

  function build() {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const nodes = nodesRepo(sqlite)
    const store = inMemoryActivityStore()
    const driversChanged: unknown[] = []
    const refusals: unknown[] = []
    const hub = createRegistry({
      nodes,
      store,
      local: createCoreNode({ allowShell: false, version: '0', env: {} }),
      timeoutGraceMs: 30,
      onDriversChanged: (info) => driversChanged.push(info),
      onCapabilityRefused: (info) => refusals.push(info),
    })
    const pair = (name: string, manifest: NodeManifest) =>
      nodes.create({
        name,
        os: 'linux',
        arch: 'arm64',
        version: '1.0.0',
        manifest,
        allowShell: true,
        tokenHash: `hash-${name}`,
      })
    /** Pairs (first time only) and connects; returns the record and the socket. */
    const connect = (name: string, manifest: NodeManifest) => {
      const record = nodes.list().find((r) => r.name === name) ?? pair(name, manifest)
      const socket = new FakeSocket()
      expect(hub.connect(record.id, socket, manifest)).toBe(true)
      return { record, socket }
    }
    return { hub, nodes, pair, connect, driversChanged, refusals }
  }

  const mixed = (systemVersion = '0.1.0') =>
    v2('laptop-e', [
      driver('system', systemVersion, [{ id: 'system.info', schemaVersion: 1 }]),
      driver('iot', '0.1.0', [{ id: 'iot.switch', schemaVersion: 1 }]),
    ])

  test('an unknown capability is refused and the node stays online with its others', () => {
    const { hub, connect } = build()
    connect('laptop-e', mixed())
    const node = hub.find('laptop-e')
    expect(node?.status).toBe('online')
    expect(node?.capabilities).toEqual(['system.info'])
    expect(node?.drivers).toEqual([
      { name: 'system', version: '0.1.0' },
      { name: 'iot', version: '0.1.0' },
    ])
    expect(node?.refused).toEqual([
      { id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' },
    ])
  })

  test('a node announcing client capabilities is refused wrong-layer and stays online; nodes_status lists none', () => {
    const { hub, connect } = build()
    connect(
      'laptop-e',
      v2('laptop-e', [
        driver('system', '0.1.0', [{ id: 'system.info', schemaVersion: 1 }]),
        driver('open', '0.1.0', [{ id: 'open.view', schemaVersion: 1 }]),
        driver('location', '0.1.0', [{ id: 'location.share', schemaVersion: 1 }]),
      ]),
    )
    const node = hub.find('laptop-e')
    expect(node?.status).toBe('online')
    expect(node?.capabilities).toEqual(['system.info'])
    expect(node?.refused.map((r) => [r.id, r.reason])).toEqual([
      ['open.view', 'wrong-layer'],
      ['location.share', 'wrong-layer'],
    ])
    for (const listed of hub.list()) {
      expect(listed.capabilities).not.toContain('open.view')
      expect(listed.capabilities).not.toContain('location.share')
      expect(listed.capabilities).not.toContain('notify')
    }
  })

  test('invoke of a refused capability fails unknown-capability before anything is sent', async () => {
    const { hub, connect } = build()
    const { socket } = connect('laptop-e', mixed())
    const outcome = await hub.invoke('laptop-e', 'iot.switch', {}, { timeoutMs: 1000 })
    expect(outcome).toMatchObject({ ok: false, code: 'unknown-capability' })
    expect((outcome as { message: string }).message).toContain('refused')
    expect(socket.invokes).toHaveLength(0)
  })

  test('invoke sends the capability version the core accepted', async () => {
    const { hub, connect } = build()
    const { record, socket } = connect('laptop-e', mixed())
    const pending = hub.invoke('laptop-e', 'system.info', {}, { timeoutMs: 1000 })
    const call = socket.invokes[0]
    expect(call?.capabilityVersion).toBe(1)
    hub.receive(record.id, ok(call?.callId ?? '', { hostname: 'x' }))
    expect(await pending).toMatchObject({ ok: true })
  })

  test('byCapability lists online nodes first and filters by schema version', () => {
    const { hub, pair, connect } = build()
    pair(
      'offline-one',
      v2('offline-one', [driver('system', '0.1.0', [{ id: 'system.info', schemaVersion: 1 }])]),
    )
    connect('laptop-e', mixed())
    const names = hub.byCapability('system.info').map((n) => n.name)
    expect(names.at(-1)).toBe('offline-one')
    expect(names).toContain('laptop-e')
    expect(hub.byCapability('system.info', { version: 2 })).toEqual([])
    expect(hub.byCapability('iot.switch')).toEqual([])
  })

  test('a changed driver set is audited once; the same set on the next connection is not', () => {
    const { hub, connect, driversChanged } = build()
    const first = connect('laptop-e', mixed())
    hub.disconnect(first.record.id, first.socket)
    connect('laptop-e', mixed())
    expect(driversChanged).toHaveLength(0)
    const next = connect('laptop-e', mixed('0.2.0'))
    expect(driversChanged).toEqual([
      {
        nodeId: next.record.id,
        name: 'laptop-e',
        changes: [{ name: 'system', version: '0.2.0', change: 'changed' }],
      },
    ])
    hub.disconnect(next.record.id, next.socket)
    connect('laptop-e', mixed('0.2.0'))
    expect(driversChanged).toHaveLength(1)
  })

  test('a refusal is reported once per distinct refusal per connection', () => {
    const { hub, connect, refusals } = build()
    const first = connect('laptop-e', mixed())
    expect(refusals).toEqual([
      {
        nodeId: first.record.id,
        name: 'laptop-e',
        id: 'iot.switch',
        schemaVersion: 1,
        reason: 'unknown-capability',
      },
    ])
    hub.disconnect(first.record.id, first.socket)
    connect('laptop-e', mixed())
    expect(refusals).toHaveLength(2)
  })
})
