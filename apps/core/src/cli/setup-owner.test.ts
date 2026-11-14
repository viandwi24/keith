import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditRepo,
  credentialsRepo,
  identifiersRepo,
  openDatabase,
  secretsRepo,
  tokensRepo,
} from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { openOfflineAdmin } from '../modules/admin/index.ts'
import { createHasher } from '../modules/auth/index.ts'
import { testIo } from '../testing/cli-io.ts'
import { type CliDeps, configOf } from './context.ts'
import { runCoreCli } from './program.ts'
import { applySetup } from './setup-apply.ts'
import { ensureOwnerSignIn, NO_SIGN_IN, ownerHasSignIn } from './start.ts'

/** The required "Owner sign-in" step of setup, the doctor check and the start-time check. */
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const PIN = '482915'
const PASSWORD = `purple ${Bun.hash('owner')} tractors orbit mars slowly`

function newDeps(): CliDeps & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keith-owner-'))
  dirs.push(dir)
  return {
    dir,
    env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'cli' },
    offline: {
      definitions: [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })],
      catalogs: { offline: true },
    },
    hasher: { memoryCost: 1024, timeCost: 1 },
  }
}
const BASE = [
  'setup',
  '--non-interactive',
  '--owner-name',
  'Vian',
  '--provider',
  'scripted',
  '--front-model',
  'a',
  '--cortex-model',
  'b',
  '--budget',
  '30',
]
async function run(argv: string[], deps: CliDeps, stdin?: string) {
  const io = testIo()
  if (stdin !== undefined) io.send(stdin)
  io.end()
  return { code: await runCoreCli(argv, io, deps), io }
}
const state = (deps: CliDeps & { dir: string }) => {
  const sqlite = openDatabase(configOf(deps).dbFile)
  try {
    const owner = tokensRepo(sqlite).owner()
    return {
      owner,
      kinds: owner === undefined ? [] : [...secretsRepo(sqlite).kinds(owner.id)].sort(),
      audit: auditRepo(sqlite).list(100),
    }
  } finally {
    sqlite.close()
  }
}

describe('setup: the required owner sign-in', () => {
  test('a headless setup without a PIN or a password is a usage error naming the flags, and saves nothing as done', async () => {
    const deps = newDeps()
    const r = await run(BASE, deps)
    expect(r.code).toBe(2)
    expect(r.io.err()).toContain('--owner-pin-stdin')
    expect(ownerHasSignIn(configOf(deps).dbFile)).toBe(false)
  })

  test('PIN and password come from stdin (never argv), are audited without a secret, and the username can be chosen', async () => {
    const deps = newDeps()
    const r = await run(
      [...BASE, '--owner-pin-stdin', '--owner-password-stdin', '--owner-username', 'vian'],
      deps,
      `${PIN}\n${PASSWORD}\n`,
    )
    expect(r.code).toBe(0)
    expect(r.io.out()).toContain('sign-in   password + pin')
    const s = state(deps)
    expect(s.owner?.username).toBe('vian')
    expect(s.kinds).toEqual(['password', 'pin'])
    const event = s.audit.find((e) => e.kind === 'setup.owner_signin')
    expect(event?.detail).toMatchObject({ methods: ['password', 'pin'] })
    const text = JSON.stringify(s.audit) + r.io.out() + r.io.err()
    expect(text).not.toContain(PIN)
    expect(text).not.toContain(PASSWORD)
  })

  test('a refused PIN, a weak password and a bad username are usage errors', async () => {
    expect((await run([...BASE, '--owner-pin-stdin'], newDeps(), '12\n')).code).toBe(2)
    const weak = await run([...BASE, '--owner-password-stdin'], newDeps(), 'short\n')
    expect(weak.code).toBe(2)
    expect(weak.io.err()).toContain('password was refused')
    const name = await run(
      [...BASE, '--owner-pin-stdin', '--owner-username', 'X!'],
      newDeps(),
      `${PIN}\n`,
    )
    expect(name.code).toBe(2)
  })

  test("setting a secret offline ends the owner's older sessions and audits it", async () => {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const sqlite = openDatabase(configOf(deps).dbFile)
    const credentials = credentialsRepo(sqlite)
    credentials.create({
      id: 'leaked',
      personId: 'owner',
      kind: 'device',
      label: 'leaked',
      secretHash: 'x',
    })
    sqlite.close()
    await run(['setup', '--non-interactive', '--owner-password-stdin'], deps, `${PASSWORD}\n`)
    const after = openDatabase(configOf(deps).dbFile)
    expect(credentialsRepo(after).find('leaked')?.revokedAt).not.toBeNull()
    after.close()
    const event = state(deps).audit.find((e) => e.kind === 'person.sessions.revoked')
    expect(event).toMatchObject({ via: 'offline' })
    expect(event?.detail).toMatchObject({ personId: 'owner', count: 1 })
  })

  test('re-running keeps the credentials; a flag changes them on request', async () => {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const sqlite = openDatabase(configOf(deps).dbFile)
    const before = secretsRepo(sqlite).get('owner', 'pin')?.hash
    sqlite.close()
    expect((await run(['setup', '--non-interactive'], deps)).code).toBe(0)
    const kept = openDatabase(configOf(deps).dbFile)
    expect(secretsRepo(kept).get('owner', 'pin')?.hash).toBe(before)
    kept.close()
    expect(
      (await run(['setup', '--non-interactive', '--owner-pin-stdin'], deps, '654321\n')).code,
    ).toBe(0)
    const changed = openDatabase(configOf(deps).dbFile)
    expect(secretsRepo(changed).get('owner', 'pin')?.hash).not.toBe(before)
    changed.close()
  })
})

describe('an install that is set up but has no owner sign-in', () => {
  async function bare() {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const sqlite = openDatabase(configOf(deps).dbFile)
    secretsRepo(sqlite).clear('owner', 'pin')
    sqlite.close()
    return deps
  }

  test('doctor reports owner sign-in as a failure with the command', async () => {
    const deps = await bare()
    const r = await run(['doctor'], deps)
    expect(r.code).not.toBe(0)
    expect(r.io.out()).toMatch(/owner sign-in/)
    expect(r.io.out()).toContain('keith-core setup')
    const ok = newDeps()
    await run([...BASE, '--owner-pin-stdin'], ok, `${PIN}\n`)
    expect((await run(['doctor'], ok)).io.out()).toMatch(/owner sign-in.*set: pin/)
  })

  test('doctor fails an owner who has a PIN but cannot sign in (FD13-08)', async () => {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const sqlite = openDatabase(configOf(deps).dbFile)
    const owner = tokensRepo(sqlite).owner()
    identifiersRepo(sqlite).setCanLogin(owner?.id ?? '', false)
    sqlite.close()
    const r = await run(['doctor'], deps)
    expect(r.code).not.toBe(0)
    expect(r.io.out()).toMatch(/owner sign-in.*cannot sign in/)
    expect(r.io.out()).toContain('transfer-owner')
  })

  test('start without a terminal prints the one-line instruction and does not set anything', async () => {
    const deps = await bare()
    const io = testIo()
    io.end()
    expect(await ensureOwnerSignIn(io, deps)).toBe(false)
    expect(io.err()).toContain(NO_SIGN_IN)
    expect(ownerHasSignIn(configOf(deps).dbFile)).toBe(false)
  })

  test('start on a terminal offers to set a PIN, asked twice, then the owner can sign in', async () => {
    const deps = await bare()
    const io = testIo()
    io.isTTY = true
    // confirm (Enter = yes), then the PIN twice (no raw mode on a PassThrough: one line each)
    io.send(`\n${PIN}\n${PIN}\n`)
    io.end()
    expect(await ensureOwnerSignIn(io, deps)).toBe(true)
    expect(ownerHasSignIn(configOf(deps).dbFile)).toBe(true)
    expect(io.out() + io.err()).not.toContain(PIN)
  })
})

describe('setup: audit rows (P23.3.1, ADR-0027 §7)', () => {
  const KEY_A = ['sk', 'setup', String(Bun.hash('first-key'))].join('-')
  const offlineRows = (deps: CliDeps & { dir: string }) =>
    state(deps).audit.filter((e) => e.via === 'offline')

  test('a headless setup writes one offline row per change, and none holds a secret', async () => {
    const deps = newDeps()
    const r = await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    expect(r.code).toBe(0)
    const kinds = offlineRows(deps)
      .map((e) => e.kind)
      .sort()
    expect(kinds).toEqual(
      [
        'person.secret.set',
        'person.update',
        'setup.done',
        'setup.owner_signin',
        'settings.access.set',
        'settings.budget.set',
        'settings.model.set',
        'settings.model.set',
        'settings.provider.add',
      ].sort(),
    )
    expect(state(deps).audit.find((e) => e.kind === 'settings.provider.add')?.detail).toEqual({
      connection: 'scripted',
      provider: 'scripted',
    })
    expect(state(deps).audit.find((e) => e.kind === 'settings.budget.set')?.detail).toEqual({
      limitUsd: 30,
    })
    expect(JSON.stringify(state(deps).audit)).not.toContain(PIN)
  })

  test('a new key for a saved connection is settings.provider.key, never a second add', async () => {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const config = configOf(deps)
    const admin = await openOfflineAdmin(config, { ...deps.offline, migrate: true })
    try {
      const summary = await applySetup(
        admin,
        {
          name: 'Vian',
          provider: { pid: 'scripted', exists: true, apiKey: KEY_A },
          connection: 'scripted',
          models: { front: 'a', cortex: 'b' },
          budget: '30',
          mode: 'local',
        },
        createHasher(deps.hasher),
      )
      expect(summary.connection).toBe('scripted')
    } finally {
      admin.close()
    }
    const rows = offlineRows(deps)
    expect(rows.filter((e) => e.kind === 'settings.provider.add')).toHaveLength(1)
    expect(rows.filter((e) => e.kind === 'settings.provider.key')).toEqual([
      expect.objectContaining({ detail: { connection: 'scripted' }, via: 'offline' }),
    ])
    expect(JSON.stringify(state(deps).audit)).not.toContain(KEY_A)
  })

  test('the wizard path (applySetup) writes the same rows as the flag flow', async () => {
    const flags = newDeps()
    await run([...BASE, '--owner-pin-stdin'], flags, `${PIN}\n`)
    const wizard = newDeps()
    const admin = await openOfflineAdmin(configOf(wizard), { ...wizard.offline, migrate: true })
    try {
      await applySetup(
        admin,
        {
          name: 'Vian',
          provider: { pid: 'scripted', exists: false },
          connection: 'scripted',
          models: { front: 'a', cortex: 'b' },
          budget: '30',
          mode: 'local',
          pin: PIN,
        },
        createHasher(wizard.hasher),
      )
    } finally {
      admin.close()
    }
    const shape = (deps: CliDeps & { dir: string }) =>
      offlineRows(deps)
        .map((e) => e.kind)
        .sort()
    expect(shape(wizard)).toEqual(shape(flags))
  })
})

describe('setup: the owner display name is audited (FD13-03)', () => {
  test('a headless run that renames the owner writes a person.update row, via offline', async () => {
    const deps = newDeps()
    await run([...BASE, '--owner-pin-stdin'], deps, `${PIN}\n`)
    const renamed = state(deps).audit.filter(
      (e) => e.kind === 'person.update' && e.via === 'offline',
    )
    expect(renamed.length).toBeGreaterThan(0)
    expect(renamed.at(-1)?.detail).toMatchObject({ fields: ['displayName'] })
    expect(state(deps).owner?.name).toBe('Vian')
  })
})
