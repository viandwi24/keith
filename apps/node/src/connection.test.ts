import { describe, expect, test } from 'bun:test'
import { type NodeManifest, PROTOCOL_VERSION } from '@keith/contracts'
import {
  backoffDelay,
  type Clock,
  type ConnectionState,
  createConnection,
  REVOKED_CLOSE_CODE,
  type SocketLike,
} from './connection.ts'

function at<T>(list: T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

import { silentLogger } from './platform/logger.ts'

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(): void {
    this.onclose?.({ code: 1006, reason: '' })
  }
}

class FakeClock implements Clock {
  time = 0
  private timers: { id: number; at: number; every?: number; fn: () => void }[] = []
  private next = 1
  now(): number {
    return this.time
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.next++
    this.timers.push({ id, at: this.time + ms, fn })
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id)
    }
  }
  setInterval(fn: () => void, ms: number): () => void {
    const id = this.next++
    this.timers.push({ id, at: this.time + ms, every: ms, fn })
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id)
    }
  }
  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.time = due.at
      if (due.every) due.at += due.every
      else this.timers = this.timers.filter((t) => t.id !== due.id)
      due.fn()
    }
    this.time = target
  }
}

const manifest: NodeManifest = {
  name: 'test-node',
  os: 'linux',
  arch: 'x64',
  version: '0.0.0',
  capabilities: ['system.info', 'shell.exec'],
  policy: { allowShell: false },
}

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

function setup(extra: Partial<Parameters<typeof createConnection>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const clock = new FakeClock()
  const states: ConnectionState[] = []
  const calls = {
    invoke: [] as unknown[],
    cancel: [] as unknown[],
    drops: 0,
    refused: [] as string[],
    revoked: [] as string[],
  }
  const connection = createConnection({
    url: 'ws://core/nodes/ws',
    token: 'tok',
    manifest,
    logger: silentLogger,
    clock,
    random: () => 0.5,
    socketFactory: (url, headers) => {
      const s = new FakeSocket(url, headers)
      sockets.push(s)
      return s
    },
    onInvoke: (m) => calls.invoke.push(m),
    onCancel: (m) => calls.cancel.push(m),
    onDrop: () => calls.drops++,
    onRefused: (r) => calls.refused.push(r),
    onRevoked: (r) => calls.revoked.push(r),
    onState: (s) => states.push(s),
    // a core that answers, so a socket that never opened is retried (not revoked)
    probe: async () => 500,
    ...extra,
  })
  const welcome = (accepted = true, heartbeatMs = 10_000, reason?: string) => ({
    v: PROTOCOL_VERSION,
    type: 'welcome',
    accepted,
    nodeId: 'n1',
    heartbeatMs,
    ...(reason ? { reason } : {}),
  })
  return { connection, sockets, clock, states, calls, welcome }
}

describe('connection', () => {
  test('sends hello with the bearer header on open', () => {
    const t = setup()
    t.connection.start()
    const s = at(t.sockets, 0)
    expect(s.headers).toEqual({ Authorization: 'Bearer tok' })
    expect(t.connection.state).toBe('connecting')
    s.open()
    expect(s.sent).toEqual([{ v: PROTOCOL_VERSION, type: 'hello', manifest }])
  })

  test('heartbeats at the cadence welcome asks for', () => {
    const t = setup()
    t.connection.start()
    const s = at(t.sockets, 0)
    s.open()
    s.receive(t.welcome(true, 10_000))
    expect(t.connection.state).toBe('online')
    t.clock.advance(9_999)
    expect(s.sent.filter((m) => m.type === 'heartbeat')).toHaveLength(0)
    t.clock.advance(1)
    t.clock.advance(10_000)
    const beats = s.sent.filter((m) => m.type === 'heartbeat')
    expect(beats.map((b) => b.at)).toEqual([10_000, 20_000])
  })

  test('routes invoke and cancel only after welcome', () => {
    const t = setup()
    t.connection.start()
    const s = at(t.sockets, 0)
    s.open()
    const invoke = {
      v: 1,
      type: 'invoke',
      callId: 'a',
      capability: 'system.info',
      input: {},
      timeoutMs: 1000,
    }
    s.receive(invoke)
    expect(t.calls.invoke).toHaveLength(0)
    s.receive(t.welcome())
    s.receive(invoke)
    s.receive({ v: 1, type: 'cancel', callId: 'a' })
    s.onmessage?.({ data: 'not json' })
    expect(t.calls.invoke).toHaveLength(1)
    expect(t.calls.cancel).toHaveLength(1)
  })

  test('reconnects with exponential backoff and kills running calls on drop', async () => {
    const t = setup()
    t.connection.start()
    at(t.sockets, 0).open()
    at(t.sockets, 0).receive(t.welcome())
    at(t.sockets, 0).drop()
    expect(t.calls.drops).toBe(1)
    expect(t.connection.state).toBe('backoff')
    t.clock.advance(backoffDelay(0, 0.5) - 1)
    expect(t.sockets).toHaveLength(1)
    t.clock.advance(1)
    expect(t.sockets).toHaveLength(2)
    // Failed again before welcome: delay doubles (the status probe answers first).
    at(t.sockets, 1).drop()
    await flush()
    t.clock.advance(backoffDelay(1, 0.5) - 1)
    expect(t.sockets).toHaveLength(2)
    t.clock.advance(1)
    expect(t.sockets).toHaveLength(3)
    // Welcome resets the backoff.
    at(t.sockets, 2).open()
    at(t.sockets, 2).receive(t.welcome())
    at(t.sockets, 2).drop()
    t.clock.advance(backoffDelay(0, 0.5))
    expect(t.sockets).toHaveLength(4)
  })

  test('backoff grows to 30 s and no further', () => {
    expect(backoffDelay(0, 0.5)).toBe(1000)
    expect(backoffDelay(3, 0.5)).toBe(8000)
    expect(backoffDelay(5, 0.5)).toBe(30_000)
    expect(backoffDelay(20, 0.5)).toBe(30_000)
    expect(backoffDelay(20, 0)).toBe(24_000)
    expect(backoffDelay(20, 1)).toBe(36_000)
  })

  test('no welcome in time means backoff', () => {
    const t = setup()
    t.connection.start()
    at(t.sockets, 0).open()
    t.clock.advance(10_000)
    expect(t.connection.state).toBe('backoff')
  })

  test('refused welcome stops for good', () => {
    const t = setup()
    t.connection.start()
    const s = at(t.sockets, 0)
    s.open()
    s.receive(t.welcome(false, 10_000, 'revoked'))
    expect(t.calls.refused).toEqual(['revoked'])
    expect(t.connection.state).toBe('stopped')
    expect(s.closed).toBe(true)
    t.clock.advance(120_000)
    expect(t.sockets).toHaveLength(1)
  })

  test('stop closes the socket, drops calls and cancels the reconnect', () => {
    const t = setup()
    t.connection.start()
    at(t.sockets, 0).open()
    at(t.sockets, 0).receive(t.welcome())
    t.connection.stop()
    expect(t.calls.drops).toBe(1)
    expect(at(t.sockets, 0).closed).toBe(true)
    t.clock.advance(60_000)
    expect(t.sockets).toHaveLength(1)
    expect(t.connection.send({ v: 1, type: 'heartbeat', at: 1 })).toBe(false)
  })
})

describe('token rotation (protocol 2)', () => {
  const rotate = { v: PROTOCOL_VERSION, type: 'rotate', token: 'new-token' }

  test('the new token is stored, answered with rotated, and the reconnect uses it', async () => {
    const stored: string[] = []
    const { connection, sockets, calls, welcome } = setup({
      persistToken: async (t) => {
        stored.push(t)
      },
    })
    connection.start()
    at(sockets, 0).open()
    at(sockets, 0).receive(welcome())
    at(sockets, 0).receive(rotate)
    await Bun.sleep(5)
    expect(stored).toEqual(['new-token'])
    expect(at(sockets, 0).sent.at(-1)).toEqual({ v: PROTOCOL_VERSION, type: 'rotated' })
    expect(at(sockets, 0).closed).toBe(true)
    expect(calls.drops).toBe(1)
    expect(sockets).toHaveLength(2)
    expect(at(sockets, 1).headers).toEqual({ Authorization: 'Bearer new-token' })
  })

  test('a failed store keeps the old token: nothing is acknowledged, no reconnect', async () => {
    const { connection, sockets, clock, welcome } = setup({
      persistToken: async () => {
        throw new Error('disk full')
      },
    })
    connection.start()
    at(sockets, 0).open()
    at(sockets, 0).receive(welcome())
    at(sockets, 0).receive(rotate)
    await Bun.sleep(5)
    expect(at(sockets, 0).sent.some((m) => m.type === 'rotated')).toBe(false)
    expect(sockets).toHaveLength(1)
    at(sockets, 0).drop()
    clock.advance(1_000)
    expect(at(sockets, 1).headers).toEqual({ Authorization: 'Bearer tok' })
  })

  test('without a store the node never accepts a token', async () => {
    const { connection, sockets, welcome } = setup()
    connection.start()
    at(sockets, 0).open()
    at(sockets, 0).receive(welcome())
    at(sockets, 0).receive(rotate)
    await Bun.sleep(5)
    expect(at(sockets, 0).sent.some((m) => m.type === 'rotated')).toBe(false)
    expect(sockets).toHaveLength(1)
  })

  test('a socket that drops while the token is stored: the file gets it, the next connect uses it', async () => {
    let finish: () => void = () => {}
    const { connection, sockets, clock, welcome } = setup({
      persistToken: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    connection.start()
    at(sockets, 0).open()
    at(sockets, 0).receive(welcome())
    at(sockets, 0).receive(rotate)
    at(sockets, 0).drop()
    finish()
    await Bun.sleep(5)
    // the socket was gone: nothing is acknowledged, but the token is current for the next connect
    expect(at(sockets, 0).sent.some((m) => m.type === 'rotated')).toBe(false)
    clock.advance(1_000)
    expect(at(sockets, 1).headers).toEqual({ Authorization: 'Bearer new-token' })
  })
})

describe('revocation (F-033)', () => {
  test('close 4003 stops the daemon for good: no reconnect, one revoked callback', () => {
    const t = setup()
    t.connection.start()
    at(t.sockets, 0).open()
    at(t.sockets, 0).receive(t.welcome())
    at(t.sockets, 0).onclose?.({ code: REVOKED_CLOSE_CODE, reason: 'revoked' })
    expect(t.connection.state).toBe('revoked')
    expect(t.calls.revoked).toEqual(['revoked by core'])
    expect(t.calls.drops).toBe(1)
    t.clock.advance(300_000)
    expect(t.sockets).toHaveLength(1)
    expect(t.states.at(-1)).toBe('revoked')
  })

  test('a socket that never opened and a probe answering 401 stops: no retry', async () => {
    const probed: { url: string; auth: string }[] = []
    const t = setup({
      probe: async (url, headers) => {
        probed.push({ url, auth: headers.Authorization ?? '' })
        return 401
      },
    })
    t.connection.start()
    at(t.sockets, 0).drop()
    await flush()
    expect(probed).toEqual([{ url: 'ws://core/nodes/ws', auth: 'Bearer tok' }])
    expect(t.connection.state).toBe('revoked')
    expect(t.calls.revoked).toHaveLength(1)
    t.clock.advance(300_000)
    expect(t.sockets).toHaveLength(1)
  })

  test('a probe answering 5xx still backs off and retries', async () => {
    const t = setup({ probe: async () => 503 })
    t.connection.start()
    at(t.sockets, 0).drop()
    await flush()
    expect(t.connection.state).toBe('backoff')
    t.clock.advance(backoffDelay(0, 0.5))
    expect(t.sockets).toHaveLength(2)
    expect(t.calls.revoked).toHaveLength(0)
  })

  test('a probe that cannot connect (core down) backs off and retries', async () => {
    const t = setup({
      probe: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    t.connection.start()
    at(t.sockets, 0).drop()
    await flush()
    expect(t.connection.state).toBe('backoff')
    t.clock.advance(backoffDelay(0, 0.5))
    expect(t.sockets).toHaveLength(2)
  })

  test('stop while probing ends the connection without a reconnect', async () => {
    const t = setup({ probe: async () => 401 })
    t.connection.start()
    at(t.sockets, 0).drop()
    t.connection.stop()
    await flush()
    expect(t.connection.state).toBe('stopped')
    expect(t.calls.revoked).toHaveLength(0)
    t.clock.advance(300_000)
    expect(t.sockets).toHaveLength(1)
  })
})
