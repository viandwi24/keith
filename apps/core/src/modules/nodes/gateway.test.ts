import { describe, expect, test } from 'bun:test'
import {
  type CoreToNode,
  type NodeManifest,
  type NodeToCore,
  PROTOCOL_VERSION,
} from '@keith/contracts'
import { migrateDatabase, nodesRepo, openDatabase } from '@keith/db'
import type { Server } from 'bun'
import { inMemoryActivityStore } from 'eharness/activity'
import { hashToken } from '../auth/index.ts'
import { createCoreNode } from './core-node.ts'
import { createGateway, type Gateway, type NodeSocketData } from './gateway.ts'
import type { RateLimit } from './rate-limit.ts'
import type { NodeHub } from './registry.ts'
import { createRegistry } from './registry.ts'

const manifest: NodeManifest = {
  name: 'laptop-e',
  os: 'linux',
  arch: 'x64',
  version: '1',
  capabilities: ['system.info'],
  policy: { allowShell: false },
}

interface SetupExtra {
  now?: () => number
  /** The stored hash of the node's token (default: a placeholder). */
  tokenHash?: string
  onRotated?: (info: { nodeId: string; name: string }) => void
  rate?: Partial<RateLimit>
  onRateLimited?: (nodeId: string) => void
}

function setup(helloTimeoutMs = 10_000, extra: SetupExtra = {}) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const nodes = nodesRepo(sqlite, { now: extra.now ?? Date.now })
  const record = nodes.create({
    name: 'laptop-e',
    os: 'x',
    arch: 'y',
    version: '1',
    manifest,
    allowShell: false,
    tokenHash: extra.tokenHash ?? 'h',
  })
  const hub = createRegistry({
    nodes,
    store: inMemoryActivityStore(),
    local: createCoreNode({ allowShell: false, version: '0', env: {} }),
  })
  // records what the gateway hands to the registry, so a dropped message is visible
  const delivered: string[] = []
  const tap: NodeHub = {
    ...hub,
    receive: (nodeId: string, message: NodeToCore) => {
      delivered.push(message.type)
      hub.receive(nodeId, message)
    },
  }
  const gateway = createGateway({
    nodes,
    hub: tap,
    heartbeatMs: 123,
    helloTimeoutMs,
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.rate ? { rate: extra.rate } : {}),
    ...(extra.onRateLimited ? { onRateLimited: extra.onRateLimited } : {}),
    ...(extra.onRotated ? { onRotated: extra.onRotated } : {}),
  })
  const sent: CoreToNode[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const ws = {
    data: { nodeId: record.id, welcomed: false } as NodeSocketData,
    send: (data: string) => void sent.push(JSON.parse(data) as CoreToNode),
    close: (code?: number, reason?: string) =>
      void closed.push({
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      }),
  }
  const handler = gateway.websocket as unknown as {
    open(ws: unknown): void
    message(ws: unknown, raw: string): void
    close(ws: unknown): void
  }
  return { hub, ws, handler, sent, closed, record, delivered, gateway, nodes }
}

const hello = (v = PROTOCOL_VERSION) => JSON.stringify({ v, type: 'hello', manifest })

describe('gateway websocket handler', () => {
  test('a good hello is welcomed with the heartbeat interval and the node is online', () => {
    const { hub, ws, handler, sent } = setup()
    handler.open(ws)
    handler.message(ws, hello())
    expect(sent).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'welcome',
        accepted: true,
        nodeId: ws.data.nodeId,
        heartbeatMs: 123,
      },
    ])
    expect(hub.find('laptop-e')?.status).toBe('online')
    handler.close(ws)
    expect(hub.find('laptop-e')?.status).toBe('offline')
  })

  test('an old version, bad JSON, a wrong first message and a bad manifest are refused with a reason and a close', () => {
    for (const [raw, reason] of [
      [hello(0), 'below the minimum'],
      ['{nope', 'JSON hello'],
      [JSON.stringify({ v: 1, type: 'heartbeat', at: 1 }), 'invalid hello'],
      [JSON.stringify({ v: 1, type: 'hello', manifest: { name: 'x' } }), 'invalid hello'],
      // a client id has no dot-free form in a node manifest: `notify` fails the id regex, so the whole manifest is refused
      [
        JSON.stringify({
          v: 1,
          type: 'hello',
          manifest: { ...manifest, capabilities: ['notify'] },
        }),
        'invalid hello',
      ],
    ] as const) {
      const { ws, handler, sent, closed, hub } = setup()
      handler.open(ws)
      handler.message(ws, raw)
      expect(sent[0]).toMatchObject({ type: 'welcome', accepted: false })
      expect((sent[0] as { reason: string }).reason).toContain(reason)
      expect(closed[0]?.code).toBe(4002)
      expect(hub.find('laptop-e')?.status).toBe('offline')
    }
  })

  test('no hello in time: the socket is closed', async () => {
    const { ws, handler, sent, closed } = setup(30)
    handler.open(ws)
    await Bun.sleep(80)
    expect(sent[0]).toMatchObject({ accepted: false, reason: 'no hello received' })
    expect(closed.length).toBe(1)
  })

  test('a node revoked between upgrade and hello is refused', () => {
    const { ws, handler, sent, hub, record } = setup()
    hub.revoke(record.id)
    handler.open(ws)
    handler.message(ws, hello())
    expect(sent[0]).toMatchObject({ accepted: false })
  })

  test('after the welcome, bad messages are ignored and the connection stays', () => {
    const { ws, handler, closed, hub } = setup()
    handler.open(ws)
    handler.message(ws, hello())
    handler.message(ws, 'garbage')
    handler.message(ws, JSON.stringify({ v: 1, type: 'heartbeat', at: 1 }))
    expect(closed).toEqual([])
    expect(hub.find('laptop-e')?.status).toBe('online')
  })
})

const heartbeat = () => JSON.stringify({ v: PROTOCOL_VERSION, type: 'heartbeat', at: 1 })
const beats = (delivered: string[]) => delivered.filter((type) => type === 'heartbeat').length

describe('gateway message budget (ADR-0027 §28)', () => {
  test('the 201st message in a window is dropped; the next window admits again', () => {
    let t = 0
    const { ws, handler, delivered, closed } = setup(10_000, { now: () => t })
    handler.open(ws)
    handler.message(ws, hello())
    for (let i = 0; i < 201; i++) handler.message(ws, heartbeat())
    expect(beats(delivered)).toBe(200)
    expect(closed).toEqual([])
    t += 10_000
    handler.message(ws, heartbeat())
    expect(beats(delivered)).toBe(201)
  })

  test('a node over its budget is audited at most once per five minutes', () => {
    let t = 0
    const audits: string[] = []
    const { ws, handler, closed } = setup(10_000, {
      now: () => t,
      onRateLimited: (nodeId) => audits.push(nodeId),
    })
    handler.open(ws)
    handler.message(ws, hello())
    const flood = () => {
      for (let i = 0; i < 260; i++) handler.message(ws, heartbeat())
    }
    flood()
    expect(audits.length).toBe(1)
    t = 299_000
    flood()
    expect(audits.length).toBe(1)
    t = 300_000
    flood()
    expect(audits.length).toBe(2)
    expect(audits).toEqual([ws.data.nodeId, ws.data.nodeId])
    expect(closed).toEqual([])
  })

  test('drops that continue for 30 s close the socket with 4008, once', () => {
    let t = 0
    const { ws, handler, closed } = setup(10_000, { now: () => t })
    handler.open(ws)
    handler.message(ws, hello())
    // 100 messages a second for 40 s: 200 pass each 10 s window, the rest are dropped
    for (let i = 0; i < 4_000; i++) {
      t += 10
      handler.message(ws, heartbeat())
    }
    expect(closed).toEqual([{ code: 4008, reason: 'message rate limit' }])
  })

  test('normal heartbeat traffic and a burst that ends are never closed', () => {
    let t = 0
    const audits: string[] = []
    const { ws, handler, closed, delivered } = setup(10_000, {
      now: () => t,
      onRateLimited: (nodeId) => audits.push(nodeId),
    })
    handler.open(ws)
    handler.message(ws, hello())
    for (let s = 0; s < 300; s++) {
      t = s * 1_000
      handler.message(ws, heartbeat())
    }
    expect(beats(delivered)).toBe(300)
    expect(audits).toEqual([])
    t = 400_000
    for (let i = 0; i < 250; i++) handler.message(ws, heartbeat())
    t = 460_000
    for (let i = 0; i < 250; i++) handler.message(ws, heartbeat())
    expect(closed).toEqual([])
  })
})

const DAY = 24 * 60 * 60 * 1000
const OLD_TOKEN = 'keith_node_old-token-for-tests'
const rotateHello = (v = PROTOCOL_VERSION) => JSON.stringify({ v, type: 'hello', manifest })
const ack = JSON.stringify({ v: PROTOCOL_VERSION, type: 'rotated' })

/** An upgrade request as a node sends it, with the given bearer token. */
const upgradeWith = (gateway: Gateway, token: string) =>
  gateway.upgrade(
    new Request('http://core/nodes/ws', { headers: { authorization: `Bearer ${token}` } }),
    { upgrade: () => true } as unknown as Server<NodeSocketData>,
  )

/** A node with a known token, issued at time 0, and a clock the test moves. */
async function rotating() {
  let t = 0
  const rotated: string[] = []
  const fixture = setup(10_000, {
    now: () => t,
    tokenHash: await hashToken(OLD_TOKEN),
    onRotated: (info) => rotated.push(info.name),
  })
  return {
    ...fixture,
    rotated,
    at: (ms: number) => {
      t = ms
    },
  }
}

describe('gateway token rotation (ADR-0027 §28)', () => {
  test('a token older than 30 days gets a rotate after the welcome; the old token keeps working', async () => {
    const { ws, handler, sent, gateway, nodes, record, rotated, at } = await rotating()
    at(31 * DAY)
    handler.open(ws)
    handler.message(ws, rotateHello())
    await Bun.sleep(5)
    expect(sent.map((m) => m.type)).toEqual(['welcome', 'rotate'])
    const token = (sent[1] as { token: string }).token
    expect(token.startsWith('keith_node_')).toBe(true)
    expect(nodes.get(record.id)?.tokenIssuedAt).toBe(0)
    expect(rotated).toEqual([])
    expect(await upgradeWith(gateway, OLD_TOKEN)).toBeUndefined()
  })

  test('the node acknowledges with rotated: the new token becomes current, audited once', async () => {
    const { ws, handler, sent, gateway, nodes, record, rotated, at } = await rotating()
    at(31 * DAY)
    handler.open(ws)
    handler.message(ws, rotateHello())
    await Bun.sleep(5)
    const newToken = (sent[1] as { token: string }).token
    handler.message(ws, ack)
    handler.message(ws, ack)
    expect(rotated).toEqual(['laptop-e'])
    expect(nodes.get(record.id)?.tokenIssuedAt).toBe(31 * DAY)
    expect(await upgradeWith(gateway, newToken)).toBeUndefined()
    expect((await upgradeWith(gateway, OLD_TOKEN))?.status).toBe(401)
  })

  test('a lost rotated is completed by the first connection with the new token', async () => {
    const { ws, handler, sent, gateway, nodes, record, rotated, at } = await rotating()
    at(31 * DAY)
    handler.open(ws)
    handler.message(ws, rotateHello())
    await Bun.sleep(5)
    const newToken = (sent[1] as { token: string }).token
    // the node stored the new token, but its rotated never reached core: it connects with the new one
    expect(await upgradeWith(gateway, newToken)).toBeUndefined()
    expect(rotated).toEqual(['laptop-e'])
    expect(nodes.get(record.id)?.tokenIssuedAt).toBe(31 * DAY)
    expect((await upgradeWith(gateway, OLD_TOKEN))?.status).toBe(401)
  })

  test('a token younger than 30 days is not rotated', async () => {
    const { ws, handler, sent, at } = await rotating()
    at(29 * DAY)
    handler.open(ws)
    handler.message(ws, rotateHello())
    await Bun.sleep(5)
    expect(sent.map((m) => m.type)).toEqual(['welcome'])
  })

  test('a v1 node is never rotated, however old its token', async () => {
    const { ws, handler, sent, at } = await rotating()
    at(40 * DAY)
    handler.open(ws)
    handler.message(ws, rotateHello(1))
    await Bun.sleep(5)
    expect(sent.map((m) => m.type)).toEqual(['welcome'])
  })
})
