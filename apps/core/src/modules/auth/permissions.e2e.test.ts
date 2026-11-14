import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, tokensRepo } from '@keith/db'
import { openKeithDatabase } from '../../platform/db.ts'
import { type BootedCore, bootCore, FAST_HASH, stepUp } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { LEGACY_STEP_UP_MESSAGE } from './capabilities.ts'
import { createCredential } from './credentials.ts'
import { createToken } from './tokens.ts'

/** Capabilities over a real listener: member limits, step-up on TCP, the socket, grants. */
let b: BootedCore
const PASS = `ferry ${Bun.hash('perm')} lanterns drift quietly`

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
})
afterAll(async () => {
  await b.stop()
})

const config = () => ({ dataDir: b.dir, dbFile: `${b.dir}/keith.db` }) as never

async function login() {
  const res = await fetch(`${b.url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ana', password: PASS }),
  })
  const { credential } = (await res.json()) as { credential: string }
  return credential
}
const member = async () => b.tcp(await login())
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )

describe('a member', () => {
  test('may chat-adjacent reads: whoami, nodes, budget, tasks, model names', async () => {
    const ana = await member()
    expect((await ana.rpc.auth.whoami()).role).toBe('member')
    expect(await code(ana.rpc.nodes.list())).toBe('ok')
    expect(await code(ana.rpc.budget.get())).toBe('ok')
    expect(await code(ana.rpc.tasks.list({}))).toBe('ok')
    expect(await code(ana.rpc.models.roles.get())).toBe('ok')
    expect(await code(ana.rpc.health.get())).toBe('ok')
  })

  test('chats in their own session only', async () => {
    const token = await login()
    const me = await b.tcp(token).rpc.auth.whoami()
    const own = await fetch(`${b.url}/sessions/front:${me.personId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(own.status).toBe(200)
    const other = await fetch(`${b.url}/sessions/front:owner/messages`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(other.status).toBe(404)
  })

  test('is FORBIDDEN on every manage capability, audit and the people directory', async () => {
    const ana = await member()
    const denied = await Promise.all([
      code(ana.rpc.nodes.pair()),
      code(ana.rpc.nodes.revoke({ id: 'x' })),
      code(ana.rpc.budget.set({ limitUsd: null })),
      code(ana.rpc.providers.list()),
      code(ana.rpc.providers.remove({ id: 'x' })),
      code(ana.rpc.providers.test({ id: 'x' })),
      code(ana.rpc.admin.access.get()),
      code(ana.rpc.admin.access.set({ mode: 'local' })),
      code(ana.rpc.admin.people.list()),
      code(ana.rpc.admin.people.add({ username: 'mallory' })),
      code(ana.rpc.admin.people.grant({ person: 'ana', capability: 'audit.read' })),
      code(ana.rpc.admin.tokens.list()),
      code(ana.rpc.admin.tokens.create({ label: 'x' })),
      code(ana.rpc.admin.devices.list()),
      code(ana.rpc.admin.devices.approve({ code: 'ABCD-EFGH' })),
      code(ana.rpc.admin.audit.list({})),
    ])
    expect(denied.every((c) => c === 'FORBIDDEN')).toBe(true)
  })

  test('a grant adds one capability and a revoked grant takes it away again', async () => {
    const ana = await member()
    expect(await code(ana.rpc.admin.devices.list())).toBe('FORBIDDEN')
    expect(
      await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'devices.manage' }),
    ).toEqual(['devices.manage'])
    expect(await b.local.rpc.admin.people.grants({ person: 'ana' })).toEqual(['devices.manage'])
    expect(await code(ana.rpc.admin.devices.list())).toBe('ok')
    // whoami reports the role table plus the grant, so a UI can show what the person may open
    expect((await ana.rpc.auth.whoami()).capabilities).toContain('devices.manage')
    // the grant gives only what it names
    expect(await code(ana.rpc.admin.tokens.list())).toBe('FORBIDDEN')
    await b.local.rpc.admin.people.revokeGrant({ person: 'ana', capability: 'devices.manage' })
    expect(await code(ana.rpc.admin.devices.list())).toBe('FORBIDDEN')
    // the owner needs none, and a made-up capability is refused by the contract
    expect(
      await code(b.local.rpc.admin.people.grant({ person: 'owner', capability: 'chat' })),
    ).toBe('BAD_REQUEST')
    expect(
      await code(b.local.rpc.admin.people.grant({ person: 'ana', capability: 'root' as never })),
    ).toBeDefined()
    const kinds = (await b.local.rpc.admin.audit.list({ limit: 50 })).map((e) => e.kind)
    expect(kinds).toContain('person.grant')
    expect(kinds).toContain('person.grant.revoked')
  })

  test('a sensitive call is not made stronger by a grant: it still needs a step-up over TCP', async () => {
    await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'tokens.manage' })
    const ana = await member()
    expect(await code(ana.rpc.admin.tokens.list())).toBe('ok')
    expect(await code(ana.rpc.admin.tokens.create({ label: 'x' }))).toBe('KEITH_STEP_UP_REQUIRED')
    await b.local.rpc.admin.people.revokeGrant({ person: 'ana', capability: 'tokens.manage' })
  })
})

describe('revoking credentials', () => {
  test('a member revokes their own credentials only; the owner revokes any (P23.1.5)', async () => {
    await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'tokens.manage' })
    await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'devices.manage' })
    const session = await login()
    await stepUp(b, session, 'ana')
    const ana = b.tcp(session)
    const ownerToken = await b.local.rpc.admin.tokens.create({ label: 'owner-cred' })
    // the owner's token id is NOT_FOUND for a member, and the token still works
    expect(await code(ana.rpc.admin.tokens.revoke({ id: ownerToken.id }))).toBe('NOT_FOUND')
    expect(await code(b.tcp(ownerToken.token).rpc.auth.whoami())).toBe('ok')
    // the same for a device credential of the owner
    const db = openDatabase(`${b.dir}/keith.db`)
    const ownerDevice = await createCredential(credentialsRepo(db), {
      personId: 'owner',
      kind: 'device',
      label: 'owner-phone',
    })
    expect(await code(ana.rpc.admin.devices.revoke({ id: ownerDevice.id }))).toBe('NOT_FOUND')
    expect(await code(b.tcp(ownerDevice.token).rpc.auth.whoami())).toBe('ok')
    // their own token revokes
    const own = await ana.rpc.admin.tokens.create({ label: 'mine' })
    expect(await code(ana.rpc.admin.tokens.revoke({ id: own.id }))).toBe('ok')
    // the owner revokes any
    expect(await code(b.local.rpc.admin.tokens.revoke({ id: ownerToken.id }))).toBe('ok')
    expect(await code(b.local.rpc.admin.devices.revoke({ id: ownerDevice.id }))).toBe('ok')
    expect(await code(b.tcp(ownerToken.token).rpc.auth.whoami())).toBe('UNAUTHORIZED')
    db.close()
    await b.local.rpc.admin.people.revokeGrant({ person: 'ana', capability: 'tokens.manage' })
    await b.local.rpc.admin.people.revokeGrant({ person: 'ana', capability: 'devices.manage' })
  })
})

describe('the owner and step-up', () => {
  test('over TCP a sensitive call needs a step-up; reads do not; after it the call works', async () => {
    const owner = b.tcp(await issueOwnerToken(config(), 'cold', { elevated: false }))
    expect(await code(owner.rpc.budget.get())).toBe('ok')
    expect(await code(owner.rpc.admin.people.list())).toBe('ok')
    expect(await code(owner.rpc.budget.set({ limitUsd: null }))).toBe('KEITH_STEP_UP_REQUIRED')
    expect(await code(owner.rpc.nodes.pair())).toBe('KEITH_STEP_UP_REQUIRED')
    expect(await code(owner.rpc.admin.people.add({ username: 'zed' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
  })

  test('after the PIN the same call works, and the local socket never needs one', async () => {
    const token = await issueOwnerToken(config(), 'warm', { elevated: false })
    const owner = b.tcp(token)
    expect(await code(owner.rpc.nodes.pair())).toBe('KEITH_STEP_UP_REQUIRED')
    await stepUp(b, token)
    expect(await code(owner.rpc.nodes.pair())).toBe('ok')
    expect(await code(b.local.rpc.budget.set({ limitUsd: null }))).toBe('ok')
  })

  test('a legacy token can never step up: the message says how to replace it', async () => {
    const sqlite = await openKeithDatabase(b.dir, `${b.dir}/keith.db`)
    const legacy = await createToken(tokensRepo(sqlite), 'owner', 'old')
    sqlite.close()
    const owner = b.tcp(legacy.token)
    expect(await code(owner.rpc.budget.get())).toBe('ok')
    const refused = await owner.rpc.nodes.pair().then(
      () => undefined,
      (e: Error) => e,
    )
    expect((refused as { code?: string }).code).toBe('KEITH_STEP_UP_REQUIRED')
    expect(refused?.message).toBe(LEGACY_STEP_UP_MESSAGE)
  })
})
