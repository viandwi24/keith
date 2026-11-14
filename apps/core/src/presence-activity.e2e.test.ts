/**
 * P27.2.3: a message a person sends writes one `activity` signal for that person (the thalamus `chat.validate` hook), so
 * presence turns active. A guest's message writes none (docs/specs/parietal.md, "Signals and computation"; thalamus.md).
 * Real core, scripted models; the signals are read from the database file the core writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { GuestStartResponseSchema } from '@keith/contracts'
import { openDatabase } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { cleanup, send, stop } from './testing/core-harness.ts'
import { type Scenario, scenario } from './testing/scenario-harness.ts'

afterAll(cleanup)

/** Count of the `activity` signals of a person, read from the core's database file. */
const activityOf = (dataDir: string, personId: string): number => {
  const db = openDatabase(join(dataDir, 'keith.db'))
  try {
    return (
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM presence_signals WHERE person_id = ? AND type = 'activity'",
        )
        .get(personId)?.n ?? 0
    )
  } finally {
    db.close()
  }
}

describe('the activity signal of a sent message', () => {
  let s: Scenario

  beforeAll(async () => {
    s = await scenario({ front: [{ text: 'one' }, { text: 'two' }] as never })
  })
  afterAll(async () => {
    await stop(s.r)
  })

  test('before any message the owner is offline; each message writes one activity signal', async () => {
    expect(activityOf(s.dataDir, 'owner')).toBe(0)
    expect((await s.r.client.rpc.presence.mine()).presence.state).toBe('offline')

    await send(s.r.client, 'hello')
    expect(activityOf(s.dataDir, 'owner')).toBe(1)
    expect((await s.r.client.rpc.presence.mine()).presence.state).toBe('active')

    await send(s.r.client, 'and again')
    expect(activityOf(s.dataDir, 'owner')).toBe(2)
  })
})

describe('a guest message', () => {
  let booted: BootedCore
  const step = { text: 'hi', usage: { inputTokens: 80, outputTokens: 40 } }

  beforeAll(async () => {
    booted = await bootCore(
      {},
      {
        timing: { guestGraceMs: 20 },
        definitions: [
          scriptedProvider({
            id: 'pricey',
            models: { cheap: Array.from({ length: 4 }, () => step) },
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

  test('writes no signal for anybody', async () => {
    const peer = {
      requestIP: () => ({ address: '127.0.0.1' }),
      timeout: () => undefined,
      port: 7422,
    } as never
    const call = (path: string, init: { body?: unknown; token?: string } = {}) =>
      booted.core.guestHttp.fetch(
        new Request(`http://127.0.0.1:7422${path}`, {
          method: init.body === undefined ? 'GET' : 'POST',
          headers: {
            host: '127.0.0.1:7422',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
        peer,
      )
    const started = GuestStartResponseSchema.parse(
      await (await call('/guest/session', { body: {} })).json(),
    )
    const res = await call(`/guest/sessions/${encodeURIComponent(started.sessionId)}/chat`, {
      token: started.token,
      body: {
        id: started.sessionId,
        messages: [
          { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ],
      },
    })
    await res.text()
    expect(res.status).toBe(200)
    const db = openDatabase(join(booted.dir, 'keith.db'))
    try {
      expect(
        db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM presence_signals').get()?.n,
      ).toBe(0)
    } finally {
      db.close()
    }
  })
})
