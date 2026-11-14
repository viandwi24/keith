import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { migrateDatabase, openDatabase, sqlitePersonStore } from '@keith/db'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'
import { createPeopleService } from './people.ts'
import { mintSuccessionProof } from './succession-proof.ts'

// A member holding people.manage may manage other members, never the owner or themselves (ADR-0022).
let booted: BootedCore
beforeAll(async () => {
  booted = await bootCore({}, { hasher: FAST_HASH })
})
afterAll(() => booted.stop())

const word = (n: string) => `orbit ${Bun.hash(n)} lanterns drift quietly`
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${booted.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('people management guard', () => {
  test('a member with people.manage is refused on the owner and on themselves', async () => {
    const local = booted.local.rpc.admin.people
    await local.add({ username: 'ben' })
    await local.add({ username: 'cy' })
    await local.setPassword({ person: 'ben', password: word('ben') })
    await local.setPin({ person: 'ben', pin: '730416' })
    await local.grant({ person: 'ben', capability: 'people.manage' })
    const login = await post('/auth/login', { username: 'ben', password: word('ben') })
    const { credential } = (await login.json()) as { credential: string }
    const step = await post(
      '/auth/step-up',
      { pin: '730416' },
      { authorization: `Bearer ${credential}` },
    )
    expect(step.status).toBe(200)
    const ben = booted.tcp(credential).rpc.admin.people
    const owner = (await local.list()).find((p) => p.role === 'owner')?.id as string

    await expect(ben.setPassword({ person: owner, password: word('pwn') })).rejects.toThrow(
      /only the owner/,
    )
    await expect(ben.setPin({ person: owner, pin: '111222' })).rejects.toThrow()
    await expect(ben.clearSecret({ person: owner, kind: 'password' })).rejects.toThrow()
    await expect(ben.unlock({ person: owner })).rejects.toThrow()
    await expect(ben.rename({ person: owner, name: 'Pwned' })).rejects.toThrow()
    await expect(ben.revokeGrant({ person: owner, capability: 'chat' })).rejects.toThrow()
    await expect(
      ben.alias.add({ person: owner, kind: 'email', value: 'x@example.com' }),
    ).rejects.toThrow()
    await expect(ben.transferOwner({ person: 'ben' })).rejects.toThrow(/only the owner/)
    await expect(ben.transferOwner({ person: 'cy' })).rejects.toThrow()
    // self-escalation
    await expect(ben.grant({ person: 'ben', capability: 'settings.manage' })).rejects.toThrow(
      /yourself/,
    )
    await expect(ben.revokeGrant({ person: 'ben', capability: 'people.manage' })).rejects.toThrow(
      /yourself/,
    )
    // audit.read is the owner's alone, even for the owner granting it
    await expect(
      booted.local.rpc.admin.people.grant({ person: 'cy', capability: 'audit.read' }),
    ).rejects.toThrow(/owner role/)
    // still allowed: another member
    expect(await ben.grant({ person: 'cy', capability: 'chat' })).toBeArray()
    expect(await ben.setPin({ person: 'cy', pin: '640219' })).toEqual({ ok: true })
  })

  test('the owner (local socket) keeps full authority, and transfer needs a password or PIN', async () => {
    const local = booted.local.rpc.admin.people
    await local.add({ username: 'dee' })
    await expect(local.transferOwner({ person: 'dee' })).rejects.toThrow(/no password or PIN/)
    await local.setPin({ person: 'dee', pin: '520817' })
    await local.grant({ person: 'dee', capability: 'chat' })
    expect((await local.transferOwner({ person: 'dee' })).owner.username).toBe('dee')
  })
})

describe('sign-in switch (ADR-0027 §27)', () => {
  test('off refuses password sign-in as an unknown person would be, ends the sessions; on works again', async () => {
    const local = booted.local.rpc.admin.people
    await local.add({ username: 'eli' })
    await local.setPassword({ person: 'eli', password: word('eli') })
    const before = await post('/auth/login', { username: 'eli', password: word('eli') })
    expect(before.status).toBe(200)
    const { credential } = (await before.json()) as { credential: string }

    const off = await local.setLogin({ person: 'eli', canLogin: false })
    expect(off).toMatchObject({ username: 'eli', canLogin: false })
    // the open session is gone
    await expect(booted.tcp(credential).rpc.admin.people.list()).rejects.toThrow()
    // a refused sign-in answers exactly what a wrong password answers
    const refused = await post('/auth/login', { username: 'eli', password: word('eli') })
    const wrong = await post('/auth/login', { username: 'eli', password: word('wrong one') })
    expect(refused.status).toBe(wrong.status)
    expect(await refused.json()).toEqual(await wrong.json())

    await local.setLogin({ person: 'eli', canLogin: true })
    const again = await post('/auth/login', { username: 'eli', password: word('eli') })
    expect(again.status).toBe(200)
  })

  test("the owner and the owner's own account are refused; a delegate with people.manage is FORBIDDEN", async () => {
    const local = booted.local.rpc.admin.people
    // the owner is whoever holds the role now (an earlier test transferred it)
    const owner = (await local.list()).find((p) => p.role === 'owner') as { username: string }
    await expect(local.setLogin({ person: owner.username, canLogin: false })).rejects.toThrow(
      /sign-in cannot be switched/,
    )
    await local.add({ username: 'fay' })
    await local.setPassword({ person: 'fay', password: word('fay') })
    await local.setPin({ person: 'fay', pin: '730416' })
    await local.grant({ person: 'fay', capability: 'people.manage' })
    const login = await post('/auth/login', { username: 'fay', password: word('fay') })
    const { credential } = (await login.json()) as { credential: string }
    const step = await post(
      '/auth/step-up',
      { pin: '730416' },
      { authorization: `Bearer ${credential}` },
    )
    expect(step.status).toBe(200)
    await expect(
      booted.tcp(credential).rpc.admin.people.setLogin({ person: 'eli', canLogin: false }),
    ).rejects.toThrow(/only the owner/)
    expect((await local.get({ person: 'eli' })).canLogin).toBe(true)
  })
})

// The succession path of the people service (P29.3.1, docs/specs/succession.md "The claim"): a proof-gated owner swap that
// suspends the previous owner in the same transaction. Plain `transferOwner` keeps its owner-only rule and suspends nobody.
describe('succeed: the heir takes the owner role, the previous owner is suspended', () => {
  const T = Date.UTC(2026, 10, 10, 9)
  function fixture(secrets = new Set(['vian', 'ana'])) {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const store = sqlitePersonStore(db)
    const canLogin = new Map<string, boolean>()
    const revoked: string[] = []
    const changed: string[] = []
    const people = createPeopleService({
      store,
      now: () => T,
      revoke: (id) => {
        revoked.push(id)
        return 1
      },
      hasSecret: (id) => secrets.has(id),
      onAccessChanged: (id, reason) => changed.push(`${id}:${reason}`),
      signIn: {
        canLogin: (id) => canLogin.get(id) ?? true,
        setCanLogin: (id, value) => {
          canLogin.set(id, value)
          return true
        },
      },
    })
    return { db, store, people, revoked, changed, canLogin }
  }
  async function seed(store: ReturnType<typeof sqlitePersonStore>) {
    await store.create(
      { id: 'vian', displayName: 'Vian', username: 'vian', role: 'owner' },
      'system',
      T,
    )
    await store.create({ id: 'ana', displayName: 'Ana', username: 'ana' }, 'system', T)
  }
  const by = { actor: 'ana', via: 'tcp' as const }

  test('the heir becomes the one owner; the previous owner is a suspended member; both sessions revoked', async () => {
    const f = fixture()
    await seed(f.store)
    const moved = await f.people.succeed('ana', mintSuccessionProof(), by)
    expect(moved.owner).toMatchObject({ id: 'ana', role: 'owner', status: 'active' })
    expect(moved.previousOwner).toMatchObject({ id: 'vian', role: 'member', status: 'suspended' })
    expect((await f.store.owner())?.id).toBe('ana')
    const owners = (await f.store.list()).items.filter((p) => p.role === 'owner')
    expect(owners.map((p) => p.id)).toEqual(['ana'])
    expect(f.revoked.sort()).toEqual(['ana', 'vian'])
    expect(f.changed).toEqual(['ana:transfer', 'vian:suspend'])
    const kinds = (await f.store.events('vian')).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['role', 'status']))
    f.db.close()
  })

  test('a suspended heir is refused and nothing moves', async () => {
    const f = fixture()
    await seed(f.store)
    await f.people.suspend('ana', { actor: 'vian', via: 'local' })
    await expect(f.people.succeed('ana', mintSuccessionProof(), by)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect((await f.store.owner())?.id).toBe('vian')
    expect((await f.store.get('vian'))?.status).toBe('active')
    f.db.close()
  })

  test('the heir must be active, able to sign in and hold a secret (F-013); the owner is refused', async () => {
    const noSecret = fixture(new Set(['vian']))
    await seed(noSecret.store)
    await expect(noSecret.people.succeed('ana', mintSuccessionProof(), by)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    noSecret.db.close()

    const noLogin = fixture()
    await seed(noLogin.store)
    noLogin.canLogin.set('ana', false)
    await expect(noLogin.people.succeed('ana', mintSuccessionProof(), by)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect((await noLogin.store.owner())?.id).toBe('vian')
    noLogin.db.close()

    const self = fixture()
    await seed(self.store)
    await expect(self.people.succeed('vian', mintSuccessionProof(), by)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    self.db.close()
  })

  test('plain transferOwner stays owner-only and suspends nobody', async () => {
    const f = fixture()
    await seed(f.store)
    await expect(f.people.transferOwner('vian', by)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const handed = await f.people.transferOwner('ana', { actor: 'vian', via: 'tcp' })
    expect(handed.previousOwner).toMatchObject({ role: 'member', status: 'active' })
    f.db.close()
  })

  test('plain transferOwner refuses a target who cannot sign in (FD13-02) and changes nothing', async () => {
    const f = fixture()
    await seed(f.store)
    f.canLogin.set('ana', false)
    await expect(f.people.transferOwner('ana', { actor: 'vian', via: 'tcp' })).rejects.toThrow(
      /ana cannot sign in: turn sign-in on first \(keith-core people login ana on\)/,
    )
    expect((await f.store.owner())?.id).toBe('vian')
    expect(f.revoked).toEqual([])
    // once sign-in is on again the same transfer goes through
    f.canLogin.set('ana', true)
    const handed = await f.people.transferOwner('ana', { actor: 'vian', via: 'tcp' })
    expect(handed.owner.username).toBe('ana')
    f.db.close()
  })

  test('only the succession module mints the proof (the importers are pinned)', async () => {
    const root = join(import.meta.dir, '..', '..')
    const importers: string[] = []
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root, absolute: true })) {
      if (file.endsWith('.test.ts')) continue
      if ((await Bun.file(file).text()).includes('mintSuccessionProof')) importers.push(file)
    }
    const allowed = join(root, 'modules', 'hypothalamus', 'succession.ts')
    // the people index re-exports the mint (cross-module imports go through index.ts); nothing else may use it
    const allowedFiles = [allowed, join(root, 'modules', 'people', 'index.ts')]
    expect(
      importers.every(
        (file) => allowedFiles.includes(file) || file.endsWith('succession-proof.ts'),
      ),
    ).toBe(true)
  })
})
