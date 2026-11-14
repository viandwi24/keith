/**
 * Plugin terminal views over the local Unix socket (docs/specs/plugin-views.md, "Local socket"): the socket's
 * principal is resolved as for HTTP, a locked socket gets no view (423), trust `none` needs a bearer, and a key is
 * the owner's activity for the idle-lock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient, openLocalSession } from '@keith/client'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { Text, useEffect, useInput, useKeith, useState } from '@keith/host/tui'
import { z } from 'zod'
import { type BootedCore, bootCore, FAST_HASH } from './testing/boot-core.ts'

function Who() {
  const k = useKeith()
  const [text, setText] = useState('loading')
  const [n, setN] = useState(0)
  useEffect(() => {
    k.call<{ person: string }>('lv.whoami')
      .then((r) => setText(`viewer ${r.person}`))
      .catch(() => setText('refused'))
  }, [k])
  useInput((input) => {
    if (input === 'k') setN((x) => x + 1)
  })
  return (
    <Text>
      {text} n={n}
    </Text>
  )
}

const plugin = defineKeithPlugin({
  id: 'lv',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'whoami',
      description: 'The viewer.',
      input: z.object({}),
      output: z.object({ person: z.string().nullable() }),
      permission: { capability: 'authenticated' },
      risk: 'read',
      run: (_i, k) => ({ person: k.actor.personId }),
    }),
  ],
  tui: {
    menu: [{ id: 'who', label: 'Who', view: 'who' }],
    views: { who: async () => ({ default: Who }) },
  },
})

let b: BootedCore
const clock = { t: 1_800_000_000_000 }
const MIN = 60_000
const PIN = '482915'

beforeAll(async () => {
  b = await bootCore(
    {},
    { plugins: [plugin], hasher: FAST_HASH, localClock: () => clock.t, localTrust: 'idle-lock' },
  )
})
afterAll(async () => {
  await b.stop()
})

const socketFetch = ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(i, { ...init, unix: b.socketPath } as RequestInit)) as typeof fetch

/** Open the view over the socket: resolves with the frames seen, or the way the upgrade failed. */
async function open(token?: string) {
  const ws = new WebSocket(
    `ws+unix://${b.socketPath}:/plugins/views/ws`,
    token === undefined ? undefined : ({ headers: { authorization: `Bearer ${token}` } } as never),
  )
  const frames: string[] = []
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve()
  })
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; text?: string }
    if (m.type === 'frame') frames.push(m.text ?? '')
  }
  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true)
    ws.onerror = () => resolve(false)
  })
  return {
    opened,
    frames,
    closed,
    ws,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    until: async (match: (f: string) => boolean) => {
      for (let i = 0; i < 100 && !frames.some(match); i++) await Bun.sleep(30)
      return frames.at(-1)
    },
  }
}
const hello = { v: 1, type: 'hello', viewId: 'lv.who', cols: 40, rows: 6, colorDepth: 24 }

describe('views over the local socket', () => {
  test('the implicit owner opens a view; a key is activity for the idle-lock', async () => {
    const menu = await createKeithClient({
      baseUrl: 'http://localhost',
      fetch: socketFetch,
      socketPath: b.socketPath,
    }).viewMenu()
    expect(menu.items.map((i) => i.viewId)).toEqual(['lv.who'])
    const c = await open()
    expect(c.opened).toBe(true)
    c.send(hello)
    expect(await c.until((f) => f.includes('viewer owner'))).toContain('viewer owner')
    c.send({ type: 'key', data: 'k' })
    expect(await c.until((f) => f.includes('n=1'))).toContain('n=1')
    c.send({ type: 'close' })
    await c.closed
  })

  test('a locked socket answers 423 and opens nothing; an open view closes when it locks', async () => {
    await b.local.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
    await b.local.rpc.auth.whoami() // a touch
    const live = await open()
    live.send(hello)
    await live.until((f) => f.includes('viewer owner'))
    // typing keeps the socket open past the idle minutes
    clock.t += 10 * MIN
    live.send({ type: 'key', data: 'k' })
    await Bun.sleep(80)
    clock.t += 10 * MIN
    await Bun.sleep(700) // one sweep: still allowed, the key was activity
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    // no activity: the next sweep after the idle minutes closes it
    clock.t += 16 * MIN
    await b.local.rpc.auth.whoami().catch(() => undefined) // judged on the next request: locks
    await live.closed
    // a new upgrade is refused with the lock's 423
    const res = await socketFetch('http://localhost/plugins/views/ws', {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': btoa('0123456789abcdef'),
      },
    })
    expect(res.status).toBe(423)
    const refused = await open()
    expect(refused.opened).toBe(false)
    await socketFetch('http://localhost/auth/local/unlock', {
      method: 'POST',
      body: JSON.stringify({ pin: PIN }),
    })
  })

  test('trust none: no bearer, no view; a session credential opens it', async () => {
    await b.local.rpc.admin.auth.local.set({ trust: 'none' })
    const bare = await open()
    expect(bare.opened).toBe(false)
    const session = await openLocalSession({
      fetch: socketFetch,
      pin: PIN,
    })
    const c = await open(session.credential)
    expect(c.opened).toBe(true)
    c.send(hello)
    expect(await c.until((f) => f.includes('viewer owner'))).toContain('viewer owner')
    c.send({ type: 'close' })
    await c.closed
  })
})
