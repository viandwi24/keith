import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, settingsRepo } from '@keith/db'
import { LOCK_FILE } from '../modules/admin/index.ts'
import { extractArchive, writeArchive } from '../platform/archive.ts'
import { migrateKeithDatabase, shippedCounts } from '../platform/db.ts'
import { generateSecretKey } from '../platform/vault.ts'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core restore` (P26.2.3, docs/specs/backup.md). Every test works in its own temp folder; none touches a real
// KEITH_HOME. The round trip is backup, wipe, restore, doctor.
const dirs: string[] = []
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

/**
 * The marker of a database file, read by a child process: a database this process migrated keeps a connection that
 * SQLite still ties to the file, so reopening a moved-aside copy in this process fails.
 */
function markerOf(dbFile: string): string | undefined {
  const script =
    "const { Database } = require('bun:sqlite'); const db = new Database(process.argv[1], { readonly: true }); const row = db.query(\"SELECT value FROM settings WHERE key = 'test.marker'\").get(); process.stdout.write(row ? JSON.parse(row.value) : '')"
  const result = Bun.spawnSync([process.execPath, '-e', script, dbFile])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  const value = result.stdout.toString()
  return value === '' ? undefined : value
}

function setMarker(dbFile: string, value: string): void {
  const sqlite = openDatabase(dbFile)
  try {
    settingsRepo(sqlite).set('test.marker', value)
  } finally {
    sqlite.close()
  }
}

/** A data folder with a migrated database, a marker, a secret key, a memory note and a workspace file (mode 0755). */
function fixture(): { dir: string; deps: CliDeps; dbFile: string } {
  const dir = temp('keith-restore-')
  const dbFile = join(dir, 'keith.db')
  migrateKeithDatabase(dir, dbFile)
  setMarker(dbFile, 'before-backup')
  writeFileSync(join(dir, 'secret.key'), generateSecretKey(), { mode: 0o600 })
  mkdirSync(join(dir, 'memory', 'p1'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'p1', 'profile.md'), 'likes tea')
  mkdirSync(join(dir, 'workspace', 'bin'), { recursive: true })
  writeFileSync(join(dir, 'workspace', 'bin', 'run.sh'), 'echo hi')
  Bun.spawnSync(['chmod', '755', join(dir, 'workspace', 'bin', 'run.sh')])
  return { dir, dbFile, deps: { env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' } } }
}

/** Back up a fixture into a folder of its own and return the archive path. */
async function backupOf(deps: CliDeps): Promise<string> {
  const out = temp('keith-restore-out-')
  const io = testIo()
  io.end()
  expect(await runCoreCli(['backup', '--out', out], io, deps)).toBe(0)
  return join(out, readdirSync(out)[0] ?? '')
}

async function run(argv: string[], deps: CliDeps) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, io }
}

/** A copy of `archive` with its entries changed by `mutate` (a folder with the extracted tree). */
async function repack(archive: string, mutate: (dir: string) => void): Promise<string> {
  const tree = temp('keith-repack-')
  await extractArchive(archive, tree)
  mutate(tree)
  const out = temp('keith-repacked-')
  const path = join(out, 'changed.tar')
  await writeArchive(path, [{ dir: tree, names: readdirSync(tree) }])
  return path
}

describe('keith-core restore (P26.2.3)', () => {
  test('round trip: backup, wipe the data folder, restore, doctor reports the database', async () => {
    const { dir, deps, dbFile } = fixture()
    const archive = await backupOf(deps)
    for (const name of ['keith.db', 'keith.db-wal', 'keith.db-shm', 'secret.key'])
      rmSync(join(dir, name), { force: true })
    rmSync(join(dir, 'memory'), { recursive: true, force: true })
    rmSync(join(dir, 'workspace'), { recursive: true, force: true })

    const { code, io } = await run(['restore', archive], deps)
    expect(code).toBe(0)
    expect(io.out()).toContain('run keith-core doctor, then keith-core start')
    expect(markerOf(dbFile)).toBe('before-backup')
    expect(readFileSync(join(dir, 'memory', 'p1', 'profile.md'), 'utf8')).toBe('likes tea')
    expect(mode(join(dir, 'workspace', 'bin', 'run.sh'))).toBe(0o755)
    expect(mode(dbFile)).toBe(0o600)
    expect(mode(join(dir, 'secret.key'))).toBe(0o600)

    const doctor = await run(['doctor', '--offline'], deps)
    expect(doctor.io.out()).toContain('✓ database')
  })

  test('a restore into a folder that does not exist yet creates it (0700) and restores there', async () => {
    const { deps } = fixture()
    const archive = await backupOf(deps)
    const fresh = join(temp('keith-restore-new-'), 'home')
    const { code, io } = await run(['restore', archive], {
      env: { KEITH_DATA_DIR: fresh, KEITH_BUILD_SHA: 'test' },
    })
    expect(code, io.err()).toBe(0)
    expect(mode(fresh)).toBe(0o700)
    expect(markerOf(join(fresh, 'keith.db'))).toBe('before-backup')
  })

  test('a live database without --force is refused and nothing changes', async () => {
    const { dir, deps, dbFile } = fixture()
    const archive = await backupOf(deps)
    setMarker(dbFile, 'after-backup')
    const { code, io } = await run(['restore', archive], deps)
    expect(code).toBe(1)
    expect(io.err()).toContain('run again with --force')
    expect(markerOf(dbFile)).toBe('after-backup')
    expect(readdirSync(dir).some((n) => n.startsWith('restore-previous-'))).toBe(false)
  })

  test('--force moves the files that were there into restore-previous-<stamp>/ and deletes nothing', async () => {
    const { dir, deps, dbFile } = fixture()
    const archive = await backupOf(deps)
    setMarker(dbFile, 'after-backup')
    const { code, io } = await run(['restore', archive, '--force'], deps)
    expect(code).toBe(0)
    const previous = readdirSync(dir).find((n) => n.startsWith('restore-previous-'))
    expect(previous).toBeDefined()
    expect(io.out()).toContain(join(dir, previous ?? ''))
    expect(markerOf(dbFile)).toBe('before-backup')
    expect(markerOf(join(dir, previous ?? '', 'keith.db'))).toBe('after-backup')
  })

  test('a newer archive is refused, with the version that wrote it', async () => {
    const { deps } = fixture()
    const archive = await backupOf(deps)
    const newer = await repack(archive, (tree) => {
      const file = join(tree, 'manifest.json')
      const m = JSON.parse(readFileSync(file, 'utf8'))
      m.migrations.core = shippedCounts().core + 1
      writeFileSync(file, JSON.stringify(m))
    })
    const target = temp('keith-restore-target-')
    const { code, io } = await run(['restore', newer], {
      env: { KEITH_DATA_DIR: target, KEITH_BUILD_SHA: 'test' },
    })
    expect(code).toBe(1)
    expect(io.err()).toContain('this backup is from a newer Keith')
    expect(existsSync(join(target, 'keith.db'))).toBe(false)
  })

  test('a corrupt database inside the archive is refused before anything is moved', async () => {
    const { dir, deps, dbFile } = fixture()
    const archive = await backupOf(deps)
    const broken = await repack(archive, (tree) =>
      writeFileSync(join(tree, 'keith.db'), 'not a database at all'),
    )
    setMarker(dbFile, 'untouched')
    const { code, io } = await run(['restore', broken, '--force'], deps)
    expect(code).toBe(1)
    expect(io.err()).toMatch(/cannot be read|integrity_check/)
    expect(markerOf(dbFile)).toBe('untouched')
    expect(readdirSync(dir).some((n) => n.startsWith('restore-previous-'))).toBe(false)
  })

  test('an archive with an entry Keith does not own, or no manifest, is refused', async () => {
    const { deps } = fixture()
    const archive = await backupOf(deps)
    const extra = await repack(archive, (tree) => writeFileSync(join(tree, 'evil.txt'), 'x'))
    const target = temp('keith-restore-extra-')
    const unexpected = await run(['restore', extra], {
      env: { KEITH_DATA_DIR: target, KEITH_BUILD_SHA: 'test' },
    })
    expect(unexpected.code).toBe(1)
    expect(unexpected.io.err()).toContain('not part of a keith backup')

    const bare = await repack(archive, (tree) => rmSync(join(tree, 'manifest.json')))
    const none = await run(['restore', bare], {
      env: { KEITH_DATA_DIR: target, KEITH_BUILD_SHA: 'test' },
    })
    expect(none.code).toBe(1)
    expect(none.io.err()).toContain('no manifest.json')
  })

  test('an archive with a path that leaves the folder is refused by the safety check', async () => {
    const dir = temp('keith-restore-trav-')
    const bad = join(temp('keith-restore-badtar-'), 'bad.tar')
    // a tar whose only entry is `../escape.txt`, built as ustar bytes
    const header = Buffer.alloc(512)
    header.write('../escape.txt', 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write('00000000003\0', 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    const body = Buffer.alloc(512)
    Buffer.from('boom').copy(body)
    await Bun.write(bad, Buffer.concat([header, body, Buffer.alloc(1024)]))
    const { code, io } = await run(['restore', bad], {
      env: { KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' },
    })
    expect(code).toBe(1)
    expect(io.err()).toContain('leaves the folder')
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false)
  })

  test('a missing archive is refused; a held core.lock refuses the restore', async () => {
    const { dir, deps } = fixture()
    const archive = await backupOf(deps)
    const none = await run(['restore', join(dir, 'nothing.tar')], deps)
    expect(none.code).toBe(1)
    expect(none.io.err()).toContain('does not exist')

    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`)
    try {
      const held = await run(['restore', archive, '--force'], deps)
      expect(held.code).toBe(1)
      expect(held.io.err()).toContain('another keith-core process')
    } finally {
      rmSync(join(dir, LOCK_FILE), { force: true })
    }
  })
})

describe('keith-core restore while a core runs (e2e, P26.2.3)', () => {
  let b: BootedCore
  beforeAll(async () => {
    b = await bootCore()
  })
  afterAll(async () => {
    await b.stop()
  })

  test('refuses: the core must be stopped', async () => {
    const deps: CliDeps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
    const archive = await backupOf(deps)
    const { code, io } = await run(['restore', archive, '--force'], deps)
    expect(code).toBe(1)
    expect(io.err()).toContain('core is running')
  })
})
