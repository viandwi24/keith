/**
 * The operator surface of the plugin layer in a booted core (docs/specs/plugins.md): the plugin list and detail,
 * enable and disable (owner only, audited, a step-up over TCP, applied at the next boot), and a plugin capability
 * granted to one person (checked against the live registry, shown by whoami, reaching the operation).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { z } from 'zod'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, stepUp } from './testing/boot-core.ts'

const extra = defineKeithPlugin({
  id: 'extra',
  version: '2.0.0',
  apiVersion: 1,
  title: 'Extra',
  description: 'A test plugin with a capability nobody has by default.',
  permissions: [{ id: 'extra.use', description: 'Use the extra operation' }],
  operations: [
    defineOperation({
      name: 'ping',
      description: 'Answer pong.',
      input: z.object({}),
      output: z.object({ pong: z.literal(true) }),
      permission: { capability: 'extra.use' },
      run: () => ({ pong: true as const }),
    }),
  ],
})

let booted: BootedCore
let db: Sqlite
beforeAll(async () => {
  booted = await bootCore({}, { plugins: [extra] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

async function bearer(person: string): Promise<string> {
  const p = await booted.local.rpc.admin.people.get({ person })
  return (
    await createCredential(credentialsRepo(db), { personId: p.id, kind: 'token', label: 't' })
  ).token
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'error'
  }
}
const ping = (token: string) =>
  fetch(`${booted.url}/plugins/extra/ping`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })

describe('plugin list, show, enable and disable', () => {
  test('list and show tell what loaded, its capabilities and its operations', async () => {
    const rows = await booted.local.rpc.admin.plugins.list()
    expect(rows).toEqual([
      {
        id: 'extra',
        version: '2.0.0',
        title: 'Extra',
        state: 'enabled',
        reason: null,
        nextBoot: 'enabled',
        restartPending: false,
        pendingReviews: 0,
      },
    ])
    const detail = await booted.local.rpc.admin.plugins.show({ id: 'extra' })
    expect(detail.capabilities).toEqual([
      { id: 'extra.use', description: 'Use the extra operation', roles: [] },
    ])
    expect(detail.operations).toMatchObject([
      { name: 'ping', capability: 'extra.use', audience: 'user', review: false, ai: true },
    ])
    expect(detail.schedules).toEqual({ active: 0, nextAt: null })
    expect(await code(booted.local.rpc.admin.plugins.show({ id: 'nope' }))).toBe('NOT_FOUND')
  })

  test('only the owner reads the plugin layer; a member is refused', async () => {
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    const ana = booted.tcp(await bearer('ana'))
    expect(await code(ana.rpc.admin.plugins.list())).toBe('FORBIDDEN')
    expect(await code(ana.rpc.admin.plugins.disable({ id: 'extra' }))).toBe('FORBIDDEN')
    await expect(
      booted.local.rpc.admin.people.grant({ person: 'ana', capability: 'plugins.manage' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  test('disable saves the setting, audits it and applies at the next boot; enable undoes it', async () => {
    const off = await booted.local.rpc.admin.plugins.disable({ id: 'extra' })
    expect(off).toMatchObject({ changed: true, effective: 'next-boot' })
    expect(off.plugin).toMatchObject({
      state: 'enabled',
      nextBoot: 'disabled',
      restartPending: true,
    })
    expect((await booted.local.rpc.admin.plugins.disable({ id: 'extra' })).changed).toBe(false)
    // still loaded in this process: the operation keeps working until the restart
    const owner = await bearer('owner')
    expect((await ping(owner)).status).toBe(200)
    const on = await booted.local.rpc.admin.plugins.enable({ id: 'extra' })
    expect(on.plugin).toMatchObject({ nextBoot: 'enabled', restartPending: false })
    const kinds = (await booted.local.rpc.admin.audit.list({ limit: 50 })).map((a) => a.kind)
    expect(kinds).toContain('plugin.disabled')
    expect(kinds).toContain('plugin.enabled')
  })

  test('over TCP the owner needs a step-up to enable or disable', async () => {
    const owner = await bearer('owner')
    expect(await code(booted.tcp(owner).rpc.admin.plugins.disable({ id: 'extra' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    expect(await code(booted.tcp(owner).rpc.admin.plugins.list())).toBe('ok')
    await stepUp(booted, owner)
    expect(await code(booted.tcp(owner).rpc.admin.plugins.enable({ id: 'extra' }))).toBe('ok')
  })
})

describe('a plugin capability granted to one person', () => {
  test('the picker lists core and plugin ids; an unknown id is refused', async () => {
    const all = await booted.local.rpc.admin.capabilities.list()
    expect(all.find((c) => c.id === 'chat')).toMatchObject({ owner: 'core', ownerOnly: false })
    expect(all.find((c) => c.id === 'plugins.manage')).toMatchObject({ ownerOnly: true })
    expect(all.find((c) => c.id === 'extra.use')).toMatchObject({
      owner: 'extra',
      description: 'Use the extra operation',
    })
    await expect(
      booted.local.rpc.admin.people.grant({ person: 'ana', capability: 'ghost.use' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  test('without the grant the operation is hidden; with it whoami shows it and the call runs; revoke takes it back', async () => {
    const ana = await bearer('ana')
    expect((await ping(ana)).status).not.toBe(200)
    expect(
      await booted.local.rpc.admin.people.grant({ person: 'ana', capability: 'extra.use' }),
    ).toEqual(['extra.use'])
    const me = await booted.tcp(ana).rpc.auth.whoami()
    expect(me.capabilities).toContain('extra.use')
    expect(me.capabilities).toContain('chat')
    expect((await ping(ana)).status).toBe(200)
    expect(await booted.local.rpc.admin.people.grants({ person: 'ana' })).toEqual(['extra.use'])
    expect(
      await booted.local.rpc.admin.people.revokeGrant({ person: 'ana', capability: 'extra.use' }),
    ).toEqual([])
    expect((await ping(ana)).status).not.toBe(200)
    expect((await booted.tcp(ana).rpc.auth.whoami()).capabilities).not.toContain('extra.use')
  })
})
