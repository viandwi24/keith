import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditRepo, migrateDatabase, openDatabase, settingsRepo } from '@keith/db'
import { alphaPlugin, betaTwoPlugin } from '@keith/host/testing'
import { createCore } from '../compose.ts'
import { runCore, StartError } from '../run-core.ts'
import { migrateAll } from '../testing/migrate-all.ts'
import { loadConfig } from './config.ts'
import {
  BackupError,
  backupDatabase,
  dbState,
  migrateKeithDatabase,
  migrateWithBackup,
  OWNED_ENTRIES,
  type OwnedFs,
  openKeithDatabase,
  openReadOnlyDatabase,
  ownedPaths,
  pruneSnapshots,
  refusalOf,
  secureDataDir,
} from './db.ts'
import { type FileLogger, silentLogger } from './logger.ts'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const modeOf = (path: string): number => statSync(path).mode & 0o777

describe('data folder permissions', () => {
  test('a new database and a booted core are owner-only under a permissive umask', async () => {
    const old = process.umask(0o022)
    try {
      const root = mkdtempSync(join(tmpdir(), 'keith-perm-'))
      roots.push(root)
      const dataDir = join(root, 'data')
      const config = loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'perm' })
      // the opener alone: file mode before SQLite writes anything
      mkdirSync(dataDir, { recursive: true, mode: 0o755 })
      const sqlite = openDatabase(config.dbFile)
      migrateAll(sqlite)
      sqlite.close()
      expect(modeOf(config.dbFile) & 0o077).toBe(0)

      // an older install: loose modes everywhere, including a nested file
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      writeFileSync(join(dataDir, 'logs', 'keith-2026-01-01.log'), 'x')
      chmodSync(join(dataDir, 'logs', 'keith-2026-01-01.log'), 0o644)
      chmodSync(config.dbFile, 0o644)

      const core = await createCore({
        config,
        logger: silentLogger,
        catalogs: { offline: true },
        timing: { inboxPollMs: 20, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 },
      })
      await core.close()
      const paths = [
        dataDir,
        join(dataDir, 'logs'),
        join(dataDir, 'logs', 'keith-2026-01-01.log'),
        config.dbFile,
        join(dataDir, 'instance-id'),
        `${config.dbFile}-wal`,
        `${config.dbFile}-shm`,
      ]
      for (const path of paths) {
        try {
          expect(`${path} ${(modeOf(path) & 0o077).toString(8)}`).toBe(`${path} 0`)
        } catch (error) {
          if (!/ENOENT/.test(String(error))) throw error // wal/shm are gone after a clean close
        }
      }
      secureDataDir(dataDir)
      expect(modeOf(dataDir)).toBe(0o700)
    } finally {
      process.umask(old)
    }
  })

  test('openKeithDatabase creates the folder 0700', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-perm-'))
    roots.push(root)
    const dataDir = join(root, 'fresh')
    const config = loadConfig({ KEITH_DATA_DIR: dataDir })
    const bootstrap = openDatabase(config.dbFile)
    migrateAll(bootstrap)
    bootstrap.close()
    const sqlite = await openKeithDatabase(dataDir, config.dbFile)
    sqlite.close()
    expect(modeOf(dataDir)).toBe(0o700)
  })
})

describe('owned entries of the data folder (FD11-02)', () => {
  /** A data folder with Keith's own files loose, and a workspace whose modes a worker chose. */
  function looseFolder(): { root: string; dataDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'keith-owned-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    const put = (path: string, mode: number): void => {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 })
      writeFileSync(path, 'x')
      chmodSync(path, mode)
    }
    mkdirSync(dataDir, { mode: 0o755 })
    chmodSync(dataDir, 0o755)
    put(join(dataDir, 'keith.db'), 0o644)
    put(join(dataDir, 'secret.key'), 0o644)
    put(join(dataDir, 'logs', 'keith-2026-11-01.log'), 0o644)
    put(join(dataDir, 'exports', 'alice.tar'), 0o644)
    put(join(dataDir, 'workspace', 'people', 'p1', 'run.sh'), 0o755)
    put(join(dataDir, 'workspace', 'people', 'p1', '.git', 'hooks', 'pre-commit'), 0o755)
    put(join(dataDir, 'memory', 'p1', 'note.md'), 0o644)
    return { root, dataDir }
  }

  test('Keith files become private; the workspace keeps the modes its owner gave', () => {
    const { dataDir } = looseFolder()
    expect(secureDataDir(dataDir)).toEqual([])
    expect(modeOf(dataDir)).toBe(0o700)
    expect(modeOf(join(dataDir, 'keith.db'))).toBe(0o600)
    expect(modeOf(join(dataDir, 'secret.key'))).toBe(0o600)
    expect(modeOf(join(dataDir, 'logs'))).toBe(0o700)
    expect(modeOf(join(dataDir, 'logs', 'keith-2026-11-01.log'))).toBe(0o600)
    expect(modeOf(join(dataDir, 'exports', 'alice.tar'))).toBe(0o600)
    expect(modeOf(join(dataDir, 'workspace', 'people', 'p1', 'run.sh'))).toBe(0o755)
    expect(modeOf(join(dataDir, 'workspace', 'people', 'p1', '.git', 'hooks', 'pre-commit'))).toBe(
      0o755,
    )
    expect(modeOf(join(dataDir, 'memory', 'p1', 'note.md'))).toBe(0o644)
  })

  test('the owned list is the only walk: a 5 000 file workspace is never listed or stat-ed', () => {
    const { dataDir } = looseFolder()
    const deps = join(dataDir, 'workspace', 'people', 'p1', 'node_modules')
    mkdirSync(deps, { recursive: true })
    for (let i = 0; i < 5_000; i++) writeFileSync(join(deps, `f${i}.js`), '')
    const stats: string[] = []
    const listed: string[] = []
    const counted: OwnedFs = {
      lstatSync: (path) => {
        stats.push(path)
        return lstatSync(path)
      },
      readdirSync: (path) => {
        listed.push(path)
        return readdirSync(path)
      },
      chmodSync,
    }
    secureDataDir(dataDir, counted)
    expect(stats.length).toBeLessThan(50)
    expect(listed.some((path) => path.includes('workspace'))).toBe(false)
    expect(stats.some((path) => path.includes('workspace'))).toBe(false)
  })

  test('an entry that cannot be changed is a warning, never a throw', () => {
    const { dataDir } = looseFolder()
    const failing: OwnedFs = {
      lstatSync,
      readdirSync: (path) => {
        if (path.endsWith('logs')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return readdirSync(path)
      },
      chmodSync: (path, mode) => {
        if (path.endsWith('secret.key')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        chmodSync(path, mode)
      },
    }
    const warnings = secureDataDir(dataDir, failing)
    expect(warnings.some((w) => w.includes('secret.key'))).toBe(true)
    expect(warnings.some((w) => w.includes('logs') && w.includes('cannot be read'))).toBe(true)
    expect(modeOf(join(dataDir, 'keith.db'))).toBe(0o600)
  })

  test('an unreadable folder in the workspace does not stop the owned walk', () => {
    const { dataDir } = looseFolder()
    const locked = join(dataDir, 'workspace', 'people', 'p2')
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(secureDataDir(dataDir)).toEqual([])
      expect(modeOf(join(dataDir, 'keith.db'))).toBe(0o600)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test('ownedPaths lists only the constant list, with the mode each entry must have', () => {
    const { dataDir } = looseFolder()
    const owned = ownedPaths(dataDir).map(
      ({ path, mode }) => `${path.slice(dataDir.length + 1)}:${mode.toString(8)}`,
    )
    expect(owned).toContain(':700')
    expect(owned).toContain('keith.db:600')
    expect(owned).toContain('logs:700')
    expect(owned).toContain(`${join('logs', 'keith-2026-11-01.log')}:600`)
    expect(owned.some((entry) => entry.startsWith('workspace'))).toBe(false)
    expect(OWNED_ENTRIES.files).toContain('core.lock')
    expect(OWNED_ENTRIES.folders).toEqual(['logs', 'backups', 'exports'])
  })
})

describe('migrateWithBackup (ADR-0027 §3)', () => {
  const plugins = [alphaPlugin(), betaTwoPlugin()]
  const lines: string[] = []
  const log = { debug() {}, info: (m: string) => lines.push(m), warn() {}, error() {} }

  /** A database built from the core migrations with one settings row, and the plugins' tables still missing. */
  function behindDatabase(): { dataDir: string; dbFile: string } {
    const root = mkdtempSync(join(tmpdir(), 'keith-backup-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const dbFile = join(dataDir, 'keith.db')
    const sqlite = openDatabase(dbFile)
    migrateDatabase(sqlite)
    settingsRepo(sqlite).set('test.marker', 'kept')
    sqlite.close()
    return { dataDir, dbFile }
  }

  const tableNames = (dbFile: string): string[] => {
    const sqlite = openDatabase(dbFile)
    try {
      return sqlite
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name)
    } finally {
      sqlite.close()
    }
  }

  test('a new database is created with no backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-backup-'))
    roots.push(root)
    const dataDir = join(root, 'fresh')
    const dbFile = join(dataDir, 'keith.db')
    const outcome = migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline')
    expect(outcome.kind).toBe('created')
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    expect(tableNames(dbFile)).toContain('plg_alpha_items')
  })

  test('a behind database gets a snapshot with its rows, then migrates and is audited', () => {
    const { dataDir, dbFile } = behindDatabase()
    lines.length = 0
    const outcome = migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline')
    expect(outcome.kind).toBe('migrated')
    if (outcome.kind !== 'migrated') return
    const { backup } = outcome
    expect(backup.startsWith(join(dataDir, 'backups', 'keith-'))).toBe(true)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'backups')).mode & 0o777).toBe(0o700)

    // the snapshot is the database as it was: old rows, no plugin tables, integrity ok
    const copy = openReadOnlyDatabase(backup)
    expect(
      copy
        .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'test.marker'")
        .get()?.value,
    ).toBe('"kept"')
    expect(
      copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
    ).toBe('ok')
    expect(
      copy
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'plg_alpha_items'",
        )
        .get()?.n,
    ).toBe(0)
    copy.close()

    // the live database has the plugin tables, the same row and an audit row that names the snapshot
    expect(tableNames(dbFile)).toContain('plg_alpha_items')
    const sqlite = openDatabase(dbFile)
    expect(settingsRepo(sqlite).get('test.marker')).toBe('kept')
    const row = auditRepo(sqlite)
      .list(5)
      .find((r) => r.kind === 'db.migrated')
    expect(row?.via).toBe('offline')
    // `from` and `to` count the core's journal rows: all 29 are applied by `migrateDatabase` before the plugin tables are added
    expect(row?.detail).toMatchObject({ backup, from: 29, to: 29, pluginMigrations: 3 })
    sqlite.close()

    expect(lines.some((l) => l.includes('was behind: applying') && l.includes(backup))).toBe(true)
    // an up-to-date database makes no snapshot
    expect(migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline').kind).toBe('current')
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1)
  })

  test('a snapshot that cannot be written refuses the migration and changes nothing', () => {
    const { dataDir, dbFile } = behindDatabase()
    const backups = join(dataDir, 'backups')
    mkdirSync(backups, { mode: 0o700 })
    chmodSync(backups, 0o500) // read only: VACUUM INTO cannot create the copy
    try {
      expect(() => migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline')).toThrow(
        BackupError,
      )
      expect(() => migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline')).toThrow(
        /could not back up the database: .*; nothing was changed/,
      )
      expect(tableNames(dbFile)).not.toContain('plg_alpha_items')
      expect(readdirSync(backups)).toHaveLength(0)
    } finally {
      chmodSync(backups, 0o700)
    }
  })

  test('the sixth snapshot deletes the oldest, and never a file that is not a snapshot', () => {
    const { dataDir, dbFile } = behindDatabase()
    const backups = join(dataDir, 'backups')
    mkdirSync(backups, { mode: 0o700 })
    for (let i = 0; i < 5; i++)
      copyFileSync(dbFile, join(backups, `keith-2025010${i + 1}-000000.db`))
    writeFileSync(join(backups, 'owner-archive.tar'), 'mine')
    migrateWithBackup({ dataDir, dbFile }, plugins, log, 'offline')
    const kept = readdirSync(backups).filter((n) => n.endsWith('.db'))
    expect(kept).toHaveLength(5)
    expect(kept).not.toContain('keith-20250101-000000.db')
    expect(readdirSync(backups)).toContain('owner-archive.tar')
  })

  test('pruneSnapshots keeps the newest five of the snapshots it made', () => {
    const { dataDir, dbFile } = behindDatabase()
    for (let i = 0; i < 6; i++) backupDatabase(dataDir, dbFile, new Date(2026, 0, 1, 0, 0, i))
    const removed = pruneSnapshots(join(dataDir, 'backups'), 5)
    expect(removed).toHaveLength(1)
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(5)
  })
})

describe('database states and refusals (ADR-0027 §3, FD11-01, FD11-10)', () => {
  const plugins = [alphaPlugin()]
  const refusedText =
    /this database was migrated by a newer Keith \(\d+ applied, this build ships \d+\): update Keith, or `keith-core restore` a backup made before the upgrade/

  /** A data folder whose database is fully migrated (core and the plugin's tables). */
  function readyDatabase(): { dataDir: string; dbFile: string } {
    const root = mkdtempSync(join(tmpdir(), 'keith-state-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const dbFile = join(dataDir, 'keith.db')
    migrateKeithDatabase(dataDir, dbFile, plugins)
    return { dataDir, dbFile }
  }

  const rowsOf = (dbFile: string, table: string): number => {
    const sqlite = openReadOnlyDatabase(dbFile)
    try {
      return sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? 0
    } finally {
      sqlite.close()
    }
  }

  test('a fully migrated database is ready; a missing file is missing', () => {
    const { dataDir, dbFile } = readyDatabase()
    expect(dbState(dbFile, plugins)).toEqual({ kind: 'ready' })
    expect(dbState(join(dataDir, 'nothing.db'), plugins)).toEqual({ kind: 'missing' })
  })

  test('an extra migration row is ahead: refused, with no snapshot and nothing changed', async () => {
    const { dataDir, dbFile } = readyDatabase()
    const sqlite = openDatabase(dbFile)
    sqlite.exec(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-a-newer-build', 1)",
    )
    sqlite.close()
    const state = dbState(dbFile, plugins)
    expect(state).toMatchObject({ kind: 'ahead', journal: 'core' })
    expect(refusalOf(state, { dataDir })).toMatch(refusedText)
    const before = rowsOf(dbFile, '__drizzle_migrations')
    expect(() => migrateWithBackup({ dataDir, dbFile }, plugins, silentLogger, 'offline')).toThrow(
      refusedText,
    )
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    expect(rowsOf(dbFile, '__drizzle_migrations')).toBe(before)
    await expect(openKeithDatabase(dataDir, dbFile, plugins)).rejects.toThrow(refusedText)
  })

  test('the same count with another hash is diverged', () => {
    const { dataDir, dbFile } = readyDatabase()
    const sqlite = openDatabase(dbFile)
    sqlite.exec(
      "UPDATE __drizzle_migrations SET hash = 'other-branch' WHERE created_at = (SELECT min(created_at) FROM __drizzle_migrations)",
    )
    sqlite.close()
    const state = dbState(dbFile, plugins)
    expect(state.kind).toBe('diverged')
    expect(refusalOf(state, { dataDir })).toMatch(refusedText)
  })

  test('a plugin journal that is ahead is refused and named', () => {
    const { dataDir, dbFile } = readyDatabase()
    const sqlite = openDatabase(dbFile)
    sqlite.exec("INSERT INTO __plg_alpha_migrations (hash, created_at) VALUES ('newer', 1)")
    sqlite.close()
    const state = dbState(dbFile, plugins)
    expect(state).toMatchObject({ kind: 'ahead', journal: 'plugin alpha' })
    expect(refusalOf(state, { dataDir })).toMatch(/^plugin alpha: this database was migrated/)
  })

  test('a database locked by another connection is unreadable, not behind', () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-state-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const dbFile = join(dataDir, 'keith.db')
    // a rollback-journal file (the default): an exclusive lock held here blocks every reader
    const locker = new Database(dbFile, { create: true })
    migrateDatabase(locker)
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const state = dbState(dbFile, plugins)
      expect(state.kind).toBe('unreadable')
      expect(refusalOf(state, { dataDir })).toContain(join(dataDir, 'backups'))
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })

  test('a file without read permission is unreadable', () => {
    if (process.getuid?.() === 0) return // root reads anything
    const { dbFile } = readyDatabase()
    chmodSync(dbFile, 0o000)
    try {
      expect(dbState(dbFile, plugins).kind).toBe('unreadable')
    } finally {
      chmodSync(dbFile, 0o600)
    }
  })

  test('runCore refuses an ahead database before it migrates or snapshots anything', async () => {
    const { dataDir, dbFile } = readyDatabase()
    const sqlite = openDatabase(dbFile)
    sqlite.exec("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', 1)")
    sqlite.close()
    const config = loadConfig({ KEITH_DATA_DIR: dataDir })
    const logger: FileLogger = { ...silentLogger, flush: async () => undefined, secretOnce() {} }
    const attempt = runCore({ config, logger, port: 0 })
    await expect(attempt).rejects.toBeInstanceOf(StartError)
    await expect(attempt).rejects.toThrow(refusedText)
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    expect(existsSync(join(dataDir, 'core.lock'))).toBe(false) // the lock is released
  })
})

describe('start migrates a behind database only after its snapshot (P26.1.3)', () => {
  const plugins = [alphaPlugin()]
  const quiet = (lines: string[]): FileLogger => ({
    ...silentLogger,
    info: (message: string) => {
      lines.push(message)
    },
    flush: async () => undefined,
    secretOnce() {},
  })
  const timing = { inboxPollMs: 20, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 }

  test('a behind database is snapshotted and its block is logged; the lock is released on stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-start-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    const dbFile = join(dataDir, 'keith.db')
    // the core's tables, but not the plugin's: behind for `start` with the plugin
    migrateKeithDatabase(dataDir, dbFile, [])
    const lines: string[] = []
    const running = await runCore({
      config: loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'start' }),
      logger: quiet(lines),
      port: 0,
      core: { plugins, catalogs: { offline: true }, timing },
    })
    try {
      expect(lines.some((l) => l.includes('was behind: applying') && l.includes('backups'))).toBe(
        true,
      )
      expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1)
    } finally {
      await running.stop()
    }
    expect(existsSync(join(dataDir, 'core.lock'))).toBe(false)
  })

  test('a folder that does not exist yet is created private, migrated under the lock, with no snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-start-'))
    roots.push(root)
    const dataDir = join(root, 'fresh')
    const lines: string[] = []
    const running = await runCore({
      config: loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'start' }),
      logger: quiet(lines),
      port: 0,
      core: { plugins, catalogs: { offline: true }, timing },
    })
    await running.stop()
    expect(modeOf(dataDir)).toBe(0o700)
    expect(existsSync(join(dataDir, 'keith.db'))).toBe(true)
    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
    expect(lines).toContain(`database ${join(dataDir, 'keith.db')} created`)
  })
})
