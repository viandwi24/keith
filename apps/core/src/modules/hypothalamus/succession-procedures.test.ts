import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'
import { heirViewOf } from './succession-procedures.ts'
import { GRACE_MS } from './succession-shared.ts'

// The `admin.succession` procedures over a real core (succession.md, "RPC"): the owner's view and changes, the heir's
// view, a member's refusal, the step-up over TCP, the refusals of bad input and the audit rows. The claim is P29.3.2.

let b: BootedCore
let db: Sqlite
let ownerId: string
let anaId: string
let ownerToken: string
let ownerTcp: ReturnType<BootedCore['tcp']>
let anaTcp: ReturnType<BootedCore['tcp']>

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  ownerId = (await b.local.rpc.admin.people.get({ person: 'owner' })).id
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.add({ username: 'bo' })
  anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  await b.local.rpc.admin.people.setPin({ person: 'ana', pin: '730416' })
  const owner = await createCredential(credentialsRepo(db), {
    personId: ownerId,
    kind: 'token',
    label: 'owner-succession',
  })
  ownerToken = owner.token
  ownerTcp = b.tcp(owner.token)
  const ana = await createCredential(credentialsRepo(db), {
    personId: anaId,
    kind: 'token',
    label: 'ana-succession',
  })
  anaTcp = b.tcp(ana.token)
})
afterAll(async () => {
  db.close()
  await b.stop()
})

/** The refusal of a call as its RPC code and the machine reason (`data.reason`) it carries. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )

const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

/** The owner view of `get` (the tests run as the owner; the union narrows to it here). */
const ownerView = async () => {
  const view = await b.local.rpc.admin.succession.get()
  if (view.role !== 'owner') throw new Error('expected the owner view')
  return view
}

describe('admin.succession: the owner', () => {
  test('the owner reads the owner view: no heir, the default window, no run', async () => {
    const view = await b.local.rpc.admin.succession.get()
    expect(view).toMatchObject({
      role: 'owner',
      state: 'idle',
      heir: null,
      windowDays: 14,
      pausedUntil: null,
      runId: null,
      startedAt: null,
      graceStartedAt: null,
      claimableAt: null,
    })
  })

  test('a member who is not the heir gets NOT_FOUND on get and FORBIDDEN on every change', async () => {
    expect(await refusal(anaTcp.rpc.admin.succession.get())).toBe('NOT_FOUND')
    expect(await refusal(anaTcp.rpc.admin.succession.setHeir({ person: 'ana' }))).toBe('FORBIDDEN')
    expect(await refusal(anaTcp.rpc.admin.succession.clearHeir())).toBe('FORBIDDEN')
    expect(await refusal(anaTcp.rpc.admin.succession.setWindow({ days: 7 }))).toBe('FORBIDDEN')
    expect(
      await refusal(anaTcp.rpc.admin.succession.pause({ until: Date.now() + 3_600_000 })),
    ).toBe('FORBIDDEN')
    expect(await refusal(anaTcp.rpc.admin.succession.resume())).toBe('FORBIDDEN')
    expect((await ownerView()).heir).toBeNull()
  })

  test('a change over TCP needs a step-up; with it the heir is named and the owner view shows her', async () => {
    expect(await refusal(ownerTcp.rpc.admin.succession.setHeir({ person: 'ana' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, ownerToken)
    const view = await ownerTcp.rpc.admin.succession.setHeir({ person: 'ana' })
    expect(view.role).toBe('owner')
    expect(view.heir).toEqual({ id: anaId, name: expect.any(String) })
    expect((await ownerView()).heir?.id).toBe(anaId)
  })

  test('a bad heir is refused with its reason and nothing changes', async () => {
    expect(await refusal(b.local.rpc.admin.succession.setHeir({ person: 'owner' }))).toBe(
      'BAD_REQUEST:owner',
    )
    // bo has no password or PIN (F-013)
    expect(await refusal(b.local.rpc.admin.succession.setHeir({ person: 'bo' }))).toBe(
      'BAD_REQUEST:no-secret',
    )
    expect(await refusal(b.local.rpc.admin.succession.setHeir({ person: 'nobody' }))).toBe(
      'NOT_FOUND',
    )
    expect((await ownerView()).heir?.id).toBe(anaId)
  })

  test('bad input is BAD_REQUEST: the window range, a pause in the past or longer than 180 days', async () => {
    expect(await refusal(b.local.rpc.admin.succession.setWindow({ days: 6 }))).toBe('BAD_REQUEST')
    expect(await refusal(b.local.rpc.admin.succession.setWindow({ days: 91 }))).toBe('BAD_REQUEST')
    expect(await refusal(b.local.rpc.admin.succession.pause({ until: Date.now() - 1000 }))).toBe(
      'BAD_REQUEST',
    )
    expect(
      await refusal(b.local.rpc.admin.succession.pause({ until: Date.now() + 181 * 86_400_000 })),
    ).toBe('BAD_REQUEST')
    expect((await ownerView()).windowDays).toBe(14)
  })

  test('the window, the pause and the resume change the view and are audited', async () => {
    const view = await ownerTcp.rpc.admin.succession.setWindow({ days: 10 })
    expect(view.windowDays).toBe(10)
    expect((await events('owner.succession.window'))[0]?.detail).toMatchObject({
      from: 14,
      to: 10,
    })

    const until = Date.now() + 2 * 86_400_000
    const paused = await ownerTcp.rpc.admin.succession.pause({ until })
    expect(paused.pausedUntil).toBe(until)
    expect((await events('owner.succession.pause'))[0]?.detail).toMatchObject({ until })

    const resumed = await ownerTcp.rpc.admin.succession.resume()
    expect(resumed.pausedUntil).toBeNull()
    expect((await events('owner.succession.resume')).length).toBe(1)
  })

  test('the heir view: the state and the claim dates only, for the heir alone', async () => {
    const view = await anaTcp.rpc.admin.succession.get()
    expect(view).toEqual({ role: 'heir', state: 'idle', claimableAt: null, claimOpensAt: null })
    expect(Object.keys(view).sort()).toEqual(['claimOpensAt', 'claimableAt', 'role', 'state'])
  })

  test('claimOpensAt: the grace end in grace, the claim date in claimable, null otherwise', () => {
    const at = 1_700_000_000_000
    const run = (state: string, graceStartedAt: number | null, claimableAt: number | null) =>
      ({ run: { state, graceStartedAt, claimableAt } }) as unknown as Parameters<
        typeof heirViewOf
      >[0]
    expect(heirViewOf(run('grace', at, null)).claimOpensAt).toBe(at + GRACE_MS)
    expect(heirViewOf(run('claimable', at, at + GRACE_MS)).claimOpensAt).toBe(at + GRACE_MS)
    expect(heirViewOf(run('check-in', null, null)).claimOpensAt).toBeNull()
    expect(heirViewOf(run('claimed', at, at)).claimOpensAt).toBeNull()
    expect(heirViewOf(run('idle', null, null))).toEqual({
      role: 'heir',
      state: 'idle',
      claimableAt: null,
      claimOpensAt: null,
    })
  })

  test('clearing the heir removes it, and the owner view and the audit row say so', async () => {
    const view = await ownerTcp.rpc.admin.succession.clearHeir()
    expect(view.heir).toBeNull()
    expect((await events('owner.heir.clear'))[0]?.detail).toMatchObject({
      heir: anaId,
      reason: 'owner',
    })
    expect(await refusal(anaTcp.rpc.admin.succession.get())).toBe('NOT_FOUND')
    expect((await events('owner.heir.set'))[0]?.detail).toMatchObject({
      heir: anaId,
      owner: ownerId,
    })
  })

  test('the claim over the local socket is FORBIDDEN (the heir claims over TCP with a credential)', async () => {
    expect(await refusal(b.local.rpc.admin.succession.claim({}))).toBe('FORBIDDEN')
  })
})
