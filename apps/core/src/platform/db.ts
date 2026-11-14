import { Database } from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AuditEventInput,
  assertMigrated,
  auditRepo,
  journalStateOf,
  MIGRATIONS_DIR,
  migrateDatabase,
  newerKeithMessage,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import type { KeithPlugin } from '@keith/host'
import {
  assertPluginStorageMigrated,
  migratePluginStorage,
  migrationsTableOf,
  pluginJournalState,
  pluginsWithStorage,
} from '@keith/host/storage'
import { BUILTIN_PLUGINS } from '../modules/plugins/index.ts'
import type { Config } from './config.ts'
import type { Logger } from './logger.ts'

/**
 * The entries of the data folder that Keith owns (FD11-02): the folder itself, these top-level files, and these
 * folders with their files one level down. Nothing else is walked: `workspace/` and `memory/` keep the modes their
 * owners gave them under umask 077, so an executable a worker built stays executable. The restore step and the
 * `doctor` mode check use this same list.
 */
export const OWNED_ENTRIES = {
  files: ['keith.db', 'keith.db-wal', 'keith.db-shm', 'secret.key', 'instance-id', 'core.lock'],
  folders: ['logs', 'backups', 'exports'],
} as const

/** The file-system calls `ownedPaths` and `secureDataDir` make: injectable, so a test can count them. */
export interface OwnedFs {
  lstatSync: (path: string) => {
    isFile(): boolean
    isDirectory(): boolean
    isSymbolicLink(): boolean
    mode: number
  }
  readdirSync: (path: string) => string[]
  chmodSync: (path: string, mode: number) => void
}

const nodeFs: OwnedFs = { lstatSync, readdirSync, chmodSync }

/** One owned path and the mode it must have: 0700 for the folders, 0600 for the files. */
export interface OwnedPath {
  path: string
  mode: 0o600 | 0o700
}

/**
 * The owned paths that exist, as non-symlinks, under `dataDir` (FD11-02). A folder that cannot be listed is
 * reported through `onError` and its files are skipped; this never throws.
 */
export function ownedPaths(
  dataDir: string,
  fs: OwnedFs = nodeFs,
  onError: (message: string) => void = () => {},
): OwnedPath[] {
  const found: OwnedPath[] = []
  const stat = (path: string) => {
    try {
      const entry = fs.lstatSync(path)
      return entry.isSymbolicLink() ? undefined : entry
    } catch {
      return undefined
    }
  }
  if (stat(dataDir)?.isDirectory()) found.push({ path: dataDir, mode: 0o700 })
  for (const name of OWNED_ENTRIES.files) {
    const path = join(dataDir, name)
    if (stat(path)?.isFile()) found.push({ path, mode: 0o600 })
  }
  for (const name of OWNED_ENTRIES.folders) {
    const folder = join(dataDir, name)
    if (!stat(folder)?.isDirectory()) continue
    found.push({ path: folder, mode: 0o700 })
    let entries: string[]
    try {
      entries = fs.readdirSync(folder)
    } catch (error) {
      onError(`${folder} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const entry of entries) {
      const path = join(folder, entry)
      if (stat(path)?.isFile()) found.push({ path, mode: 0o600 })
    }
  }
  return found
}

/**
 * Make the entries Keith owns private (`ownedPaths`): the data folder 0700, its own files 0600, `logs/`, `backups/`
 * and `exports/` 0700 with their files 0600. An entry that cannot be changed is a warning, returned to the caller;
 * it never throws, so `start` is not blocked by a file it does not own.
 */
export function secureDataDir(dataDir: string, fs: OwnedFs = nodeFs): string[] {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const warnings: string[] = []
  const owned = ownedPaths(dataDir, fs, (message) => warnings.push(message))
  for (const { path, mode } of owned) {
    try {
      fs.chmodSync(path, mode)
    } catch (error) {
      warnings.push(
        `${path} could not be set to ${mode.toString(8)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return warnings
}

/** Open the Keith database; refuses a database that `bun run db:migrate` has not brought up to date (the core and every plugin that keeps tables). */
export async function openKeithDatabase(
  dataDir: string,
  dbFile: string,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): Promise<Sqlite> {
  secureDataDir(dataDir)
  const sqlite = openDatabase(dbFile)
  try {
    await assertMigrated(sqlite)
    assertPluginStorageMigrated(sqlite, plugins)
    secureDataDir(dataDir) // -wal and -shm exist now
  } catch (error) {
    sqlite.close()
    throw error
  }
  return sqlite
}

/**
 * Open an existing database file read only (`doctor`, P23.4.6): no folder change, no create, no WAL switch, no
 * write. Missing files throw (SQLite cannot create them read only).
 */
export function openReadOnlyDatabase(dbFile: string): Sqlite {
  return new Database(dbFile, { readonly: true, strict: true })
}

/** The read-only counterpart of `openKeithDatabase`: refuses a missing or behind database and touches nothing on disk. */
export async function openKeithDatabaseReadOnly(
  dbFile: string,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): Promise<Sqlite> {
  const sqlite = openReadOnlyDatabase(dbFile)
  try {
    await assertMigrated(sqlite)
    assertPluginStorageMigrated(sqlite, plugins)
  } catch (error) {
    sqlite.close()
    throw error
  }
  return sqlite
}

/** Create the database if needed and apply pending migrations: the core's, then each plugin's in its own journal (idempotent). Core must be stopped. */
export function migrateKeithDatabase(
  dataDir: string,
  dbFile: string,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): void {
  secureDataDir(dataDir)
  const sqlite = openDatabase(dbFile)
  try {
    migrateDatabase(sqlite)
    migratePluginStorage(sqlite, plugins)
  } finally {
    sqlite.close()
  }
  secureDataDir(dataDir)
}

/**
 * What the file is, before anything is opened for writing: `missing`, `ready`, `behind` (a journal of the core or a
 * plugin has fewer rows than it ships), `ahead` and `diverged` (written by another build: refused), or `unreadable`
 * (corrupt, no permission, locked by another connection). `journal` names which journal it is about.
 */
export type DbState =
  | { kind: 'missing' }
  | { kind: 'ready' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'behind' | 'ahead' | 'diverged'; journal: string; applied: number; shipped: number }

/** Read only: opens the file read only, compares the core's and each plugin's journal, never writes. */
export function dbState(
  dbFile: string,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): DbState {
  if (!existsSync(dbFile)) return { kind: 'missing' }
  try {
    const sqlite = openReadOnlyDatabase(dbFile)
    try {
      const core = journalStateOf(sqlite, '__drizzle_migrations', MIGRATIONS_DIR)
      if (core.kind !== 'ready') return { ...core, journal: 'core' }
      for (const plugin of pluginsWithStorage(plugins)) {
        const state = pluginJournalState(sqlite, plugin)
        if (state.kind !== 'ready') return { ...state, journal: `plugin ${plugin.id}` }
      }
      return { kind: 'ready' }
    } finally {
      sqlite.close()
    }
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The text that refuses to start or migrate for `state` (ahead, diverged, unreadable), or undefined when the
 * database may be opened or migrated. Behind and missing are not refusals: they are migrated.
 */
export function refusalOf(state: DbState, config: Pick<Config, 'dataDir'>): string | undefined {
  switch (state.kind) {
    case 'ahead':
    case 'diverged': {
      const message = newerKeithMessage(state.applied, state.shipped)
      return state.journal === 'core' ? message : `${state.journal}: ${message}`
    }
    case 'unreadable':
      return `the database cannot be read (${state.reason}): check its file and permissions; a snapshot of it, if one was made, is in ${join(config.dataDir, 'backups')}`
    default:
      return undefined
  }
}

/** Whether the database file exists and is up to date (`dbState` is `ready`). Read only. */
export async function isMigrated(
  dbFile: string,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): Promise<boolean> {
  return dbState(dbFile, plugins).kind === 'ready'
}

/** Automatic snapshots kept in `<dataDir>/backups/`; the older ones are deleted when a new one is made. */
export const KEEP_SNAPSHOTS = 5
const SNAPSHOT_NAME = /^keith-\d{8}-\d{6}(?:-\d+)?\.db$/

/** A snapshot could not be made or checked. Nothing was migrated. */
export class BackupError extends Error {
  constructor(reason: string) {
    super(`could not back up the database: ${reason}; nothing was changed`)
    this.name = 'BackupError'
  }
}

export type MigrateOutcome =
  | { kind: 'current' }
  | { kind: 'created' }
  | { kind: 'migrated'; backup: string; from: number; to: number; tags: string[] }

interface Pending {
  from: number
  to: number
  /** `<tag>` for a core migration, `<plugin>/<tag>` for a plugin's, in the order they apply. */
  tags: string[]
  pluginMigrations: number
}

function journalTags(folder: string): string[] {
  const journal = join(folder, 'meta/_journal.json')
  if (!existsSync(journal)) return []
  const { entries } = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] }
  return entries.map((entry) => entry.tag)
}

/** Rows applied in a migrations table (0 when the table does not exist yet). */
function appliedIn(sqlite: Sqlite, table: string): number {
  const has = sqlite
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table)
  if (has?.n !== 1) return 0
  return sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n ?? 0
}

/** What `migrateKeithDatabase` would apply to this database now: the core's journal rows, then each plugin's. */
function pendingOf(sqlite: Sqlite, plugins: readonly KeithPlugin[]): Pending {
  const coreTags = journalTags(MIGRATIONS_DIR)
  const from = appliedIn(sqlite, '__drizzle_migrations')
  const tags = coreTags.slice(from)
  let pluginMigrations = 0
  for (const plugin of pluginsWithStorage(plugins)) {
    const pluginTags = journalTags((plugin.manifest.storage as { migrations: string }).migrations)
    const pending = pluginTags.slice(appliedIn(sqlite, migrationsTableOf(plugin.id)))
    pluginMigrations += pending.length
    tags.push(...pending.map((tag) => `${plugin.id}/${tag}`))
  }
  return { from, to: coreTags.length, tags, pluginMigrations }
}

/** Local time as `YYYYMMDD-HHMMSS`: the snapshot name, which sorts by time. */
export function stampOf(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

/**
 * Copy the database to `file` through `VACUUM INTO` (mode 0600) and run `integrity_check` on the copy. `file` must
 * not exist. A failure removes the copy and throws `BackupError`. Used by the automatic snapshots and by `backup`.
 */
export function snapshotDatabase(dbFile: string, file: string): void {
  try {
    const source = openReadOnlyDatabase(dbFile)
    try {
      source.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
    chmodSync(file, 0o600)
    const copy = openReadOnlyDatabase(file)
    try {
      const check = copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
      if (check?.integrity_check !== 'ok')
        throw new Error(
          `integrity_check of the copy reports ${check?.integrity_check ?? 'nothing'}`,
        )
    } finally {
      copy.close()
    }
  } catch (error) {
    rmSync(file, { force: true })
    throw new BackupError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Snapshot the database to `<dataDir>/backups/keith-<stamp>.db` (folder 0700, file 0600) with `snapshotDatabase`.
 * A failure throws `BackupError`; nothing is left behind.
 */
export function backupDatabase(dataDir: string, dbFile: string, at: Date = new Date()): string {
  const dir = join(dataDir, 'backups')
  // created private; an existing folder keeps the mode its owner gave it
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
  const base = `keith-${stampOf(at)}`
  let file = join(dir, `${base}.db`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.db`)
  snapshotDatabase(dbFile, file)
  return file
}

/** Migrations applied per journal: the core's, and each plugin's by its id (read only database, see `dbState`). */
export interface MigrationCounts {
  core: number
  plugins: Record<string, number>
}

/** The rows each journal of an open database has applied (0 for a journal whose table does not exist). */
export function appliedCounts(
  sqlite: Sqlite,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
): MigrationCounts {
  const plugins_: Record<string, number> = {}
  for (const plugin of pluginsWithStorage(plugins))
    plugins_[plugin.id] = appliedIn(sqlite, migrationsTableOf(plugin.id))
  return { core: appliedIn(sqlite, '__drizzle_migrations'), plugins: plugins_ }
}

/** The migrations each journal ships in this build. */
export function shippedCounts(plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS): MigrationCounts {
  const plugins_: Record<string, number> = {}
  for (const plugin of pluginsWithStorage(plugins))
    plugins_[plugin.id] = journalTags(
      (plugin.manifest.storage as { migrations: string }).migrations,
    ).length
  return { core: journalTags(MIGRATIONS_DIR).length, plugins: plugins_ }
}

/**
 * Keep the newest `keep` automatic snapshots in `dir` and delete the older ones. Only files named like
 * `keith-<stamp>.db` match: the owner's own archives in the same folder are never touched.
 */
export function pruneSnapshots(dir: string, keep: number = KEEP_SNAPSHOTS): string[] {
  if (!existsSync(dir)) return []
  const snapshots = readdirSync(dir)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .map((name) => ({ path: join(dir, name), name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const old = snapshots.slice(0, Math.max(0, snapshots.length - keep))
  for (const snapshot of old) rmSync(snapshot.path, { force: true })
  return old.map((snapshot) => snapshot.path)
}

/**
 * The one way an existing database is migrated (ADR-0027 §3). A missing file is created, with no backup. A
 * behind database is first snapshotted (`backupDatabase`); if that fails the migration is refused and nothing
 * changes. Then the core's and each plugin's migrations run, the snapshots are pruned to the newest five, the
 * run is audited as `db.migrated` and one line is logged. The caller holds `core.lock`.
 */
export function migrateWithBackup(
  config: Pick<Config, 'dataDir' | 'dbFile'>,
  plugins: readonly KeithPlugin[] = BUILTIN_PLUGINS,
  log: Logger,
  via: AuditEventInput['via'],
): MigrateOutcome {
  if (!existsSync(config.dbFile)) {
    migrateKeithDatabase(config.dataDir, config.dbFile, plugins)
    return { kind: 'created' }
  }
  // refused before any snapshot or migration: a database another build wrote, or one that cannot be read
  const refusal = refusalOf(dbState(config.dbFile, plugins), config)
  if (refusal !== undefined) throw new Error(refusal)
  const probe = openReadOnlyDatabase(config.dbFile)
  let pending: Pending
  try {
    pending = pendingOf(probe, plugins)
  } finally {
    probe.close()
  }
  if (pending.tags.length === 0) return { kind: 'current' }
  const backup = backupDatabase(config.dataDir, config.dbFile)
  pruneSnapshots(join(config.dataDir, 'backups'))
  migrateKeithDatabase(config.dataDir, config.dbFile, plugins)
  const sqlite = openDatabase(config.dbFile)
  try {
    auditRepo(sqlite).add({
      kind: 'db.migrated',
      actor: 'system',
      via,
      detail: {
        from: pending.from,
        to: pending.to,
        backup,
        pluginMigrations: pending.pluginMigrations,
      },
    })
  } finally {
    sqlite.close()
  }
  log.info(
    `database ${config.dbFile} was behind: applying ${pending.tags.length} migration(s): ${pending.tags.join(', ')}; backup ${backup}`,
  )
  return { kind: 'migrated', backup, from: pending.from, to: pending.to, tags: pending.tags }
}
