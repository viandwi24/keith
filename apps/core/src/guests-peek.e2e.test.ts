/**
 * The owner's peek and the visitor's banner (docs/specs/guests.md, "Peek and banner"): `admin.guests.peek` reads a live
 * session's transcript (owner only, step-up, audited without text), the visitor is told, an ended session is 410 with
 * its reason, and the last allowed message says it is the last.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  GUEST_NOTICE_HEADER,
  GUEST_TURNS_LEFT_HEADER,
  GUEST_WATCHED_HEADER,
  GuestStartResponseSchema,
} from '@keith/contracts'
import { scriptedProvider } from 'eharness/testing'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { issueOwnerToken } from './testing/owner-token.ts'

const sentinel = `zq${crypto.randomUUID().replaceAll('-', '')}`
const reply = `rp${crypto.randomUUID().replaceAll('-', '')}`
const step = { text: reply, usage: { inputTokens: 80, outputTokens: 40 } }

let booted: BootedCore
beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      timing: { guestGraceMs: 20 },
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: { cheap: Array.from({ length: 40 }, () => step) },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  const owner = booted.local.rpc
  await owner.providers.put({ providerId: 'pricey' })
  await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  await owner.admin.guests.set({ enabled: true, zones: ['loopback'], maxTurns: 3 })
})
afterAll(async () => {
  await booted.stop()
})

const peer = () =>
  ({ requestIP: () => ({ address: '127.0.0.1' }), timeout: () => undefined, port: 7421 }) as never
const call = (path: string, init: { body?: unknown; token?: string; method?: string } = {}) =>
  booted.core.guestHttp.fetch(
    new Request(`http://127.0.0.1:7421${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: '127.0.0.1:7421',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    peer(),
  )
const start = async () =>
  GuestStartResponseSchema.parse(await (await call('/guest/session', { body: {} })).json())
const chat = (s: { sessionId: string; token: string }, text: string) =>
  call(`/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`, {
    token: s.token,
    body: {
      id: s.sessionId,
      messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
    },
  })

describe('peek', () => {
  test('the owner reads the live transcript; the visitor is told from then on; the audit row has no text', async () => {
    const s = await start()
    expect(s.notice).toContain('the owner can watch a live session')
    const first = await chat(s, `hello ${sentinel}`)
    expect(first.headers.get(GUEST_NOTICE_HEADER)).toContain('the owner can watch')
    expect(first.headers.get(GUEST_WATCHED_HEADER)).toBeNull()
    expect(first.headers.get(GUEST_TURNS_LEFT_HEADER)).toBe('2')
    await first.text()

    const id = s.sessionId.slice('guest:'.length)
    const before = (await booted.local.rpc.admin.guests.list())[0]?.lastActiveAt
    await Bun.sleep(15)
    const peek = await booted.local.rpc.admin.guests.peek({ id })
    expect(peek.id).toBe(id)
    expect(peek.turns).toBe(1)
    expect(peek.truncated).toBe(false)
    expect(peek.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(peek.messages[0]?.text).toBe(`hello ${sentinel}`)
    expect(peek.messages[1]?.text).toBe(reply)
    // a peek is not traffic: the idle clock does not restart
    expect((await booted.local.rpc.admin.guests.list())[0]?.lastActiveAt).toBe(before)

    const second = await chat(s, 'and again')
    expect(second.headers.get(GUEST_WATCHED_HEADER)).toBe('1')
    expect(second.headers.get(GUEST_TURNS_LEFT_HEADER)).toBe('1')
    await second.text()

    const rows = (await booted.local.rpc.admin.audit.list({ limit: 50 })).filter(
      (e) => e.kind === 'guest.peek',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.detail).toEqual({ guestId: id, messages: 2 })
    expect(JSON.stringify(rows)).not.toContain(sentinel)
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })

  test('a session that is gone cannot be peeked', async () => {
    await expect(booted.local.rpc.admin.guests.peek({ id: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  test('over TCP it needs the owner, and a step-up', async () => {
    const config = loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' })
    const s = await start()
    const id = s.sessionId.slice('guest:'.length)
    const cold = await issueOwnerToken(config, 'cold', { elevated: false })
    await expect(booted.tcp(cold).rpc.admin.guests.peek({ id })).rejects.toBeDefined()
    const warm = await issueOwnerToken(config, 'warm')
    expect((await booted.tcp(warm).rpc.admin.guests.peek({ id })).id).toBe(id)
    // a member without guests.manage is refused
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    const ana = await issueOwnerToken(config, 'ana', {
      personId: (await booted.local.rpc.admin.people.get({ person: 'ana' })).id,
    })
    await expect(booted.tcp(ana).rpc.admin.guests.peek({ id })).rejects.toBeDefined()
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })
})

describe('the last message and the end', () => {
  test('the last allowed message says so, then the session is 410 turn-cap', async () => {
    const s = await start()
    for (const left of ['2', '1', '0']) {
      const res = await chat(s, 'again')
      expect(res.status).toBe(200)
      expect(res.headers.get(GUEST_TURNS_LEFT_HEADER)).toBe(left)
      await res.text()
    }
    await Bun.sleep(80)
    const gone = await chat(s, 'one more')
    expect(gone.status).toBe(410)
    expect(await gone.json()).toMatchObject({
      error: { code: 'GUEST_SESSION_ENDED', details: { reason: 'turn-cap' } },
    })
  })
})
