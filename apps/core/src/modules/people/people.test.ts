import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { credentialsRepo, identifiersRepo, openDatabase, type Sqlite } from '@keith/db'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'
import { candidatesOf, createCredential } from '../auth/index.ts'
import { removedFolderOf } from './removed.ts'

let booted: BootedCore
let db: Sqlite
let deps: CliDeps

beforeAll(async () => {
  booted = await bootCore()
  deps = { env: { KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' } }
  db = openDatabase(loadConfig(deps.env ?? {}).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

async function people(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = testIo()
  io.end()
  const code = await runCoreCli(['people', ...argv], io, deps)
  return { code, out: io.out(), err: io.err() }
}
/** A credential for a person, as a TCP client would hold it. */
async function login(username: string) {
  const person = await booted.local.rpc.admin.people.get({ person: username })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: 'test',
  })
  return { person, token, client: booted.tcp(token) }
}
const events = async () =>
  (await booted.local.rpc.admin.audit.list({ limit: 200 })).map((e) => e.kind)

describe('people over the socket', () => {
  test('add (UUIDv7 id, member), list, get by username or id', async () => {
    const added = await people('add', 'ana', '--name', 'Ana B')
    expect(added.code).toBe(0)
    const ana = await booted.local.rpc.admin.people.get({ person: 'ana' })
    expect(ana).toMatchObject({
      username: 'ana',
      name: 'Ana B',
      role: 'member',
      status: 'active',
      createdBy: 'owner',
    })
    expect(ana.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect((await booted.local.rpc.admin.people.get({ person: ana.id })).username).toBe('ana')
    const listed = await people('list')
    expect(listed.out).toContain('ana')
    expect(listed.out).toContain('owner')
    expect(await events()).toContain('person.create')
  })

  test('username rules: format, uniqueness, rename', async () => {
    expect((await people('add', 'A')).code).not.toBe(0)
    expect((await people('add', 'has space')).code).not.toBe(0)
    const dup = await people('add', 'ana')
    expect(dup.code).not.toBe(0)
    expect(dup.err).toContain('taken')
    expect((await people('add', 'bob', '--role', 'owner')).code).not.toBe(0)
    expect((await people('add', 'bob')).code).toBe(0)
    expect((await people('rename', 'bob', 'ana')).code).not.toBe(0)
    expect((await people('rename', 'bob', 'bobby', '--name', 'Bobby')).code).toBe(0)
    expect(await booted.local.rpc.admin.people.get({ person: 'bobby' })).toMatchObject({
      name: 'Bobby',
    })
    expect((await people('rename', 'bobby')).code).not.toBe(0)
    await people('remove', 'bobby', '--yes')
  })

  test('a username holds a letter: digits only never equals a phone alias (P23.1.16)', async () => {
    expect((await people('add', '6281234567890')).code).not.toBe(0)
    expect((await people('add', '007')).code).not.toBe(0)
    expect((await people('add', 'a1')).code).toBe(0)
    expect((await people('add', 'ann')).code).toBe(0)
    await booted.local.rpc.admin.people.alias.add({
      person: 'ann',
      kind: 'phone',
      value: '+6281234567891',
    })
    // a rename to an alias value is refused, and the phone still resolves to the one person
    expect((await people('rename', 'a1', '6281234567891')).code).not.toBe(0)
    expect((await people('rename', 'a1', '+6281234567891')).code).not.toBe(0)
    const found = identifiersRepo(db).lookup(candidatesOf('+6281234567891'))
    expect(found?.person.username).toBe('ann')
    expect(found?.kind).toBe('phone')
    await booted.local.rpc.admin.people.remove({ person: 'a1' })
    await booted.local.rpc.admin.people.remove({ person: 'ann' })
  })

  test('a member sees themselves in whoami and cannot manage people', async () => {
    await people('add', 'cleo')
    const cleo = await login('cleo')
    expect(await cleo.client.rpc.auth.whoami()).toMatchObject({
      personId: cleo.person.id,
      username: 'cleo',
      name: 'cleo',
      role: 'member',
      via: 'tcp',
    })
    await expect(cleo.client.rpc.admin.people.list()).rejects.toThrow(/people.manage capability/)
    expect(await booted.local.rpc.auth.whoami()).toMatchObject({
      personId: 'owner',
      username: 'owner',
      role: 'owner',
    })
  })

  test('suspend makes credentials fail and revokes them: reactivate does not bring them back', async () => {
    await people('add', 'dan')
    const dan = await login('dan')
    await dan.client.rpc.auth.whoami()
    expect((await people('suspend', 'dan')).out).toContain('suspended')
    await expect(dan.client.rpc.auth.whoami()).rejects.toThrow()
    expect((await people('reactivate', 'dan')).out).toContain('active')
    await expect(dan.client.rpc.auth.whoami()).rejects.toThrow()
    expect((await (await login('dan')).client.rpc.auth.whoami()).username).toBe('dan')
    const kinds = await events()
    expect(kinds).toContain('person.status')
  })

  test('remove revokes credentials, keeps the audit and refuses the owner', async () => {
    await people('add', 'eve')
    const eve = await login('eve')
    await eve.client.rpc.auth.whoami()
    expect((await people('remove', 'eve', '--yes')).code).toBe(0)
    await expect(eve.client.rpc.auth.whoami()).rejects.toThrow()
    await expect(booted.local.rpc.admin.people.get({ person: 'eve' })).rejects.toThrow()
    const audit = await booted.local.rpc.admin.audit.list({ limit: 200 })
    const gone = audit.find(
      (e) => e.kind === 'person.delete' && e.detail.personId === eve.person.id,
    )
    expect(gone?.detail).toMatchObject({ username: 'eve', credentialsRevoked: 1 })
    expect(
      audit.some((e) => e.kind === 'person.create' && e.detail.personId === eve.person.id),
    ).toBe(true)
    // every row about a person names them as the subject, the way the member view finds it
    const about = audit.filter((e) => /^(person|credential)\./.test(e.kind))
    expect(about.length).toBeGreaterThan(0)
    for (const e of about)
      if (e.detail.personId !== undefined) expect(e.detail.subject, e.kind).toBe(e.detail.personId)
    const refused = await people('remove', 'owner', '--yes')
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain('exactly one owner')
    expect((await people('suspend', 'owner')).code).not.toBe(0)
    expect((await people('role', 'owner', 'member')).code).not.toBe(0)
    expect((await people('role', 'cleo', 'owner')).code).not.toBe(0)
  })

  test('transfer-owner is atomic: one owner before and after; the socket follows the owner', async () => {
    await people('add', 'fay')
    expect((await people('transfer-owner', 'owner', '--yes')).code).not.toBe(0)
    await people('suspend', 'fay')
    expect((await people('transfer-owner', 'fay', '--yes')).code).not.toBe(0)
    await people('reactivate', 'fay')
    // F-013: a new owner needs a way to sign in
    expect((await people('transfer-owner', 'fay', '--yes')).err).toContain('no password or PIN')
    await booted.local.rpc.admin.people.setPin({ person: 'fay', pin: '730416' })
    const done = await people('transfer-owner', 'fay', '--yes')
    expect(done.out).toContain('fay is now the owner')
    const all = await booted.local.rpc.admin.people.list()
    expect(all.filter((p) => p.role === 'owner').map((p) => p.username)).toEqual(['fay'])
    expect(all.find((p) => p.id === 'owner')?.role).toBe('member')
    // the socket is the current owner, and the former owner is now a member
    expect(await booted.local.rpc.auth.whoami()).toMatchObject({ username: 'fay', role: 'owner' })
    const former = await login('owner')
    await expect(former.client.rpc.admin.people.list()).rejects.toThrow(/people.manage capability/)
    expect((await events()).filter((k) => k === 'person.role').length).toBeGreaterThanOrEqual(2)
  })
})

describe('remove keeps the data for the keep time', () => {
  test('the removed folder holds the manifest, and the CLI says where and until when', async () => {
    await booted.local.rpc.admin.people.add({ username: 'kept' })
    const removed = await booted.local.rpc.admin.people.remove({ person: 'kept' })
    expect(removed.keptUntil).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect(existsSync(join(removedFolderOf(booted.dir, removed.id), 'manifest.json'))).toBe(true)

    await booted.local.rpc.admin.people.add({ username: 'gone' })
    const out = await people('remove', 'gone', '--yes')
    expect(out.code).toBe(0)
    expect(out.out).toMatch(
      /gone: removed; data kept in workspace\/keith\/removed\/\S+ until \d{4}-\d{2}-\d{2}; run people export first for an archive/,
    )
  })
})
