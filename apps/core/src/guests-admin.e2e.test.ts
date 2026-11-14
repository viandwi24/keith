/**
 * Guest mode, owner surface (docs/specs/guests.md): the settings, the refusals (no model, an unpriced model, the
 * public zone without https), the capability (owner only), step-up and the audit rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, stepUp } from './testing/boot-core.ts'

let booted: BootedCore
let db: Sqlite
beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: { cheap: [{ text: 'x' }], blind: [{ text: 'y' }] },
          info: { cheap: { pricing: { input: 0.1, output: 0.4 } } },
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

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'error'
  }
}
async function bearer(person: string): Promise<string> {
  const p = await booted.local.rpc.admin.people.get({ person })
  return (
    await createCredential(credentialsRepo(db), { personId: p.id, kind: 'token', label: 't' })
  ).token
}

describe('admin.guests', () => {
  test('guests are off by default, lan only, with the ADR caps and nothing open', async () => {
    const status = await booted.local.rpc.admin.guests.get()
    expect(status).toMatchObject({
      killed: false,
      active: 0,
      blocked: 'disabled',
      model: { ref: null, priced: false },
      settings: { enabled: false, zones: ['lan'], dailyUsd: 0.5, monthlyUsd: 5, maxTurns: 20 },
    })
    expect(await booted.local.rpc.admin.guests.list()).toEqual([])
  })

  test('enabling is refused with no guest model, and with a model that has no price', async () => {
    expect(await code(booted.local.rpc.admin.guests.set({ enabled: true }))).toBe('BAD_REQUEST')
    await booted.local.rpc.providers.put({ providerId: 'pricey' })
    await booted.local.rpc.models.roles.set({ role: 'guest', ref: 'pricey:blind' })
    expect(await code(booted.local.rpc.admin.guests.set({ enabled: true }))).toBe('BAD_REQUEST')
    expect((await booted.local.rpc.admin.guests.get()).settings.enabled).toBe(false)
  })

  test('with a priced model it enables, audits before and after, and entry is open', async () => {
    await booted.local.rpc.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
    const status = await booted.local.rpc.admin.guests.set({ enabled: true, maxTurns: 5 })
    expect(status).toMatchObject({
      blocked: null,
      model: { ref: 'pricey:cheap', priced: true },
      settings: { enabled: true, maxTurns: 5 },
    })
    const row = (await booted.local.rpc.admin.audit.list({ limit: 50 })).find(
      (a) => a.kind === 'guest.settings',
    )
    expect(row?.detail).toMatchObject({
      before: { enabled: false, maxTurns: 20 },
      after: { enabled: true, maxTurns: 5 },
    })
  })

  test('bad mixes are refused: idle longer than absolute, public zone without https', async () => {
    expect(
      await code(booted.local.rpc.admin.guests.set({ idleMs: 3_600_000, absoluteMs: 600_000 })),
    ).toBe('BAD_REQUEST')
    expect(await code(booted.local.rpc.admin.guests.set({ zones: ['lan', 'public'] }))).toBe(
      'BAD_REQUEST',
    )
    expect(await code(booted.local.rpc.admin.guests.set({ zones: ['tailscale'] }))).toBe('ok')
  })

  test('the kill switch refuses entry until enabled again; disabling is audited too', async () => {
    expect(await booted.local.rpc.admin.guests.killswitch({ on: true })).toEqual({ ended: 0 })
    expect(await booted.local.rpc.admin.guests.get()).toMatchObject({
      killed: true,
      blocked: 'killed',
    })
    expect((await booted.local.rpc.admin.guests.set({ enabled: true })).killed).toBe(false)
    expect((await booted.local.rpc.admin.guests.set({ enabled: false })).blocked).toBe('disabled')
    const kinds = (await booted.local.rpc.admin.audit.list({ limit: 100 })).map((a) => a.kind)
    expect(kinds).toContain('guest.killswitch')
    expect(await code(booted.local.rpc.admin.guests.end({ id: 'nope' }))).toBe('NOT_FOUND')
  })

  test('only the owner: a member is refused and a grant of guests.manage is refused', async () => {
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    const ana = booted.tcp(await bearer('ana'))
    expect(await code(ana.rpc.admin.guests.get())).toBe('FORBIDDEN')
    expect(await code(ana.rpc.admin.guests.set({ enabled: false }))).toBe('FORBIDDEN')
    await expect(
      booted.local.rpc.admin.people.grant({ person: 'ana', capability: 'guests.manage' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  test('over TCP the owner needs a step-up to change anything, not to read', async () => {
    const owner = await bearer('owner')
    expect(await code(booted.tcp(owner).rpc.admin.guests.get())).toBe('ok')
    expect(await code(booted.tcp(owner).rpc.admin.guests.killswitch({ on: true }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(booted, owner)
    expect(await code(booted.tcp(owner).rpc.admin.guests.killswitch({ on: false }))).toBe('ok')
  })

  test("the guest model role is the owner's: a member cannot pick it and does not see it", async () => {
    const ana = booted.tcp(await bearer('ana'))
    expect(await code(ana.rpc.models.roles.set({ role: 'guest', ref: 'pricey:cheap' }))).toBe(
      'FORBIDDEN',
    )
    expect('guest' in (await ana.rpc.models.roles.get())).toBe(false)
    expect((await booted.local.rpc.models.roles.get()).guest).toBe('pricey:cheap')
  })

  test('status reports the seeded guest budget once entry has been checked', async () => {
    await booted.local.rpc.admin.guests.set({ enabled: true, dailyUsd: 0.25 })
    const status = await booted.local.rpc.admin.guests.get()
    expect(status.blocked).toBeNull()
    expect(status.budget.daily).toMatchObject({ limitUsd: 0.25, spentUsd: 0 })
    expect(status.budget.monthly).toMatchObject({ scope: 'guests', limitUsd: 5 })
    expect(status.budget.ownerRemaining).toBe(1)
  })
})
