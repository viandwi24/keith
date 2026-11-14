/**
 * The leak gate of guest mode (docs/specs/guests.md, "Invariants"; ADR-0017 point 9): a visitor types a runtime-built
 * sentinel and the model answers with it, then the session ends in each way a session can end, and after each one
 * NOTHING of it may remain: not in any row of any SQLite table, not in the WAL, not in any file of the data directory.
 * The only durable trace is the one aggregate audit row (its exact field list is asserted) and ledger amounts.
 * The clock of the sessions is fake, so idle and absolute expiry need no waiting.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type GuestEndReason,
  GuestEndReasonSchema,
  GuestSessionAuditSchema,
  GuestStartResponseSchema,
} from '@keith/contracts'
import { openDatabase, type Sqlite } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { until } from './testing/wait.ts'

const PORT = 7421
const LOOPBACK = '127.0.0.1'
// built at runtime (never a literal): typed by the visitor and echoed by the model
const sentinel = `zq${crypto.randomUUID().replaceAll('-', '')}`
const step = { text: `you said ${sentinel}`, usage: { inputTokens: 80, outputTokens: 40 } }
const AUDIT_FIELDS = Object.keys(GuestSessionAuditSchema.shape).sort()

const clock = { now: Date.now() }
const MIN = 60_000

interface Rig {
  booted: BootedCore
  db: Sqlite
  dbFile: string
}

async function boot(): Promise<Rig> {
  const booted = await bootCore(
    {},
    {
      guestClock: () => clock.now,
      timing: { guestGraceMs: 60 },
      definitions: [
        scriptedProvider({
          id: 'pricey',
          // a short delay on every turn, so a request can be cut while the model is answering
          models: { cheap: Array.from({ length: 120 }, () => ({ ...step, delayMs: 120 })) },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  const config = loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' })
  const owner = booted.local.rpc
  await owner.providers.put({ providerId: 'pricey' })
  await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  await owner.admin.guests.set({
    enabled: true,
    zones: ['loopback'],
    maxConcurrent: 20,
    sessionsPerIpPerWindow: 100,
  })
  return { booted, db: openDatabase(config.dbFile), dbFile: config.dbFile }
}

const peer = (address: string) =>
  ({ requestIP: () => ({ address }), timeout: () => undefined, port: PORT }) as never
function call(
  rig: Rig,
  path: string,
  init: { body?: unknown; token?: string; method?: string; ip?: string; signal?: AbortSignal } = {},
) {
  return rig.booted.core.guestHttp.fetch(
    new Request(`http://127.0.0.1:${PORT}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    }),
    peer(init.ip ?? LOOPBACK),
  )
}
type Started = { sessionId: string; token: string }
const start = async (rig: Rig, ip = LOOPBACK): Promise<Started> => {
  const res = await call(rig, '/guest/session', { body: {}, ip })
  if (res.status !== 201) throw new Error(`start refused: ${res.status} ${await res.text()}`)
  return GuestStartResponseSchema.parse(await res.json())
}
const typed = (text: string) => ({
  trigger: 'submit-message',
  messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
})
const chat = (rig: Rig, s: Started, text: string, signal?: AbortSignal) =>
  call(rig, `/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`, {
    token: s.token,
    body: { id: s.sessionId, ...typed(text) },
    ...(signal === undefined ? {} : { signal }),
  })
const say = async (rig: Rig, s: Started, text = `my secret is ${sentinel}`) => {
  const res = await chat(rig, s, text)
  expect(res.status).toBe(200)
  // the model's reply carries the sentinel too
  expect(await res.text()).toContain(sentinel)
}
const idOf = (s: Started): string => s.sessionId.slice('guest:'.length)

/** Every row of every table, as text (the whole database, virtual and shadow tables included). */
function dump(db: Sqlite): { text: string; tables: number } {
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
  const text = names
    .map((t) => {
      try {
        return JSON.stringify(db.query(`SELECT * FROM "${t.name}"`).all())
      } catch {
        return ''
      }
    })
    .join('\n')
  return { text, tables: names.length }
}

/** Every file under a directory that holds `needle` (the database file and its WAL included; sockets skipped). */
function scanFiles(root: string, needle: string): { hits: string[]; scanned: string[] } {
  const hits: string[] = []
  const scanned: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else if (info.isSocket()) continue
      else {
        scanned.push(path)
        if (readFileSync(path).includes(needle)) hits.push(path)
      }
    }
  }
  walk(root)
  return { hits, scanned }
}

const scans: Array<{ what: string; tables: number; files: number }> = []

/** The whole check, with what it covered, so a vacuous scan is a failure. */
function assertNothingRemains(rig: Rig, what: string): { tables: number; files: number } {
  const { text, tables } = dump(rig.db)
  expect(tables, `${what}: tables scanned`).toBeGreaterThan(20)
  expect(text, `${what}: a table holds the sentinel`).not.toContain(sentinel)
  expect(text, `${what}: a table holds the model reply`).not.toContain(`you said ${sentinel}`)
  const { hits, scanned } = scanFiles(rig.booted.dir, sentinel)
  expect(scanned.length, `${what}: files scanned`).toBeGreaterThan(0)
  expect(hits, `${what}: files holding the sentinel`).toEqual([])
  scans.push({ what, tables, files: scanned.length })
  return { tables, files: scanned.length }
}

/** The `guest.session.end` rows, straight from the audit table (works after the core closed too). */
function endRows(rig: Rig) {
  return rig.db
    .query<{ actor: string; detail: string }, []>(
      "SELECT actor, detail FROM audit_events WHERE kind = 'guest.session.end' ORDER BY at, id",
    )
    .all()
    .map((r) => ({ actor: r.actor, detail: JSON.parse(r.detail) as Record<string, unknown> }))
}

/** One new row, exactly the allowed fields, no text, with this reason. */
function assertOneNewRow(rig: Rig, before: number, reason: GuestEndReason) {
  const rows = endRows(rig)
  expect(rows).toHaveLength(before + 1)
  const row = rows[before]
  expect(Object.keys(row?.detail ?? {}).sort()).toEqual(AUDIT_FIELDS)
  const parsed = GuestSessionAuditSchema.parse(row?.detail)
  expect(parsed.reason).toBe(reason)
  expect(parsed.turns).toBeGreaterThanOrEqual(1)
  expect(row?.actor).toBe(`guest:${parsed.guestId}`)
  expect(JSON.stringify(row)).not.toContain(sentinel)
  expect(parsed.ipHash).toMatch(/^[0-9a-f]{12}$/)
  return parsed
}

let rig: Rig
beforeAll(async () => {
  rig = await boot()
})
afterAll(async () => {
  rig.db.close()
  await rig.booted.stop()
})

describe('the scan itself', () => {
  test('control: a durable owner setting IS found, in a table and in a file, so an empty scan means something', async () => {
    const control = `control${crypto.randomUUID().replaceAll('-', '')}.example`
    await rig.booted.local.rpc.admin.guests.set({ hosts: [control] })
    expect(dump(rig.db).text).toContain(control)
    expect(scanFiles(rig.booted.dir, control).hits.length).toBeGreaterThan(0)
    await rig.booted.local.rpc.admin.guests.set({ hosts: [] })
    // the database is in WAL mode, so the WAL file is among the files scanned
    expect(
      rig.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
    ).toBe('wal')
    expect(scanFiles(rig.booted.dir, 'x').scanned.some((f) => f.endsWith('-wal'))).toBe(true)
  })
})

describe('the sentinel after every way a session can end (live core)', () => {
  test('while the session is live nothing durable holds it either', async () => {
    const s = await start(rig)
    await say(rig, s)
    assertNothingRemains(rig, 'live')
    // the owner sees the live text only through peek, never from a store
    const peeked = await rig.booted.local.rpc.admin.guests.peek({ id: idOf(s) })
    expect(JSON.stringify(peeked)).toContain(sentinel)
    assertNothingRemains(rig, 'after a peek')
    await call(rig, `/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })

  test('the visitor ends the chat (DELETE): closed', async () => {
    const before = endRows(rig).length
    const s = await start(rig)
    await say(rig, s)
    const del = await call(rig, `/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
    expect(del.status).toBe(200)
    await rig.booted.core.guestAudit.flush()
    assertOneNewRow(rig, before, 'closed')
    expect(rig.booted.core.guests.size).toBe(0)
    assertNothingRemains(rig, 'closed')
  })

  test('idle expiry: no traffic for the idle limit', async () => {
    const before = endRows(rig).length
    const s = await start(rig)
    await say(rig, s)
    clock.now += 31 * MIN
    expect(await rig.booted.core.guests.sweep()).toBe(1)
    await rig.booted.core.guestAudit.flush()
    assertOneNewRow(rig, before, 'idle')
    expect(rig.booted.core.guests.size).toBe(0)
    assertNothingRemains(rig, 'idle')
  })

  test('absolute expiry: a chat that keeps talking still ends at the absolute limit', async () => {
    const before = endRows(rig).length
    const s = await start(rig)
    await say(rig, s)
    for (let i = 0; i < 4; i++) {
      clock.now += 25 * MIN // inside the idle limit each time, so only the absolute limit can end it
      await rig.booted.core.guests.sweep()
      expect(rig.booted.core.guests.size).toBe(1)
      await say(rig, s, `still here ${sentinel}`)
    }
    clock.now += 25 * MIN // 125 minutes in
    expect(await rig.booted.core.guests.sweep()).toBe(1)
    await rig.booted.core.guestAudit.flush()
    assertOneNewRow(rig, before, 'absolute')
    assertNothingRemains(rig, 'absolute')
  })

  test('turn cap: the last allowed message closes the chat', async () => {
    await rig.booted.local.rpc.admin.guests.set({ maxTurns: 1 })
    const before = endRows(rig).length
    const s = await start(rig)
    await say(rig, s)
    await until(
      'turn-cap end',
      () => rig.booted.core.guests.size,
      (n) => n === 0,
    )
    await rig.booted.core.guestAudit.flush()
    assertOneNewRow(rig, before, 'turn-cap')
    assertNothingRemains(rig, 'turn-cap')
    await rig.booted.local.rpc.admin.guests.set({ maxTurns: 20 })
  })

  test('kill switch: every session ends at once and the sentinel goes with it', async () => {
    const before = endRows(rig).length
    const a = await start(rig)
    const b = await start(rig)
    await say(rig, a)
    await say(rig, b)
    expect(await rig.booted.local.rpc.admin.guests.killswitch({ on: true })).toEqual({ ended: 2 })
    await rig.booted.core.guestAudit.flush()
    const rows = endRows(rig)
    expect(rows).toHaveLength(before + 2)
    for (const row of rows.slice(before)) {
      expect(Object.keys(row.detail).sort()).toEqual(AUDIT_FIELDS)
      expect(row.detail.reason).toBe('killed')
    }
    // both bearers are dead and a new start is refused
    expect((await chat(rig, a, 'hi')).status).toBe(410)
    expect((await call(rig, '/guest/session', { body: {} })).status).toBe(403)
    assertNothingRemains(rig, 'kill switch')
    await rig.booted.local.rpc.admin.guests.set({ enabled: true })
  })

  test('abrupt disconnect: the request is cut mid-answer, nothing ends it but the idle limit', async () => {
    const before = endRows(rig).length
    const s = await start(rig)
    const cut = new AbortController()
    const pending = chat(rig, s, `my secret is ${sentinel}`, cut.signal)
    await Bun.sleep(40)
    cut.abort()
    await pending.then(
      (res) => res.body?.cancel(),
      () => undefined,
    )
    // the visitor is gone without a DELETE: the session is still in memory only
    assertNothingRemains(rig, 'abrupt disconnect, before the sweep')
    // the turn the visitor walked away from still finishes (it is billed), then nothing is running
    await until(
      'the cut turn settled',
      async () => (await rig.booted.local.rpc.admin.guests.list())[0]?.costUsd ?? 0,
      (cost) => cost > 0,
    )
    clock.now += 31 * MIN
    expect(await rig.booted.core.guests.sweep()).toBe(1)
    await rig.booted.core.guestAudit.flush()
    const row = endRows(rig).at(before)
    expect(row?.detail.reason).toBe('idle')
    expect(Object.keys(row?.detail ?? {}).sort()).toEqual(AUDIT_FIELDS)
    assertNothingRemains(rig, 'abrupt disconnect')
  })

  test('every end reason was exercised and each wrote one row of the allowed shape', () => {
    const reasons = new Set(endRows(rig).map((r) => r.detail.reason))
    expect([...reasons].sort()).toEqual(
      GuestEndReasonSchema.options.filter((r) => r !== 'cost-cap' && r !== 'restart').sort(),
    )
    expect(endRows(rig).every((r) => GuestSessionAuditSchema.safeParse(r.detail).success)).toBe(
      true,
    )
    // what the scans covered: each looked at every table of the database and every file of the data folder
    expect(scans.length).toBeGreaterThanOrEqual(8)
    expect(Math.min(...scans.map((x) => x.tables))).toBeGreaterThan(40)
    expect(Math.min(...scans.map((x) => x.files))).toBeGreaterThanOrEqual(3)
  })
})

describe('the sentinel after the cost cap and after a graceful stop (a core of its own)', () => {
  test('cost cap: a turn stopped by the budget ends the session and leaves nothing', async () => {
    const own = await boot()
    try {
      await own.booted.local.rpc.admin.guests.set({ dailyUsd: 0.0006 })
      const before = endRows(own).length
      const s = await start(own)
      // the daily budget of the guests runs out after two answers: the next turn stops on it
      for (let i = 0; i < 5 && own.booted.core.guests.size === 1; i++) {
        const res = await chat(own, s, `my secret is ${sentinel}`)
        await res.text()
      }
      await until(
        'cost-cap end',
        () => own.booted.core.guests.size,
        (n) => n === 0,
      )
      await own.booted.core.guestAudit.flush()
      assertOneNewRow(own, before, 'cost-cap')
      assertNothingRemains(own, 'cost cap')
    } finally {
      own.db.close()
      await own.booted.stop()
    }
  })

  test('graceful stop (restart): a live session is ended by core.close() with one row, and the closed data dir holds nothing', async () => {
    const own = await boot()
    const dir = own.booted.dir
    const s = await start(own)
    await say(own, s)
    // a second visitor is mid-answer when the core stops
    const mid = chat(own, await start(own), `my secret is ${sentinel}`)
    await Bun.sleep(40)
    await own.booted.core.close()
    await mid.then(
      (res) => res.body?.cancel(),
      () => undefined,
    )
    const rows = endRows(own)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(Object.keys(row.detail).sort()).toEqual(AUDIT_FIELDS)
      expect(row.detail.reason).toBe('restart')
    }
    // the core is closed: nothing can be holding it in memory for the files, and the files hold nothing
    const { hits, scanned } = scanFiles(dir, sentinel)
    expect(scanned.length).toBeGreaterThan(0)
    expect(hits).toEqual([])
    expect(dump(own.db).text).not.toContain(sentinel)
    own.db.close()
    // the rig's servers still listen: stop them, then remove the folder (core.close() ran already)
    await own.booted.stop().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the owner floor, over HTTP', () => {
  test('guest spend also counts on the owner budget; under a quarter left, entry is refused with no owner detail', async () => {
    const own = await boot()
    try {
      const guestTurn = async (): Promise<void> => {
        const s = await start(own)
        await say(own, s)
        await call(own, `/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
          method: 'DELETE',
          token: s.token,
        })
      }
      await guestTurn()
      await guestTurn()
      // the guests spent from the owner's own budget too (the `owner` scope): about 20 percent is left of this limit
      const spent = (await own.booted.local.rpc.budget.get()).spentUsd
      expect(spent).toBeGreaterThan(0)
      await own.booted.local.rpc.budget.set({ limitUsd: spent * 1.2 })
      const refused = await call(own, '/guest/session', { body: {} })
      expect(refused?.status).toBe(503)
      const body = await refused?.text()
      expect(body).toContain('GUEST_UNAVAILABLE')
      for (const word of ['owner', 'floor', 'budget', 'USD', 'remaining'])
        expect(body).not.toContain(word)
      // and the public status says only "not available"
      const status = (await (await call(own, '/guest/status')).json()) as { available: boolean }
      expect(status.available).toBe(false)
    } finally {
      own.db.close()
      await own.booted.stop()
    }
  })
})

describe('abuse limits with a fake clock', () => {
  test('the per-address window: over the limit is 429, and it opens again after the window', async () => {
    const r = rig
    await r.booted.local.rpc.admin.guests.set({ sessionsPerIpPerWindow: 2, enabled: true })
    const ip = LOOPBACK
    const a = await start(r, ip)
    const b = await start(r, ip)
    const third = await call(r, '/guest/session', { body: {}, ip })
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    clock.now += 9 * MIN
    expect((await call(r, '/guest/session', { body: {}, ip })).status).toBe(429)
    clock.now += 2 * MIN // past the ten-minute window
    const again = await call(r, '/guest/session', { body: {}, ip })
    expect(again.status).toBe(201)
    for (const s of [a, b, GuestStartResponseSchema.parse(await again.json())])
      await call(r, `/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: 'DELETE',
        token: s.token,
      })
    await r.booted.local.rpc.admin.guests.set({ sessionsPerIpPerWindow: 100 })
  })

  test('concurrency: 30 parallel starts yield at most maxConcurrent sessions', async () => {
    const r = rig
    await r.booted.local.rpc.admin.guests.set({ maxConcurrent: 3 })
    const results = await Promise.all(
      Array.from({ length: 30 }, () => call(r, '/guest/session', { body: {} })),
    )
    const ok = results.filter((res) => res.status === 201)
    expect(ok).toHaveLength(3)
    expect(results.filter((res) => res.status === 429)).toHaveLength(27)
    for (const res of ok) {
      const s = GuestStartResponseSchema.parse(await res.json())
      await call(r, `/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: 'DELETE',
        token: s.token,
      })
    }
    await r.booted.local.rpc.admin.guests.set({ maxConcurrent: 20 })
  })
})
