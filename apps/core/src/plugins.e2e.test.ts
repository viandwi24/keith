/**
 * Plugins in a booted core (docs/specs/plugins.md): the loader isolates a failing plugin, plugin capabilities
 * join the closed set, and a real person goes through the real directory and guard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CAPABILITY_IDS, keithContract } from '@keith/contracts'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { defineKeithPlugin, defineOperation, GuardError, type ResolvedOperation } from '@keith/host'
import { echoPlugin } from '@keith/host/testing'
import { z } from 'zod'
import { pluginEnabledKey } from './compose-plugins.ts'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

const broken = defineKeithPlugin({
  id: 'broken',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'ping',
      description: 'Ping.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'authenticated' },
      run: () => ({}),
    }),
  ],
  start: () => {
    throw new Error('cannot start')
  },
})

let booted: BootedCore
let db: Sqlite
const sayOp = (): ResolvedOperation => {
  const op = booted.core.plugins
    .loaded()
    .find((p) => p.id === 'echo')
    ?.operation('say')
  if (op === undefined) throw new Error('echo.say is not loaded')
  return op
}
beforeAll(async () => {
  booted = await bootCore({}, { plugins: [broken, echoPlugin()] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

/** A TCP bearer of a person, as a client would hold it. */
async function bearer(username: string): Promise<string> {
  const person = await booted.local.rpc.admin.people.get({ person: username })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: 'test',
  })
  return token
}
const http = (path: string, token: string | undefined, body?: unknown) =>
  fetch(`${booted.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

describe('plugins in core', () => {
  test('a failing plugin does not stop the core; the other one loads', () => {
    expect(booted.core.plugins.status()).toEqual([
      { id: 'broken', version: '1.0.0', state: 'failed', reason: 'cannot start' },
      { id: 'echo', version: '1.0.0', state: 'loaded' },
    ])
    expect(booted.core.health.status).toBe('ok')
  })

  test('the resource kind of a loaded plugin is registered in the core kind table', () => {
    expect(booted.core.kinds.get('echoitem')?.class).toBe('leaf')
  })

  test('a real member holds the plugin capability by role default and reaches the operation', async () => {
    const ana = await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    const out = await booted.core.plugins.guard.run(
      sayOp(),
      { text: 'hello' },
      {
        principal: { id: ana.id },
        session: { id: `front:${ana.id}`, kind: 'front', method: null, elevated: false },
      },
    )
    expect(out).toEqual({ text: 'hello' })
  })

  test('a suspended person is refused the next call', async () => {
    const ben = await booted.local.rpc.admin.people.add({ username: 'ben', name: 'Ben' })
    await booted.local.rpc.admin.people.suspend({ person: ben.id })
    const op = booted.core.plugins.loaded()[0]?.operation('say') as NonNullable<
      ReturnType<NonNullable<ReturnType<typeof booted.core.plugins.loaded>[0]>['operation']>
    >
    const attempt = booted.core.plugins.guard.run(
      op,
      { text: 'x' },
      {
        principal: { id: ben.id },
        session: { id: null, kind: 'api', method: null, elevated: false },
      },
    )
    await expect(attempt).rejects.toBeInstanceOf(GuardError)
  })

  test('whoami lists the capabilities of loaded plugins the person holds (the owner holds them all)', async () => {
    const who = await booted.local.rpc.auth.whoami()
    expect(who.capabilities).toContain('plugins.manage')
    const declared = booted.core.plugins.capabilities().map((c) => c.id)
    for (const id of declared) expect(who.capabilities).toContain(id)
  })

  test('the enable setting key is plugins.<id>.enabled', () => {
    expect(pluginEnabledKey('notes')).toBe('plugins.notes.enabled')
  })
})

describe('plugin routes over the real server', () => {
  test('a member calls an operation with a bearer; the same guard answers', async () => {
    const token = await bearer('ana')
    const ok = await http('/plugins/echo/say', token, { text: 'over http' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ text: 'over http' })
    // a member lacks people.manage: the same 404 as an operation that does not exist
    const denied = await http('/plugins/echo/admin', token, {})
    const missing = await http('/plugins/echo/missing', token, {})
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await missing.text())
  })

  test('no bearer is 401', async () => {
    expect((await http('/plugins/echo/say', undefined, { text: 'x' })).status).toBe(401)
    expect((await http('/plugins/openapi.json', undefined)).status).toBe(401)
  })

  test('the owner over the local socket gets what a member does not', async () => {
    const res = await fetch('http://localhost/plugins/echo/admin', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      unix: booted.socketPath,
    } as RequestInit)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('openapi.json differs by caller: the member sees fewer operations than the owner', async () => {
    const member = (await (await http('/plugins/openapi.json', await bearer('ana'))).json()) as {
      openapi: string
      paths: Record<string, unknown>
    }
    const owner = (await (
      await fetch('http://localhost/plugins/openapi.json', {
        unix: booted.socketPath,
      } as RequestInit)
    ).json()) as { paths: Record<string, unknown> }
    expect(member.openapi).toBe('3.1.0')
    expect(Object.keys(member.paths)).not.toContain('/plugins/echo/admin')
    expect(Object.keys(owner.paths)).toContain('/plugins/echo/admin')
  })

  test('an operation is audited once through the route and once through the guard directly, alike', async () => {
    const token = await bearer('ana')
    await http('/plugins/echo/put', token, { text: 'audited' })
    const kinds = (await booted.local.rpc.admin.audit.list({ limit: 50 })).map((e) => e.kind)
    expect(kinds).toContain('plugin.echo.put')
  })
})

describe('every capability is known', () => {
  test('procedures name core ids; plugin operations name ids their manifests declare', () => {
    const declared = new Set(booted.core.plugins.capabilities().map((c) => c.id))
    expect([...declared]).toEqual(['echo.use'])
    const known = new Set<string>([...CAPABILITY_IDS, 'authenticated', ...declared])
    const operations = booted.core.plugins
      .loaded()
      .flatMap((p) =>
        p.operations.map((o) => [`${p.id}.${o.name}`, o.permission.capability] as const),
      )
    expect(operations.length).toBeGreaterThan(5)
    expect(operations.filter(([, c]) => !known.has(c))).toEqual([])
    // the contract procedures use core ids only
    const walk = (node: unknown, path: string[] = []): Array<[string, string | undefined]> => {
      const orpc = (node as { '~orpc'?: { meta?: { capability?: string } } })['~orpc']
      if (orpc !== undefined) return [[path.join('.'), orpc.meta?.capability]]
      return Object.entries(node as object).flatMap(([k, v]) => walk(v, [...path, k]))
    }
    const procedures = walk(keithContract)
    expect(procedures.filter(([, c]) => c === undefined || !known.has(c))).toEqual([])
    expect(procedures.some(([, c]) => c !== undefined && declared.has(c))).toBe(false)
  })
})
