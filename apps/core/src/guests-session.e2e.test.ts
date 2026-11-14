/**
 * Guest sessions in a booted core (docs/specs/guests.md): a guest agent and the front agent live in one process,
 * the guest turn is charged to the guest scopes only, the owner can list and end it over the socket, and what the
 * guest typed and was answered is in no table and no file of the data directory afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { until } from './testing/wait.ts'

const sentinel = `zq${crypto.randomUUID().replaceAll('-', '')}`
const answer = `rp${crypto.randomUUID().replaceAll('-', '')}`
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
          models: { cheap: Array.from({ length: 50 }, () => step) },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

const allText = (sqlite: Sqlite): string =>
  sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((t) => JSON.stringify(sqlite.query(`SELECT * FROM "${t.name}"`).all()))
    .join('\n')

function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) hits.push(...filesContaining(path, needle))
    else if (statSync(path).isSocket()) continue
    else if (readFileSync(path).includes(needle)) hits.push(path)
  }
  return hits
}

describe('a guest session next to the front agent', () => {
  test('both answer in one core; the guest turn is billed to guest scopes only', async () => {
    const owner = booted.local.rpc
    await owner.providers.put({ providerId: 'scripted' })
    await owner.models.roles.set({ role: 'front', ref: 'scripted:a' })
    await owner.providers.put({ providerId: 'pricey' })
    await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
    await owner.admin.guests.set({ enabled: true })

    const p = await owner.admin.people.get({ person: 'owner' })
    const token = (
      await createCredential(credentialsRepo(db), { personId: p.id, kind: 'token', label: 't' })
    ).token
    const opened = await booted.core.guests.open({ zone: 'lan', ipHash: 'abc123def456' })
    if (!opened.ok) throw new Error(`refused: ${opened.block}`)
    const { session } = opened
    const guestTurn = session.agent
      .session(session.sessionId)
      .send(`my secret is ${sentinel}`).result
    const frontTurn = (async () => {
      for await (const _ of booted.tcp(token).reply('hello')) void _
    })()
    const [guest] = await Promise.all([guestTurn, frontTurn])
    expect(guest.stop).toBe('complete')

    const reservations = db
      .query<{ scopes: string }, []>('SELECT scopes FROM eh_budget_reservation')
      .all()
      .map((r) => JSON.parse(r.scopes) as string[])
    const guestRows = reservations.filter((s) => s.includes('guests'))
    expect(guestRows.length).toBeGreaterThan(0)
    for (const scopes of guestRows) {
      expect(scopes[0]).toBe('owner')
      expect(scopes[1]).toBe('guests')
      expect(scopes[2]).toMatch(/^guests:day:\d{4}-\d{2}-\d{2}$/)
    }
  })

  test('the owner lists the live session without any text and ends it; nothing durable holds the chat', async () => {
    const list = await booted.local.rpc.admin.guests.list()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(sentinel)
    expect(list[0]).toMatchObject({ zone: 'lan', turns: 1 })
    expect((await booted.local.rpc.admin.guests.get()).active).toBe(1)
    // control: the scan sees what the front agent stored, so it would see a guest's text too
    expect(allText(db)).toContain('hello')
    // live: not in the database or any file yet
    expect(allText(db)).not.toContain(sentinel)
    expect(await booted.local.rpc.admin.guests.end({ id: list[0]?.id ?? '' })).toEqual({
      ended: 1,
    })
    await until(
      'session gone',
      () => booted.core.guests.size,
      (n) => n === 0,
    )
    expect(allText(db)).not.toContain(sentinel)
    expect(allText(db)).not.toContain(answer)
    expect(filesContaining(booted.dir, sentinel)).toEqual([])
    expect(filesContaining(booted.dir, answer)).toEqual([])
  })

  test('the kill switch ends sessions of the booted core and refuses new ones', async () => {
    const a = await booted.core.guests.open({ zone: 'lan', ipHash: 'x' })
    expect(a.ok).toBe(true)
    expect(await booted.local.rpc.admin.guests.killswitch({ on: true })).toEqual({ ended: 1 })
    expect(booted.core.guests.size).toBe(0)
    expect(await booted.core.guests.open({ zone: 'lan', ipHash: 'x' })).toEqual({
      ok: false,
      block: 'killed',
    })
  })
})
