import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type LeakOperations, leakCheck } from '@keith/acl/testing'
import type { AclActor } from '@keith/contracts'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH, stepUp } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'
import { createCredential } from '../auth/index.ts'

/** Share, chmod, chgrp and chown over a real core: members over TCP, the owner on the socket and the CLI. */
let b: BootedCore
let db: Sqlite
let deps: CliDeps
const ids: Record<string, string> = {}

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  db = openDatabase(loadConfig(deps.env ?? {}).dbFile)
  // the Notes plugin registers the `note` kind (a leaf)
  if (b.core.kinds.get('note') === undefined) b.core.kinds.register('note', { class: 'leaf' })
  for (const name of ['ana', 'duta', 'amel', 'gone']) {
    const p = await b.local.rpc.admin.people.add({ username: name })
    ids[name] = p.id
  }
  await b.local.rpc.admin.people.suspend({ person: 'gone' })
})
afterAll(async () => {
  db.close()
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}
async function as(username: string) {
  const { token } = await createCredential(credentialsRepo(db), {
    personId: ids[username] ?? '',
    kind: 'token',
    label: 'test',
  })
  return { token, client: b.tcp(token) }
}
const fail = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'ok', message: '' }),
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
  )
const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)
const mine = (id: string, owner = 'ana') =>
  b.core.acl.createResource({ kind: 'note', id, ownerId: ids[owner] ?? owner })
const reads = (who: string, id: string) =>
  b.core.acl.check({ kind: 'user', id: ids[who] ?? who, role: 'member' }, 'note', id, 4).allowed

describe('a member changes what they own', () => {
  test('share to an existing active user or group; refused for unknown, suspended or out-of-class bits', async () => {
    mine('own-1')
    const ana = await as('ana')
    const view = await ana.client.rpc.acl.share({
      kind: 'note',
      id: 'own-1',
      target: 'user:duta',
      bits: 4,
    })
    expect(view.entries).toEqual([
      { subject: `user:${ids.duta}`, label: 'user:duta', bits: 4, effect: 'allow' },
    ])
    expect(reads('duta', 'own-1')).toBe(true)
    expect(reads('amel', 'own-1')).toBe(false)
    expect(
      (
        await fail(
          ana.client.rpc.acl.share({ kind: 'note', id: 'own-1', target: 'user:nobody', bits: 4 }),
        )
      ).code,
    ).toBe('BAD_REQUEST')
    expect(
      (
        await fail(
          ana.client.rpc.acl.share({ kind: 'note', id: 'own-1', target: 'user:gone', bits: 4 }),
        )
      ).code,
    ).toBe('BAD_REQUEST')
    expect(
      (
        await fail(
          ana.client.rpc.acl.share({ kind: 'note', id: 'own-1', target: 'group:nope', bits: 4 }),
        )
      ).code,
    ).toBe('BAD_REQUEST')
    expect(
      (
        await fail(
          ana.client.rpc.acl.share({ kind: 'note', id: 'own-1', target: 'user:amel', bits: 1 }),
        )
      ).code,
    ).toBe('BAD_REQUEST')
    const g = await b.local.rpc.admin.groups.create({ name: 'crew' })
    await b.local.rpc.admin.groups.add({ group: 'crew', person: 'amel' })
    await ana.client.rpc.acl.share({ kind: 'note', id: 'own-1', target: 'group:crew', bits: 4 })
    expect(reads('amel', 'own-1')).toBe(true)
    await ana.client.rpc.acl.unshare({ kind: 'note', id: 'own-1', target: 'group:crew' })
    expect(reads('amel', 'own-1')).toBe(false)
    await ana.client.rpc.acl.chgrp({ kind: 'note', id: 'own-1', group: 'crew' })
    expect(b.core.acl.getResource('note', 'own-1')?.groupId).toBe(g.id)
    await ana.client.rpc.acl.chgrp({ kind: 'note', id: 'own-1', group: null })
    await b.local.rpc.admin.groups.delete({ group: 'crew' })
  })

  test('every change is audited with before and after bits only', async () => {
    mine('own-2')
    const ana = await as('ana')
    await ana.client.rpc.acl.share({ kind: 'note', id: 'own-2', target: 'user:duta', bits: 4 })
    await ana.client.rpc.acl.chmod({ kind: 'note', id: 'own-2', mode: 0o640 })
    await ana.client.rpc.acl.unshare({ kind: 'note', id: 'own-2', target: 'user:duta' })
    const rows = [
      ...(await events('acl.share')),
      ...(await events('acl.chmod')),
      ...(await events('acl.unshare')),
    ]
    const own = rows.filter((e) => (e.detail as { id?: string }).id === 'own-2')
    expect(own.map((e) => e.kind).sort()).toEqual(['acl.chmod', 'acl.share', 'acl.unshare'])
    const chmod = own.find((e) => e.kind === 'acl.chmod')
    expect(chmod?.detail).toEqual({
      kind: 'note',
      id: 'own-2',
      from: 0o600,
      to: 0o640,
      resourceOwner: ids.ana,
    })
    // every change row names the person who owns the resource, so that person can read it (audit.mine)
    expect(
      own.every((e) => (e.detail as { resourceOwner?: string }).resourceOwner === ids.ana),
    ).toBe(true)
    expect(own.every((e) => e.actor === ids.ana)).toBe(true)
    // an unchanged repeat writes nothing
    await ana.client.rpc.acl.chmod({ kind: 'note', id: 'own-2', mode: 0o640 })
    expect(
      (await events('acl.chmod')).filter((e) => (e.detail as { id?: string }).id === 'own-2')
        .length,
    ).toBe(1)
  })

  test('widening to @public or @users needs a step-up; a refusal changes nothing', async () => {
    mine('own-3')
    const ana = await as('ana')
    for (const call of [
      () => ana.client.rpc.acl.share({ kind: 'note', id: 'own-3', target: '@public', bits: 4 }),
      () => ana.client.rpc.acl.share({ kind: 'note', id: 'own-3', target: '@users', bits: 4 }),
      () => ana.client.rpc.acl.chmod({ kind: 'note', id: 'own-3', mode: 0o604 }),
    ]) {
      expect((await fail(call())).code).toBe('KEITH_STEP_UP_REQUIRED')
    }
    expect(b.core.acl.getResource('note', 'own-3')).toMatchObject({ mode: 0o600, entries: [] })
    // narrowing and named people never need it
    await ana.client.rpc.acl.share({ kind: 'note', id: 'own-3', target: 'user:duta', bits: 4 })
    await ana.client.rpc.acl.share({
      kind: 'note',
      id: 'own-3',
      target: '@public',
      bits: 4,
      effect: 'deny',
    })
    await stepUp(b, ana.token, 'ana')
    await ana.client.rpc.acl.chmod({ kind: 'note', id: 'own-3', mode: 0o604 })
    expect(b.core.acl.getResource('note', 'own-3')?.mode).toBe(0o604)
    await ana.client.rpc.acl.share({ kind: 'note', id: 'own-3', target: '@users', bits: 4 })
  })
})

describe('what a member cannot do', () => {
  test('an outsider learns nothing: missing and denied read the same, for every call', async () => {
    mine('priv-1')
    const amel = await as('amel')
    const calls = (id: string) => [
      amel.client.rpc.acl.show({ kind: 'note', id }),
      amel.client.rpc.acl.share({ kind: 'note', id, target: 'user:amel', bits: 4 }),
      amel.client.rpc.acl.unshare({ kind: 'note', id, target: 'user:amel' }),
      amel.client.rpc.acl.chmod({ kind: 'note', id, mode: 0o644 }),
      amel.client.rpc.acl.chgrp({ kind: 'note', id, group: null }),
    ]
    const denied = await Promise.all(calls('priv-1').map(fail))
    const missing = await Promise.all(calls('nope-1').map(fail))
    expect(denied).toEqual(missing)
    expect(denied.every((r) => r.code === 'NOT_FOUND')).toBe(true)
    // an unregistered kind is the same answer
    expect(await fail(amel.client.rpc.acl.show({ kind: 'ghost', id: 'priv-1' }))).toEqual(
      missing[0] as { code: string | undefined; message: string | undefined },
    )
    expect(b.core.acl.getResource('note', 'priv-1')).toMatchObject({ mode: 0o600, entries: [] })
  })

  test('a reader who is not the owner may not change access and may not look at the entries', async () => {
    mine('shared-1')
    const ana = await as('ana')
    await ana.client.rpc.acl.share({ kind: 'note', id: 'shared-1', target: 'user:duta', bits: 6 })
    const duta = await as('duta')
    expect(
      (await fail(duta.client.rpc.acl.chmod({ kind: 'note', id: 'shared-1', mode: 0o666 }))).code,
    ).toBe('FORBIDDEN')
    expect(
      (
        await fail(
          duta.client.rpc.acl.share({ kind: 'note', id: 'shared-1', target: 'user:amel', bits: 4 }),
        )
      ).code,
    ).toBe('FORBIDDEN')
    expect((await fail(duta.client.rpc.acl.show({ kind: 'note', id: 'shared-1' }))).code).toBe(
      'NOT_FOUND',
    )
    expect(reads('amel', 'shared-1')).toBe(false)
  })

  test('a member can never chown, even their own resource', async () => {
    mine('own-4')
    const ana = await as('ana')
    expect(
      (await fail(ana.client.rpc.acl.chown({ kind: 'note', id: 'own-4', owner: 'duta' }))).code,
    ).toBe('FORBIDDEN')
    expect(b.core.acl.getResource('note', 'own-4')?.ownerId).toBe(ids.ana)
  })

  test('a suspended caller is refused at execution time', async () => {
    mine('own-5')
    const ana = await as('ana')
    await b.local.rpc.admin.people.suspend({ person: 'ana' })
    // the credential is revoked by the suspend; a call with it is refused before it gets here
    expect((await fail(ana.client.rpc.acl.show({ kind: 'note', id: 'own-5' }))).code).not.toBe('ok')
    await b.local.rpc.admin.people.reactivate({ person: 'ana' })
  })
})

describe('the owner', () => {
  test('changes anything, hands over with chown, to an active person only; the CLI prints ls -l', async () => {
    mine('o-1')
    const out = await cli('acl', 'share', 'note', 'o-1', 'user:duta', 'r')
    expect(out.code).toBe(0)
    expect(out.out).toContain('rw-------')
    expect(out.out).toContain('owner=ana')
    expect(out.out).toContain('allow user:duta r--')
    expect((await cli('acl', 'share', 'note', 'o-1', 'user:duta', 'q')).code).toBe(2)
    expect((await cli('acl', 'share', 'note', 'o-1', 'user:duta', 'r', '--deny')).out).toContain(
      'deny  user:duta r--',
    )
    expect((await cli('acl', 'unshare', 'note', 'o-1', 'user:duta', '--deny')).code).toBe(0)
    expect((await cli('acl', 'chmod', 'note', 'o-1', '640')).out).toContain('rw-r-----')
    expect((await cli('acl', 'chmod', 'note', 'o-1', '700')).code).toBe(1)
    expect((await cli('acl', 'chown', 'note', 'o-1', 'gone', '--yes')).code).toBe(1)
    expect((await cli('acl', 'chown', 'note', 'o-1', 'amel', '--yes')).out).toContain('owner=amel')
    expect(b.core.acl.getResource('note', 'o-1')?.ownerId).toBe(ids.amel)
    const chown = (await events('acl.chown')).find(
      (e) => (e.detail as { id?: string }).id === 'o-1',
    )
    expect(chown?.detail).toEqual({
      kind: 'note',
      id: 'o-1',
      from: ids.ana,
      to: ids.amel,
      resourceOwner: ids.ana,
    })
    expect((await cli('acl', 'show', 'note', 'missing')).code).toBe(1)
  })

  test("looking at a member's private resource is audited once per window, with no content", async () => {
    mine('o-2', 'duta')
    const before = (await events('acl.owner-access')).length
    expect((await cli('acl', 'show', 'note', 'o-2')).code).toBe(0)
    expect((await cli('acl', 'show', 'note', 'o-2')).code).toBe(0)
    const rows = await events('acl.owner-access')
    expect(rows.length).toBe(before + 1)
    expect(rows[0]?.detail).toEqual({ kind: 'note', id: 'o-2', owner: ids.duta, bits: 4 })
  })
})

describe('the leak kit against acl.* over TCP', () => {
  test('show, chmod and unshare on a private resource read the same as on a missing one', async () => {
    const g = await b.local.rpc.admin.groups.create({ name: 'hushhush' })
    await b.local.rpc.admin.groups.create({ name: 'crew2' })
    await b.local.rpc.admin.groups.add({ group: 'crew2', person: 'duta' })
    const clients = {
      ana: (await as('ana')).client,
      amel: (await as('amel')).client,
      duta: (await as('duta')).client,
    }
    const byId = new Map(
      Object.entries(ids).map(([name, id]) => [id, name as keyof typeof clients]),
    )
    const clientOf = (a: AclActor) => clients[byId.get(a.id) as keyof typeof clients]
    const ops: LeakOperations = {
      get: (a, id) => clientOf(a).rpc.acl.show({ kind: 'note', id }),
      update: (a, id) => clientOf(a).rpc.acl.chmod({ kind: 'note', id, mode: 0o600 }),
      delete: (a, id) =>
        clientOf(a).rpc.acl.unshare({ kind: 'note', id, target: `group:${g.name}` }),
    }
    const user = (name: string): AclActor => ({ kind: 'user', id: ids[name] ?? '', role: 'member' })
    const report = await leakCheck({
      operations: ops,
      term: 'unused',
      actors: { owner: user('ana'), outsider: user('amel'), groupMember: user('duta') },
      seed: () => {
        b.core.acl.createResource({
          kind: 'note',
          id: 'leak-1',
          ownerId: ids.ana ?? '',
          entries: [{ subject: `group:${g.id}`, bits: 4, effect: 'allow' }],
        })
        return { id: 'leak-1', missingId: 'leak-0', secrets: ['hushhush'] }
      },
    })
    expect(report.problems).toEqual([])
    expect(b.core.acl.getResource('note', 'leak-1')?.entries.length).toBe(1)
  })
})
