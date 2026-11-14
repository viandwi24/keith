/**
 * What a guest leaves behind in a booted core (docs/specs/guests.md, "Recording and audit"): one aggregate audit row
 * per ended session with only the allowed fields, one row per address hash per minute for refusals, one cap notice
 * on the owner's feed, and nothing of the text, the address or the user agent anywhere in the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  GUEST_CAP_EVENT,
  GuestSessionAuditSchema,
  GuestStartResponseSchema,
} from '@keith/contracts'
import { openDatabase, type Sqlite } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

const sentinel = `zq${crypto.randomUUID().replaceAll('-', '')}`
const userAgent = `ua-${crypto.randomUUID()}`
const FAR = '203.0.113.77'
const answer = 'fine'
const step = { text: answer, usage: { inputTokens: 80, outputTokens: 40 } }

let booted: BootedCore
let db: Sqlite
beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: { cheap: Array.from({ length: 60 }, () => step) },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
  const owner = booted.local.rpc
  await owner.providers.put({ providerId: 'pricey' })
  await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  await owner.admin.guests.set({
    enabled: true,
    zones: ['loopback'],
    maxConcurrent: 20,
    sessionsPerIpPerWindow: 100,
  })
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

const peer = (address: string) =>
  ({ requestIP: () => ({ address }), timeout: () => undefined, port: 7421 }) as never
const call = (
  path: string,
  ip: string,
  init: { body?: unknown; token?: string; method?: string } = {},
) =>
  booted.core.guestHttp.fetch(
    new Request(`http://127.0.0.1:7421${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: '127.0.0.1:7421',
        'user-agent': userAgent,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    peer(ip),
  )
const start = async (ip = '127.0.0.1') =>
  GuestStartResponseSchema.parse(await (await call('/guest/session', ip, { body: {} })).json())
const chat = (s: { sessionId: string; token: string }, text: string, ip = '127.0.0.1') =>
  call(`/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`, ip, {
    token: s.token,
    body: {
      id: s.sessionId,
      messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
    },
  })
const audit = async (kind: string) =>
  (await booted.local.rpc.admin.audit.list({ limit: 200 })).filter((e) => e.kind === kind)
const allText = (): string =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => JSON.stringify(db.query(`SELECT * FROM "${t.name}"`).all()))
    .join('\n')

describe('what guests leave in the audit log', () => {
  test('a closed session writes one aggregate row; no text, address or user agent', async () => {
    const s = await start()
    const turn = await chat(s, `my secret is ${sentinel}`)
    expect(turn.status).toBe(200)
    await turn.text()
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, '127.0.0.1', {
      method: 'DELETE',
      token: s.token,
    })
    const rows = await audit('guest.session.end')
    expect(rows).toHaveLength(1)
    const detail = GuestSessionAuditSchema.parse(rows[0]?.detail)
    expect(detail).toMatchObject({
      zone: 'loopback',
      reason: 'closed',
      turns: 1,
      clientKind: 'other',
    })
    expect(detail.inputTokens).toBeGreaterThan(0)
    expect(detail.costUsd).toBeGreaterThan(0)
    expect(rows[0]?.actor).toBe(`guest:${detail.guestId}`)
    const wire = JSON.stringify(rows)
    for (const secret of [sentinel, userAgent, '127.0.0.1', answer])
      expect(wire).not.toContain(secret)
    expect(detail.ipHash).toMatch(/^[0-9a-f]{12}$/)
  })

  test('every way a session ends writes its row (idle, kill switch, restart)', async () => {
    const a = await start()
    const b = await start()
    const c = await start()
    await booted.core.guests.end(a.sessionId.slice('guest:'.length), 'idle')
    await booted.local.rpc.admin.guests.end({ id: b.sessionId.slice('guest:'.length) })
    await booted.core.guests.endAll('restart')
    const reasons = (await audit('guest.session.end'))
      .map((r) => (r.detail as { reason: string }).reason)
      .sort()
    expect(reasons).toEqual(['closed', 'idle', 'killed', 'restart'])
    void c
  })

  test('refusals are aggregated per address hash per minute, never with the address', async () => {
    for (let i = 0; i < 3; i++)
      expect((await call('/guest/session', FAR, { body: {} })).status).toBe(403)
    expect(await audit('guest.session.denied')).toHaveLength(0) // the minute is not over
    booted.core.guestAudit.flush(true)
    const rows = await audit('guest.session.denied')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toMatchObject({ count: 3, reasons: { zone: 3 } })
    expect(JSON.stringify(rows)).not.toContain(FAR)
  })

  test('hitting a cap refuses with 429 and tells the owner once, with counts only', async () => {
    const owner = booted.local.rpc
    // spend some of today's money, then lower the day cap below what was spent
    const s = await start()
    await (await chat(s, 'spend')).text()
    await owner.admin.guests.set({ dailyUsd: 0.0001 })
    await Bun.sleep(30)
    let refused = 0
    for (let i = 0; i < 3; i++) {
      const res = await call('/guest/session', '127.0.0.1', { body: {} })
      if (res.status === 429) refused += 1
    }
    expect(refused).toBe(3)
    const events = db
      .query<{ payload: string }, [string]>('SELECT payload FROM events WHERE type = ?')
      .all(GUEST_CAP_EVENT)
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0]?.payload ?? '{}') as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['at', 'cap', 'count'])
    expect(JSON.stringify(payload)).not.toContain(sentinel)
    await owner.admin.guests.set({ dailyUsd: 0.5 })
  })

  test('the sentinel, the address and the user agent are in no table of the database', () => {
    const text = allText()
    expect(text).toContain('guest.session.end') // control: the scan does see the audit rows
    for (const secret of [sentinel, userAgent, FAR, '127.0.0.1']) expect(text).not.toContain(secret)
  })
})
