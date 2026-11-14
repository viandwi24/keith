import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'

// `nodes.settings.get|set` over a real core (node-drivers.md "Settings"): the owner changes the sandbox calls per hour with a
// step-up over TCP, the bounds are checked, a member is refused, and the change is audited as `settings.nodes.set` with from and to.
let b: BootedCore
let db: Sqlite

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
})
afterAll(async () => {
  db.close()
  await b.stop()
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('nodes.settings', () => {
  test('the default is 60; the owner sets it and one audit row records from and to', async () => {
    expect(await b.local.rpc.nodes.settings.get()).toEqual({ maxPerHourPerPerson: 60 })
    const before = (await events('settings.nodes.set')).length
    const after = await b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: 5 })
    expect(after).toEqual({ maxPerHourPerPerson: 5 })
    expect(await b.local.rpc.nodes.settings.get()).toEqual(after)
    const rows = await events('settings.nodes.set')
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)?.detail).toEqual({
      from: { maxPerHourPerPerson: 60 },
      to: { maxPerHourPerPerson: 5 },
    })
  })

  test('out-of-bound and non-integer values are BAD_REQUEST and nothing moves or is audited', async () => {
    const before = (await events('settings.nodes.set')).length
    for (const bad of [0, 1001, 2.5, -1]) {
      expect(await code(b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: bad }))).toBe(
        'BAD_REQUEST',
      )
    }
    expect((await b.local.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(5)
    expect((await events('settings.nodes.set')).length).toBe(before)
  })

  test('the bounds 1 and 1000 are accepted', async () => {
    expect(
      (await b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: 1000 })).maxPerHourPerPerson,
    ).toBe(1000)
    expect(
      (await b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: 1 })).maxPerHourPerPerson,
    ).toBe(1)
    await b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: 60 })
  })

  test('a member reads the setting and cannot set it; the owner over TCP needs a step-up', async () => {
    const ana = await b.local.rpc.admin.people.get({ person: 'ana' })
    const { token: anaToken } = await createCredential(credentialsRepo(db), {
      personId: ana.id,
      kind: 'token',
      label: 'member',
    })
    const member = b.tcp(anaToken)
    expect((await member.rpc.nodes.settings.get()).maxPerHourPerPerson).toBe(60)
    expect(await code(member.rpc.nodes.settings.set({ maxPerHourPerPerson: 3 }))).toBe('FORBIDDEN')

    const owner = await b.local.rpc.admin.people.get({ person: 'owner' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: owner.id,
      kind: 'token',
      label: 'owner-tcp',
    })
    const tcp = b.tcp(token)
    expect(await code(tcp.rpc.nodes.settings.set({ maxPerHourPerPerson: 3 }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, token)
    expect(await code(tcp.rpc.nodes.settings.set({ maxPerHourPerPerson: 3 }))).toBe('ok')
    await b.local.rpc.nodes.settings.set({ maxPerHourPerPerson: 60 })
  })
})
