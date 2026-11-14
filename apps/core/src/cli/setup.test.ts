import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditRepo, openDatabase } from '@keith/db'
import { scriptedProvider } from 'eharness/testing'
import { openOfflineAdmin } from '../modules/admin/index.ts'
import { DEFAULT_MONTHLY_LIMIT_USD } from '../modules/budget/index.ts'
import { testIo } from '../testing/cli-io.ts'
import { type CliDeps, configOf } from './context.ts'
import { runCoreCli } from './program.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const PIN = '482915'

function newDeps(): CliDeps {
  const dir = mkdtempSync(join(tmpdir(), 'keith-setup-'))
  dirs.push(dir)
  return {
    env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'cli' },
    offline: {
      definitions: [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })],
      catalogs: { offline: true },
    },
    hasher: { memoryCost: 1024, timeCost: 1 },
  }
}

const HEADLESS = [
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
  '--owner-pin-stdin',
]

async function run(argv: string[], deps: CliDeps, stdin = '') {
  const io = testIo()
  if (stdin !== '') io.send(stdin)
  io.end()
  return { code: await runCoreCli(argv, io, deps), io }
}

/** The monthly limit as the offline admin reads it (null means removed). */
async function limitOf(deps: CliDeps): Promise<number | null> {
  const admin = await openOfflineAdmin(configOf(deps), { migrate: true, ...deps.offline })
  try {
    return admin.budget.status().limitUsd
  } finally {
    admin.close()
  }
}

describe('setup: the monthly limit survives a headless re-run (P24.4.1, ADR-0027 §24)', () => {
  test('a fresh headless setup without --budget sets the default limit', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    expect(await limitOf(deps)).toBe(DEFAULT_MONTHLY_LIMIT_USD)
  })

  test('a limit the owner removed stays removed when setup re-runs without --budget', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    const admin = await openOfflineAdmin(configOf(deps), { migrate: true, ...deps.offline })
    admin.budget.set(null)
    admin.close()
    expect(await limitOf(deps)).toBeNull()

    const again = await run(['setup', '--non-interactive'], deps)
    expect(again.code).toBe(0)
    expect(await limitOf(deps)).toBeNull()
  })

  test('an explicit --budget still changes the limit on a re-run', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    expect((await run(['setup', '--non-interactive', '--budget', '35'], deps)).code).toBe(0)
    expect(await limitOf(deps)).toBe(35)
  })
})

describe('setup: the name goes to the current owner (P24.4.2, ADR-0027 §24)', () => {
  test('after an ownership transfer a headless re-run renames the new owner and leaves the former one alone', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    const sqlite = openDatabase(configOf(deps).dbFile)
    sqlite.query("UPDATE people SET role = 'member' WHERE id = 'owner'").run()
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES ('ana', 'Ana', 'owner', 0, 'ana', 0)",
      )
      .run()
    sqlite.close()

    const r = await run(
      ['setup', '--non-interactive', '--owner-name', 'Ana Lee', '--owner-pin-stdin'],
      deps,
      `${PIN}\n`,
    )
    expect(r.code).toBe(0)
    const after = openDatabase(configOf(deps).dbFile)
    const names = Object.fromEntries(
      after
        .query<{ id: string; name: string }, []>('SELECT id, name FROM people')
        .all()
        .map((p) => [p.id, p.name]),
    )
    after.close()
    expect(names.ana).toBe('Ana Lee')
    expect(names.owner).toBe('Vian')
  })
})

describe('setup: the owner username (FD10-03, ADR-0027 §24)', () => {
  const usernameOf = (deps: CliDeps, id: string): string | null | undefined => {
    const sqlite = openDatabase(configOf(deps).dbFile)
    try {
      return sqlite
        .query<{ username: string | null }, [string]>('SELECT username FROM people WHERE id = ?')
        .get(id)?.username
    } finally {
      sqlite.close()
    }
  }

  test('--owner-username renames the owner through the people service, audited offline; a re-run keeps it', async () => {
    const deps = newDeps()
    expect((await run([...HEADLESS, '--owner-username', 'vian'], deps, `${PIN}\n`)).code).toBe(0)
    expect(usernameOf(deps, 'owner')).toBe('vian')
    const sqlite = openDatabase(configOf(deps).dbFile)
    const rows = auditRepo(sqlite).list(100)
    sqlite.close()
    expect(rows.find((r) => r.kind === 'person.update')).toMatchObject({ via: 'offline' })

    expect((await run(['setup', '--non-interactive'], deps)).code).toBe(0)
    expect(usernameOf(deps, 'owner')).toBe('vian')
  })

  test('a taken or malformed username is a usage error and changes nothing else', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    const sqlite = openDatabase(configOf(deps).dbFile)
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES ('ana', 'Ana', 'member', 0, 'ana', 0)",
      )
      .run()
    sqlite.close()

    const taken = await run(
      ['setup', '--non-interactive', '--owner-name', 'Other', '--owner-username', 'ana'],
      deps,
    )
    expect(taken.code).toBe(2)
    expect(taken.io.err()).toContain('taken')
    expect(usernameOf(deps, 'owner')).toBe('owner')
    expect(usernameOf(deps, 'ana')).toBe('ana')

    const bad = await run(['setup', '--non-interactive', '--owner-username', 'X!'], deps)
    expect(bad.code).toBe(2)
  })

  test('after a transfer the former owner keeps owner, and the new owner cannot take that name', async () => {
    const deps = newDeps()
    expect((await run(HEADLESS, deps, `${PIN}\n`)).code).toBe(0)
    const sqlite = openDatabase(configOf(deps).dbFile)
    sqlite.query("UPDATE people SET role = 'member' WHERE id = 'owner'").run()
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES ('ana', 'Ana', 'owner', 0, 'ana', 0)",
      )
      .run()
    sqlite.close()

    const r = await run(['setup', '--non-interactive', '--owner-username', 'owner'], deps)
    expect(r.code).toBe(2)
    expect(usernameOf(deps, 'ana')).toBe('ana')
    expect(usernameOf(deps, 'owner')).toBe('owner')
  })
})
