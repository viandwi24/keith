import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'
import { createCredential } from '../auth/index.ts'

/** Groups over a real core: the CLI on the socket, a member over TCP, the ACL store behind them. */
let b: BootedCore
let db: Sqlite
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  db = openDatabase(loadConfig(deps.env ?? {}).dbFile)
  // the Notes plugin registers the `note` kind (a leaf)
  if (b.core.kinds.get('note') === undefined) b.core.kinds.register('note', { class: 'leaf' })
  for (const name of ['ana', 'duta', 'amel']) await b.local.rpc.admin.people.add({ username: name })
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
async function member(username: string) {
  const person = await b.local.rpc.admin.people.get({ person: username })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: 'test',
  })
  return { person, token, client: b.tcp(token) }
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const events = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('keith-core groups', () => {
  test('create, add, list, show, remove, delete; each change is audited', async () => {
    expect((await cli('groups', 'list')).out).toContain('no groups yet')
    expect((await cli('groups', 'create', 'Friends')).code).toBe(0)
    expect((await cli('groups', 'create', 'friends')).code).toBe(1)
    expect((await cli('groups', 'create', 'x')).code).toBe(1)
    expect((await cli('groups', 'add', 'friends', 'ana')).code).toBe(0)
    expect((await cli('groups', 'add', 'friends', 'duta')).code).toBe(0)
    expect((await cli('groups', 'add', 'friends', 'duta')).code).toBe(0)
    expect((await cli('groups', 'add', 'friends', 'nobody')).code).toBe(1)
    const listed = await cli('groups', 'list')
    expect(listed.out).toContain('friends')
    expect(listed.out).toContain('ana, duta')
    const shown = await cli('groups', 'show', 'friends')
    expect(shown.out).toContain('duta')
    expect((await cli('groups', 'remove', 'friends', 'duta')).out).toContain('ana')
    expect((await cli('groups', 'remove', 'friends', 'duta')).code).toBe(0)
    expect((await cli('groups', 'delete', 'friends', '--yes')).code).toBe(0)
    expect((await cli('groups', 'show', 'friends')).code).toBe(1)
    expect((await events('acl.group.create')).length).toBe(1)
    // the idempotent repeats wrote nothing more
    expect((await events('acl.group.add')).length).toBe(2)
    expect((await events('acl.group.remove')).length).toBe(1)
    expect((await events('acl.group.delete')).length).toBe(1)
    expect(JSON.stringify(await events('acl.group.add'))).not.toContain('secret')
  })

  test('a group in use cannot be deleted: the refusal carries the count', async () => {
    const g = await b.local.rpc.admin.groups.create({ name: 'team-a' })
    const owner = await b.local.rpc.admin.people.get({ person: 'ana' })
    b.core.acl.createResource({
      kind: 'note',
      id: 'n-used-1',
      ownerId: owner.id,
      entries: [{ subject: `group:${g.id}`, bits: 4, effect: 'allow' }],
    })
    const refused = await cli('groups', 'delete', 'team-a', '--yes')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('used by 1 resource')
    expect((await b.local.rpc.admin.groups.get({ group: 'team-a' })).usage).toBe(1)
    b.core.acl.removeResource('note', 'n-used-1')
    await b.local.rpc.admin.groups.delete({ group: 'team-a' })
  })
})

describe('only the owner manages groups', () => {
  test('a member is refused every call, even with groups.manage granted', async () => {
    const ana = await member('ana')
    expect(await code(ana.client.rpc.admin.groups.list())).toBe('FORBIDDEN')
    expect(await code(ana.client.rpc.admin.groups.create({ name: 'mine' }))).toBe('FORBIDDEN')
    // the grant is refused...
    expect(
      await code(b.local.rpc.admin.people.grant({ person: 'ana', capability: 'groups.manage' })),
    ).toBe('BAD_REQUEST')
    // ...and a stray grant row is ignored
    db.query(
      "INSERT INTO person_grants (person_id, capability, granted_by, created_at) VALUES (?, 'groups.manage', 'owner', 1)",
    ).run(ana.person.id)
    expect(await code(ana.client.rpc.admin.groups.list())).toBe('FORBIDDEN')
    db.query("DELETE FROM person_grants WHERE capability = 'groups.manage'").run()
  })

  test('the owner over TCP needs a step-up to change, not to read', async () => {
    const owner = await b.local.rpc.admin.people.get({ person: 'owner' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: owner.id,
      kind: 'token',
      label: 'owner-tcp',
    })
    const tcp = b.tcp(token)
    expect(await code(tcp.rpc.admin.groups.list())).toBe('ok')
    expect(await code(tcp.rpc.admin.groups.create({ name: 'remote' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, token)
    expect(await code(tcp.rpc.admin.groups.create({ name: 'remote' }))).toBe('ok')
    await b.local.rpc.admin.groups.delete({ group: 'remote' })
  })
})

describe('membership is looked up at check time', () => {
  test('a suspended or removed person loses what the group gave, and gets it back on reactivation', async () => {
    const g = await b.local.rpc.admin.groups.create({ name: 'readers' })
    await b.local.rpc.admin.groups.add({ group: 'readers', person: 'amel' })
    const amel = await b.local.rpc.admin.people.get({ person: 'amel' })
    const owner = await b.local.rpc.admin.people.get({ person: 'ana' })
    b.core.acl.createResource({
      kind: 'note',
      id: 'n-shared-1',
      ownerId: owner.id,
      entries: [{ subject: `group:${g.id}`, bits: 4, effect: 'allow' }],
    })
    const actor = { kind: 'user', id: amel.id, role: 'member' } as const
    const can = () => b.core.acl.check(actor, 'note', 'n-shared-1', 4).allowed
    expect(can()).toBe(true)
    await b.local.rpc.admin.people.suspend({ person: 'amel' })
    expect(can()).toBe(false)
    expect(b.core.acl.visibleIds(actor, 'note', 4)).toEqual([])
    await b.local.rpc.admin.people.reactivate({ person: 'amel' })
    expect(can()).toBe(true)
    await b.local.rpc.admin.groups.remove({ group: 'readers', person: 'amel' })
    expect(can()).toBe(false)
    // a suspended person cannot be added
    await b.local.rpc.admin.people.suspend({ person: 'amel' })
    expect(await code(b.local.rpc.admin.groups.add({ group: 'readers', person: 'amel' }))).toBe(
      'BAD_REQUEST',
    )
    await b.local.rpc.admin.people.reactivate({ person: 'amel' })
    b.core.acl.removeResource('note', 'n-shared-1')
    await b.local.rpc.admin.groups.delete({ group: 'readers' })
  })
})

describe('people remove', () => {
  test("hands the removed person's resources to the owner, drops their entries and memberships, and audits the move", async () => {
    const g = await b.local.rpc.admin.groups.create({ name: 'leavers' })
    await b.local.rpc.admin.people.add({ username: 'leo' })
    await b.local.rpc.admin.groups.add({ group: 'leavers', person: 'leo' })
    const leo = await b.local.rpc.admin.people.get({ person: 'leo' })
    const duta = await b.local.rpc.admin.people.get({ person: 'duta' })
    b.core.acl.createResource({ kind: 'note', id: 'leo-1', ownerId: leo.id })
    b.core.acl.createResource({ kind: 'note', id: 'leo-2', ownerId: leo.id })
    b.core.acl.createResource({
      kind: 'note',
      id: 'duta-1',
      ownerId: duta.id,
      entries: [{ subject: `user:${leo.id}`, bits: 4, effect: 'allow' }],
    })
    await b.local.rpc.admin.people.remove({ person: 'leo' })
    expect(b.core.acl.getResource('note', 'leo-1')?.ownerId).toBe('owner')
    expect(b.core.acl.getResource('note', 'leo-2')?.ownerId).toBe('owner')
    expect(b.core.acl.getResource('note', 'duta-1')?.entries).toEqual([])
    expect(b.core.acl.members(g.id)).toEqual([])
    const moved = await events('person.resources.moved')
    expect(moved[0]?.detail).toMatchObject({ personId: leo.id, heirId: 'owner', count: 2 })
    b.core.acl.removeResource('note', 'leo-1')
    b.core.acl.removeResource('note', 'leo-2')
    b.core.acl.removeResource('note', 'duta-1')
    await b.local.rpc.admin.groups.delete({ group: 'leavers' })
  })
})

describe('audit retention', () => {
  test('show and set over the CLI; 0 keeps everything; a member is refused', async () => {
    expect((await cli('audit', 'retention')).out).toContain('180 days')
    const set = await cli('audit', 'retention', 'set', '90')
    expect(set.out).toContain('90 days')
    expect((await cli('audit', 'retention', 'show')).out).toContain('90 days')
    expect((await cli('audit', 'retention', 'set', '0')).out).toContain('keep everything')
    expect((await cli('audit', 'retention', 'set', '-1')).code).toBe(2)
    expect((await cli('audit', 'retention', 'set', '99999')).code).toBe(2)
    expect((await events('audit.retention.set')).length).toBe(2)
    const ana = await member('ana')
    expect(await code(ana.client.rpc.admin.audit.retention.get())).toBe('FORBIDDEN')
    expect(await code(ana.client.rpc.admin.audit.retention.set({ days: 1 }))).toBe('FORBIDDEN')
    await cli('audit', 'retention', 'set', '180')
  })
})
