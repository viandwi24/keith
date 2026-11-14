import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, settingsRepo } from '@keith/db'
import { extractArchive, readEntries } from '../platform/archive.ts'
import { migrateKeithDatabase, shippedCounts } from '../platform/db.ts'
import { generateSecretKey } from '../platform/vault.ts'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core backup` (P26.2.2, docs/specs/backup.md): a consistent archive while the core runs, mode 0600, the
// manifest, the secret key when it is a file, and nothing that belongs to the running process.
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A data folder with a migrated database, one setting, a secret key file, and a memory and workspace folder. */
function fixture(): { dir: string; deps: CliDeps } {
  const dir = mkdtempSync(join(tmpdir(), 'keith-backup-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  migrateKeithDatabase(dir, dbFile)
  const sqlite = openDatabase(dbFile)
  try {
    settingsRepo(sqlite).set('test.marker', 'kept')
  } finally {
    sqlite.close()
  }
  writeFileSync(join(dir, 'secret.key'), generateSecretKey(), { mode: 0o600 })
  mkdirSync(join(dir, 'memory', 'p1'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'p1', 'profile.md'), 'likes tea')
  mkdirSync(join(dir, 'workspace'), { recursive: true })
  writeFileSync(join(dir, 'workspace', 'core.sock.note'), 'note')
  writeFileSync(join(dir, 'core.lock'), '99999\n')
  return { dir, deps: { env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' } } }
}

async function run(argv: string[], deps: CliDeps) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, io }
}

describe('keith-core backup (P26.2.2)', () => {
  test('writes a 0600 archive with a manifest, a consistent database and the secret key', async () => {
    const { dir, deps } = fixture()
    const out = join(dir, 'out')
    const { code, io } = await run(['backup', '--out', out], deps)
    expect(code).toBe(0)
    const [name] = readdirSync(out)
    expect(name).toMatch(/^keith-backup-\d{8}-\d{6}\.tar$/)
    const archive = join(out, name ?? '')
    expect(statSync(archive).mode & 0o777).toBe(0o600)
    expect(io.out()).toContain(`backup ${archive}`)

    const names = (await readEntries(archive)).map((e) => e.name.replace(/\/$/, ''))
    expect(names).toEqual(
      expect.arrayContaining(['manifest.json', 'keith.db', 'secret.key', 'memory', 'workspace']),
    )
    // the running process's own files and the backups folder are never in it
    for (const forbidden of ['core.sock', 'core.lock', 'backups', 'exports', 'logs'])
      expect(names.some((n) => n === forbidden || n.startsWith(`${forbidden}/`))).toBe(false)
  })

  test('the manifest says the version, the time and the migrations applied; the database inside opens', async () => {
    const { dir, deps } = fixture()
    const out = join(dir, 'out')
    await run(['backup', '--out', out], deps)
    const [name] = readdirSync(out)
    const extract = join(dir, 'extracted')
    await extractArchive(join(out, name ?? ''), extract)
    const manifest = JSON.parse(await Bun.file(join(extract, 'manifest.json')).text())
    expect(typeof manifest.version).toBe('string')
    expect(Date.parse(manifest.createdAt)).not.toBeNaN()
    expect(manifest.migrations.core).toBe(shippedCounts().core)
    expect(manifest.includes).toEqual(expect.arrayContaining(['keith.db', 'secret.key']))
    const copy = openDatabase(join(extract, 'keith.db'))
    try {
      expect(settingsRepo(copy).get<string>('test.marker')).toBe('kept')
    } finally {
      copy.close()
    }
  })

  test('a second backup in the same second gets its own name: an archive is never overwritten', async () => {
    const { dir, deps } = fixture()
    const out = join(dir, 'out')
    await run(['backup', '--out', out], deps)
    await run(['backup', '--out', out], deps)
    expect(readdirSync(out).length).toBeGreaterThanOrEqual(1)
    expect(new Set(readdirSync(out)).size).toBe(readdirSync(out).length)
  })

  test('no database is refused with the setup hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-backup-empty-'))
    dirs.push(dir)
    const { code, io } = await run(['backup'], { env: { KEITH_DATA_DIR: dir } })
    expect(code).toBe(1)
    expect(io.err()).toContain('no database to back up: run keith-core setup')
  })

  test('a key that comes from KEITH_SECRET_KEY is not in the archive, and the command says so', async () => {
    const { dir } = fixture()
    const out = join(dir, 'out-env')
    const deps: CliDeps = {
      env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test', KEITH_SECRET_KEY: generateSecretKey() },
    }
    const { code, io } = await run(['backup', '--out', out], deps)
    expect(code).toBe(0)
    expect(io.out()).toContain('NOT in the archive')
  })
})

describe('keith-core backup while the core runs (e2e, P26.2.2)', () => {
  let b: BootedCore
  beforeAll(async () => {
    b = await bootCore()
  })
  afterAll(async () => {
    await b.stop()
  })

  test('the archive is written while the core is running and holds no socket', async () => {
    const out = join(b.dir, 'live-out')
    const { code } = await run(['backup', '--out', out], {
      env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' },
    })
    expect(code).toBe(0)
    const [name] = readdirSync(out)
    const names = (await readEntries(join(out, name ?? ''))).map((e) => e.name.replace(/\/$/, ''))
    expect(names).toContain('keith.db')
    expect(names.some((n) => n.startsWith('core.sock'))).toBe(false)
  })
})
