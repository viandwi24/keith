/**
 * Plugin terminal views over the real server (docs/specs/plugin-views.md): the menu per actor, the upgrade
 * authentication, hello and frames over a real WebSocket, chunking of a big frame, the caps, revocation, and the
 * node gateway still answering on the same `websocket` object.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { Text, useEffect, useInput, useKeith, useState, useTerminal } from '@keith/host/tui'
import { z } from 'zod'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

function Hello() {
  const k = useKeith()
  const [text, setText] = useState('loading')
  useEffect(() => {
    k.call<{ person: string }>('vw.whoami')
      .then((r) => setText(`viewer ${r.person}`))
      .catch(() => setText('refused'))
  }, [k])
  return <Text>{text}</Text>
}
function Counter() {
  const [n, setN] = useState(0)
  const t = useTerminal()
  useInput((input) => {
    if (input === 'k') setN((x) => x + 1)
  })
  return (
    <Text>
      n={n} {t.cols}x{t.rows}
    </Text>
  )
}
function Big({ params }: { params: Readonly<Record<string, string>> }) {
  const lines = Number(params.lines ?? '10')
  return (
    <Text>{Array.from({ length: lines }, (_, i) => `${i}:${'x'.repeat(100)}`).join('\n')}</Text>
  )
}
function Admin() {
  return <Text>admin only</Text>
}

const plugin = defineKeithPlugin({
  id: 'vw',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [
    { id: 'vw.use', description: 'Use the view plugin.', roles: ['member'] },
    { id: 'vw.admin', description: 'Admin view.' },
  ],
  operations: [
    defineOperation({
      name: 'whoami',
      description: 'The viewer.',
      input: z.object({}),
      output: z.object({ person: z.string().nullable() }),
      permission: { capability: 'vw.use' },
      risk: 'read',
      run: (_i, k) => ({ person: k.actor.personId }),
    }),
  ],
  tui: {
    menu: [
      { id: 'hello', label: 'Hello', view: 'hello', permission: 'vw.use' },
      { id: 'counter', label: 'Counter', view: 'counter' },
      { id: 'big', label: 'Big', view: 'big' },
      { id: 'admin', label: 'Admin', view: 'admin', permission: 'vw.admin' },
    ],
    views: {
      hello: async () => ({ default: Hello }),
      counter: async () => ({ default: Counter }),
      big: async () => ({ default: Big }),
      admin: async () => ({ default: Admin }),
    },
  },
})

let booted: BootedCore
let db: Sqlite
let ana = { id: '', token: '', credentialId: '' }
let ben = { id: '', token: '', credentialId: '' }
let owner = { id: '', token: '' }
let outsider = { id: '', token: '' }

async function credentialFor(personId: string) {
  const { token, id } = await createCredential(credentialsRepo(db), {
    personId,
    kind: 'token',
    label: 'test',
  })
  return { token, credentialId: id }
}

beforeAll(async () => {
  booted = await bootCore({}, { plugins: [plugin] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
  const make = async (username: string) => {
    const p = await booted.local.rpc.admin.people.add({ username, name: username })
    return { id: p.id, ...(await credentialFor(p.id)) }
  }
  ana = await make('ana')
  ben = await make('ben')
  const who = await booted.local.rpc.auth.whoami()
  owner = { id: who.personId, token: (await credentialFor(who.personId)).token }
  const eve = await make('eve')
  outsider = { id: eve.id, token: eve.token }
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

const http = (path: string, token?: string) =>
  fetch(
    `${booted.url}${path}`,
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  )

interface Conn {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  closedByPeer: Promise<{ code: number }>
  until(
    match: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>
  send(m: unknown): void
}
function connect(token: string | undefined, headers: Record<string, string> = {}): Promise<Conn> {
  const url = `${booted.url.replace('http', 'ws')}/plugins/views/ws`
  const ws = new WebSocket(url, {
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
  } as never)
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  ws.onmessage = (e) => {
    messages.push(JSON.parse(String(e.data)))
    for (const w of waiters.splice(0)) w()
  }
  const closedByPeer = new Promise<{ code: number }>((resolve) => {
    ws.onclose = (e) => {
      for (const w of waiters.splice(0)) w()
      resolve({ code: e.code })
    }
  })
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('socket error'))
    ws.onopen = () =>
      resolve({
        ws,
        messages,
        closedByPeer,
        send: (m) => ws.send(JSON.stringify(m)),
        async until(match, ms = 3000) {
          const deadline = Date.now() + ms
          for (;;) {
            const found = messages.find(match)
            if (found !== undefined) return found
            if (Date.now() > deadline)
              throw new Error(`timed out; got ${JSON.stringify(messages).slice(0, 500)}`)
            await new Promise<void>((r) => {
              waiters.push(r)
              setTimeout(r, 50)
            })
          }
        },
      })
  })
}
const hello = (viewId: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'hello',
  viewId,
  cols: 60,
  rows: 12,
  colorDepth: 24,
  ...extra,
})
const frameText = (c: Conn): string[] =>
  c.messages.filter((m) => m.type === 'frame').map((m) => String(m.text))
const lastFrame = (c: Conn) => frameText(c).at(-1)

describe('the menu', () => {
  test('differs per actor: the owner sees the admin entry, a member does not', async () => {
    const ids = async (token: string) =>
      (
        (await (await http('/plugins/tui/menu', token)).json()) as { items: Array<{ id: string }> }
      ).items.map((i) => i.id)
    expect(await ids(owner.token)).toEqual(['vw.hello', 'vw.counter', 'vw.big', 'vw.admin'])
    expect(await ids(ana.token)).toEqual(['vw.hello', 'vw.counter', 'vw.big'])
    const items = (await (await http('/plugins/tui/menu', ana.token)).json()) as {
      items: Array<Record<string, string>>
    }
    expect(items.items[0]).toEqual({
      id: 'vw.hello',
      plugin: 'vw',
      label: 'Hello',
      viewId: 'vw.hello',
    })
  })

  test('no credential and an unknown credential are 401', async () => {
    expect((await http('/plugins/tui/menu')).status).toBe(401)
    expect((await http('/plugins/tui/menu', 'keith_s_nope')).status).toBe(401)
  })
})

describe('the upgrade', () => {
  test('refuses no bearer, an unknown bearer, a foreign Origin and a plain GET', async () => {
    await expect(connect(undefined)).rejects.toThrow()
    await expect(connect('keith_s_unknown')).rejects.toThrow()
    await expect(connect(ana.token, { origin: 'https://evil.example' })).rejects.toThrow()
    const plain = await http('/plugins/views/ws', ana.token)
    expect(plain.status).toBe(426)
  })
})

describe('a view over the socket', () => {
  test('hello, ready, a frame for the viewer, keys, resize, close', async () => {
    const c = await connect(ana.token)
    c.send(hello('vw.counter'))
    await c.until((m) => m.type === 'ready')
    await c.until((m) => m.type === 'frame')
    expect(c.messages[0]).toEqual({ v: 1, type: 'ready', cols: 60, rows: 12 })
    expect(lastFrame(c)).toBe('n=0 60x12')
    c.send({ type: 'key', data: 'k' })
    c.send({ type: 'key', data: 'k' })
    await c.until((m) => m.type === 'frame' && m.text === 'n=2 60x12')
    c.send({ type: 'resize', cols: 80, rows: 20 })
    await c.until((m) => m.type === 'frame' && m.text === 'n=2 80x20')
    // the reserved keys never reach the view
    c.send({ type: 'key', data: '\u001b' })
    c.send({ type: 'ping' })
    await c.until((m) => m.type === 'pong')
    expect(frameText(c).every((t) => !t.includes('n=3'))).toBe(true)
    c.send({ type: 'close' })
    await c.until((m) => m.type === 'closed' && m.reason === 'view')
    expect((await c.closedByPeer).code).toBe(1000)
    expect(booted.core.views.snapshot()).toEqual([])
  })

  test('two viewers of one view see their own data', async () => {
    const a = await connect(ana.token)
    const b = await connect(ben.token)
    a.send(hello('vw.hello'))
    b.send(hello('vw.hello'))
    await a.until((m) => m.type === 'frame' && String(m.text).startsWith('viewer'))
    await b.until((m) => m.type === 'frame' && String(m.text).startsWith('viewer'))
    expect(lastFrame(a)).toBe(`viewer ${ana.id}`)
    expect(lastFrame(b)).toBe(`viewer ${ben.id}`)
    a.ws.close()
    b.ws.close()
    await a.closedByPeer
    await b.closedByPeer
  })

  test('refuses an unknown view, a view the actor may not open, a bad hello and a message before hello', async () => {
    for (const first of [
      hello('vw.nothing'),
      hello('vw.admin'),
      hello('vw.hello', { cols: 5 }),
      { type: 'key', data: 'a' },
    ]) {
      const c = await connect(ana.token)
      c.send(first)
      await c.until((m) => m.type === 'closed' && m.reason === 'refused')
      expect(c.messages.some((m) => m.type === 'frame' || m.type === 'ready')).toBe(false)
    }
    // the owner may open the admin view
    const o = await connect(owner.token)
    o.send(hello('vw.admin'))
    await o.until((m) => m.type === 'frame' && m.text === 'admin only')
    o.ws.close()
  })

  test('a second hello is a protocol error; garbage after hello is an error', async () => {
    const c = await connect(ana.token)
    c.send(hello('vw.counter'))
    await c.until((m) => m.type === 'ready')
    c.send(hello('vw.counter'))
    await c.until((m) => m.type === 'closed' && m.reason === 'error')
    const d = await connect(ana.token)
    d.send(hello('vw.counter'))
    await d.until((m) => m.type === 'ready')
    d.ws.send('not json')
    await d.until((m) => m.type === 'closed' && m.reason === 'error')
  })

  test('the fourth view of one actor is refused with limit', async () => {
    const open: Conn[] = []
    for (let i = 0; i < 3; i++) {
      const c = await connect(ben.token)
      c.send(hello('vw.counter'))
      await c.until((m) => m.type === 'ready')
      open.push(c)
    }
    const fourth = await connect(ben.token)
    fourth.send(hello('vw.counter'))
    await fourth.until((m) => m.type === 'closed' && m.reason === 'limit')
    expect(booted.core.views.snapshot()).toHaveLength(3)
    for (const c of open) c.ws.close()
    await Promise.all(open.map((c) => c.closedByPeer))
    await Bun.sleep(30)
    expect(booted.core.views.snapshot()).toEqual([])
  })

  test('a frame larger than a part comes in parts that reassemble; one over the cap closes with limit', async () => {
    const c = await connect(ana.token)
    // 600 lines of about 105 characters: roughly 63 KB, past the 40 KB where a loopback socket stalled in the past
    c.send(hello('vw.big', { cols: 200, params: { lines: '600' } }))
    await c.until((m) => m.type === 'frame' && m.more === undefined, 5000)
    const parts = c.messages.filter((m) => m.type === 'frame')
    expect(parts.length).toBeGreaterThan(3)
    for (const part of parts.slice(0, -1)) expect(part.more).toBe(true)
    for (const part of parts) expect(String(part.text).length).toBeLessThanOrEqual(16 * 1024)
    expect(new Set(parts.map((p) => p.seq)).size).toBe(1)
    const text = parts.map((p) => String(p.text)).join('')
    expect(text.split('\n')).toHaveLength(600)
    expect(text.split('\n')[599]).toBe(`599:${'x'.repeat(100)}`)
    c.ws.close()
    await c.closedByPeer

    const big = await connect(ana.token)
    big.send(hello('vw.big', { params: { lines: '3000' } })) // about 315 KB
    await big.until((m) => m.type === 'closed' && m.reason === 'limit', 5000)
    expect(big.messages.some((m) => m.type === 'frame')).toBe(false)
  })

  test('suspending the person closes their view within a second, and a revoked credential too', async () => {
    const c = await connect(ben.token)
    c.send(hello('vw.counter'))
    await c.until((m) => m.type === 'ready')
    const eve = await connect(outsider.token)
    eve.send(hello('vw.counter'))
    await eve.until((m) => m.type === 'ready')
    const start = Date.now()
    credentialsRepo(db).revoke(ben.credentialId)
    await c.until((m) => m.type === 'closed' && m.reason === 'revoked', 1500)
    expect(Date.now() - start).toBeLessThan(1300)
    expect(booted.core.views.snapshot().map((v) => v.principalId)).toEqual([outsider.id])
    const s2 = Date.now()
    await booted.local.rpc.admin.people.suspend({ person: outsider.id })
    await eve.until((m) => m.type === 'closed' && m.reason === 'revoked', 1500)
    expect(Date.now() - s2).toBeLessThan(1300)
    expect(booted.core.views.snapshot()).toEqual([])
    expect(booted.core.viewSockets()).toBe(0)
  })
})

describe('the node socket shares the dispatcher', () => {
  test('/nodes/ws still authenticates through the same websocket object', async () => {
    const res = await fetch(`${booted.url}/nodes/ws`, { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
  })
})
