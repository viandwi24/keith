/**
 * Plugin views in operation (P18 step 8), over the real server: the audit rows, the open rate, the idle teardown, the
 * doctor's list, and a load run at the caps (10 views at once, frames paced, a reader that never reads does not slow the
 * others, everything torn down afterwards).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { Text, useEffect, useInput, useState } from '@keith/host/tui'
import { z } from 'zod'
import { viewsCheck } from './cli/doctor.ts'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

/** Re-renders every 5 ms for as long as it is open: the host paces what it sends. */
function Ticker() {
  const [n, setN] = useState(0)
  useInput(() => {})
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 5)
    return () => clearInterval(t)
  }, [])
  return <Text>tick {n}</Text>
}
/** A frame of about 30 KB (two parts), new four times a second. */
function Heavy() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 20)
    return () => clearInterval(t)
  }, [])
  return (
    <Text>{Array.from({ length: 150 }, (_, i) => `${n}:${i}:${'y'.repeat(1000)}`).join('\n')}</Text>
  )
}
const plugin = defineKeithPlugin({
  id: 'ld',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'ping',
      description: 'Nothing.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'authenticated' },
      risk: 'read',
      run: () => ({}),
    }),
  ],
  tui: {
    menu: [
      { id: 'tick', label: 'Tick', view: 'tick' },
      { id: 'heavy', label: 'Heavy', view: 'heavy' },
    ],
    views: { tick: async () => ({ default: Ticker }), heavy: async () => ({ default: Heavy }) },
  },
})

let booted: BootedCore
let db: Sqlite
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      plugins: [plugin],
      views: {
        limits: { idleMs: 700 },
        // the open rate and the audit budget are small so a test reaches them
        opensPerWindow: { max: 12, windowMs: 60_000 },
        auditMax: 6,
      },
    },
  )
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
  const make = async (username: string) => {
    const p = await booted.local.rpc.admin.people.add({ username, name: username })
    ids[username] = p.id
    tokens[username] = (
      await createCredential(credentialsRepo(db), { personId: p.id, kind: 'token', label: 't' })
    ).token
  }
  for (const name of ['ana', 'ben', 'cy', 'dee', 'fay']) await make(name)
  const who = await booted.local.rpc.auth.whoami()
  ids.owner = who.personId
  tokens.owner = (
    await createCredential(credentialsRepo(db), {
      personId: who.personId,
      kind: 'token',
      label: 't',
    })
  ).token
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

interface Conn {
  frames: number
  closed: string | undefined
  send(m: unknown): void
  until(check: () => boolean, ms?: number): Promise<void>
  ws: WebSocket
}
async function open(as: string, viewId: string): Promise<Conn> {
  const ws = new WebSocket(`${booted.url.replace('http', 'ws')}/plugins/views/ws`, {
    headers: { authorization: `Bearer ${tokens[as]}` },
  } as never)
  const c: Conn = {
    frames: 0,
    closed: undefined,
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    until: async (check, ms = 4000) => {
      for (const end = Date.now() + ms; !check(); await Bun.sleep(15))
        if (Date.now() > end) throw new Error(`timed out (closed: ${c.closed})`)
    },
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; reason?: string }
    if (m.type === 'frame') c.frames++
    if (m.type === 'closed') c.closed = m.reason
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('socket error'))
  })
  c.send({ v: 1, type: 'hello', viewId, cols: 60, rows: 10, colorDepth: 24 })
  return c
}
/** Type into every connection now and then, so the short idle limit of this file does not close them. */
const keepAlive = (conns: Conn[]) => {
  const timer = setInterval(() => {
    for (const c of conns) if (c.closed === undefined) c.send({ type: 'key', data: 'x' })
  }, 200)
  return () => clearInterval(timer)
}
const stopAll = async (conns: Conn[]) => {
  for (const c of conns) c.ws.close()
  for (let i = 0; i < 100 && booted.core.views.snapshot().length > 0; i++) await Bun.sleep(30)
}

describe('audit', () => {
  test('an open and a close are rows with ids and the reason; nothing of the view is in them', async () => {
    const c = await open('ana', 'ld.tick')
    await c.until(() => c.frames > 0)
    c.send({ type: 'key', data: 'typed secret words' })
    c.send({ type: 'close' })
    await c.until(() => c.closed !== undefined)
    const rows = (await booted.local.rpc.admin.audit.list({ limit: 100 })).filter((r) =>
      r.kind.startsWith('plugin.view.'),
    )
    const mine = rows.filter((r) => r.actor === ids.ana)
    expect(mine.map((r) => r.kind).sort()).toEqual(['plugin.view.close', 'plugin.view.open'])
    expect(mine.find((r) => r.kind === 'plugin.view.open')?.detail).toEqual({ viewId: 'ld.tick' })
    expect(mine.find((r) => r.kind === 'plugin.view.close')?.detail).toMatchObject({
      viewId: 'ld.tick',
      reason: 'view',
    })
    expect(JSON.stringify(rows)).not.toContain('typed secret')
    expect(JSON.stringify(rows)).not.toContain('tick ')
  })

  test('the audit rows of one person are rate limited, and a flood of opens is answered limit', async () => {
    // auditMax 6 rows a window: opening and closing many times writes 6 and counts the rest
    for (let i = 0; i < 5; i++) {
      const c = await open('ben', 'ld.tick')
      await c.until(() => c.frames > 0)
      c.send({ type: 'close' })
      await c.until(() => c.closed !== undefined)
    }
    const benRows = (await booted.local.rpc.admin.audit.list({ limit: 200 })).filter(
      (r) => r.actor === ids.ben && r.kind.startsWith('plugin.view.'),
    )
    expect(benRows).toHaveLength(6)
    // the open rate (12 a minute): the 13th open of one person is refused with limit and starts nothing
    let refused: string | undefined
    for (let i = 0; i < 8 && refused === undefined; i++) {
      const c = await open('ben', 'ld.tick')
      await c.until(() => c.frames > 0 || c.closed !== undefined)
      if (c.closed === 'limit') refused = c.closed
      else {
        c.send({ type: 'close' })
        await c.until(() => c.closed !== undefined)
      }
    }
    expect(refused).toBe('limit')
  })
})

describe('idle and the doctor', () => {
  test('a view nobody types in closes as idle and leaves nothing behind; typing keeps it', async () => {
    const quiet = await open('cy', 'ld.tick')
    const typing = await open('cy', 'ld.tick')
    await quiet.until(() => quiet.frames > 0)
    const typed = setInterval(() => typing.send({ type: 'key', data: 'x' }), 150)
    await quiet.until(() => quiet.closed === 'idle', 3000)
    expect(typing.closed).toBeUndefined()
    clearInterval(typed)
    await typing.until(() => typing.closed === 'idle', 3000)
    await stopAll([quiet, typing])
    expect(booted.core.views.snapshot()).toEqual([])
    expect(booted.core.viewSockets()).toBe(0)
  })

  test('the doctor lists the open views by view, person and age, never their content; only the owner may ask', async () => {
    const c = await open('dee', 'ld.tick')
    await c.until(() => c.frames > 0)
    const check = await viewsCheck({
      env: { KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' },
    })
    expect(check.level).toBe('ok')
    expect(check.hint).toContain('1 open: ld.tick for')
    expect(check.hint).toContain(ids.dee as string)
    expect(check.hint).not.toContain('tick 0')
    // a member cannot read the list
    const member = createKeithClient({ baseUrl: booted.url, token: tokens.ana as string })
    await expect(member.rpc.admin.plugins.views.list()).rejects.toThrow()
    await stopAll([c])
  })
})

describe('load', () => {
  test('ten views at once are paced, a reader that never reads costs the others nothing, and the eleventh is refused', async () => {
    // 3 + 3 + 3 + 1 viewers: the caps (3 per person, 10 in all) are reached exactly
    const conns: Conn[] = []
    for (const who of ['owner', 'owner', 'owner', 'ana', 'ana', 'ana', 'cy', 'cy', 'cy', 'dee'])
      conns.push(await open(who, 'ld.tick'))
    const stopKeys = keepAlive(conns)
    await Promise.all(conns.map((c) => c.until(() => c.frames > 0)))
    expect(booted.core.views.snapshot()).toHaveLength(10)
    const extra = await open('fay', 'ld.tick')
    await extra.until(() => extra.closed !== undefined)
    expect(extra.closed).toBe('limit')

    // the event loop keeps turning under ten 5 ms tickers: measure its worst delay
    let worst = 0
    let last = performance.now()
    const probe = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last - 10)
      last = now
    }, 10)
    const before = conns.map((c) => c.frames)
    await Bun.sleep(1500)
    clearInterval(probe)
    stopKeys()
    const rates = conns.map((c, i) => (c.frames - (before[i] ?? 0)) / 1.5)
    // paced at 8 a second, whatever the 5 ms tickers do (a little slack for the first frames and timers)
    for (const r of rates) expect(r).toBeLessThanOrEqual(12)
    for (const r of rates) expect(r).toBeGreaterThan(2)
    expect(worst).toBeLessThan(400)
    await stopAll(conns)
    expect(booted.core.views.snapshot()).toEqual([])
    expect(booted.core.viewSockets()).toBe(0)
  })

  test('frames of 30 KB come in parts, and a reader that does not read never makes the core buffer without bound', async () => {
    // a TCP client that upgrades, says hello and then never reads again
    const url = new URL(booted.url)
    const key = btoa('0123456789abcdef')
    /** A masked text frame of a client (a client must mask); short messages only. */
    const masked = (message: unknown): Uint8Array => {
      const mask = new Uint8Array([1, 2, 3, 4])
      const payload = new TextEncoder().encode(JSON.stringify(message))
      if (payload.length >= 126) throw new Error('short messages only')
      const out = new Uint8Array(6 + payload.length)
      out[0] = 0x81
      out[1] = 0x80 | payload.length
      out.set(mask, 2)
      payload.forEach((b, i) => {
        out[6 + i] = b ^ (mask[i % 4] as number)
      })
      return out
    }
    const frame = masked({
      v: 1,
      type: 'hello',
      viewId: 'ld.heavy',
      cols: 100,
      rows: 200,
      colorDepth: 24,
    })
    let stuckKeys: ReturnType<typeof setInterval> | undefined
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port: Number(url.port),
      socket: {
        data() {},
        open(s) {
          s.write(
            `GET /plugins/views/ws HTTP/1.1\r\nHost: localhost:${url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${tokens.dee}\r\n\r\n`,
          )
          // after the upgrade has been answered, never glued to the request
          setTimeout(() => s.write(frame), 50)
          // read the answer, then never read again: the core's frames pile up behind this socket
          setTimeout(() => s.pause(), 200)
          // it types now and then (writing is not reading), so the idle limit does not close it
          stuckKeys = setInterval(() => s.write(masked({ type: 'key', data: 'x' })), 200)
        },
      },
    })
    // a reader that does read, at the same time
    const fast = await open('cy', 'ld.tick')
    const stopFast = keepAlive([fast])
    await fast.until(() => fast.frames > 0)
    const start = fast.frames
    await Bun.sleep(3000)
    // the fast reader is not slowed by the stuck one
    expect((fast.frames - start) / 3).toBeGreaterThanOrEqual(4)
    expect(booted.core.views.snapshot().some((v) => v.viewId === 'ld.heavy')).toBe(true)
    stopFast()
    clearInterval(stuckKeys)
    socket.end()
    await stopAll([fast])
    expect(booted.core.views.snapshot()).toEqual([])
  })
})
