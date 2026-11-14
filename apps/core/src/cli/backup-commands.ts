// `keith-core backup` and `keith-core restore` (ADR-0027 §25, docs/specs/backup.md). The archive is a tar (archive.ts);
// backup works while the core runs (a `VACUUM INTO` copy is consistent), restore needs the core stopped and core.lock.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CliError, type Command, defineCommand, UsageError } from '@keith/cli'
import { auditRepo, openDatabase } from '@keith/db'
import { acquireLock, LOCK_FILE } from '../modules/admin/index.ts'
import { extractArchive, writeArchive } from '../platform/archive.ts'
import type { Config } from '../platform/config.ts'
import {
  appliedCounts,
  type MigrationCounts,
  openReadOnlyDatabase,
  secureDataDir,
  shippedCounts,
  snapshotDatabase,
  stampOf,
} from '../platform/db.ts'
import { buildInfo } from '../platform/version.ts'
import { type CliDeps, configOf, requireOffline } from './context.ts'

/** The entries of the data folder an archive carries; `keith.db` is always among them. */
const CARRIED = ['secret.key', 'instance-id', 'workspace', 'memory'] as const

/** What a restore replaces: the carried entries and the database's sidecar files (a stale WAL must not meet a new file). */
const REPLACED = ['keith.db', 'keith.db-wal', 'keith.db-shm', ...CARRIED] as const

export interface BackupManifest {
  version: string
  createdAt: string
  migrations: MigrationCounts
  includes: string[]
}

export interface BackupResult {
  path: string
  bytes: number
  includes: string[]
  secretInArchive: boolean
  secretFromEnv: boolean
}

/** A new archive name in `dir`: `keith-backup-<stamp>.tar`, with `-2`, `-3`… when that name is taken. */
function archivePathIn(dir: string, at: Date): string {
  const base = `keith-backup-${stampOf(at)}`
  let path = join(dir, `${base}.tar`)
  for (let n = 2; existsSync(path); n++) path = join(dir, `${base}-${n}.tar`)
  return path
}

/** Write the archive of the database, the carried entries and a manifest. Works while the core runs: no lock. */
export async function createBackup(
  config: Config,
  options: { outDir?: string | undefined; version: string; now?: Date },
): Promise<BackupResult> {
  if (!existsSync(config.dbFile)) throw new CliError('no database to back up: run keith-core setup')
  const at = options.now ?? new Date()
  const outDir = options.outDir ?? join(config.dataDir, 'backups')
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const path = archivePathIn(outDir, at)
  const scratch = join(config.dataDir, 'backups')
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(scratch, '.stage-'))
  try {
    snapshotDatabase(config.dbFile, join(stage, 'keith.db'))
    const copy = openReadOnlyDatabase(join(stage, 'keith.db'))
    let migrations: MigrationCounts
    try {
      migrations = appliedCounts(copy)
    } finally {
      copy.close()
    }
    const carried = CARRIED.filter((name) => existsSync(join(config.dataDir, name)))
    const includes = ['keith.db', ...carried]
    const manifest: BackupManifest = {
      version: options.version,
      createdAt: at.toISOString(),
      migrations,
      includes,
    }
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    await writeArchive(path, [
      { dir: stage, names: ['manifest.json', 'keith.db'] },
      { dir: config.dataDir, names: carried },
    ])
    const bytes = statSync(path).size
    recordAudit(config.dbFile, 'backup.created', { bytes, includes })
    return {
      path,
      bytes,
      includes,
      secretInArchive: carried.includes('secret.key'),
      secretFromEnv: config.secretKey !== undefined,
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** An audit row for a backup or restore. The archive is complete first, so the row is never in it; a failure only warns. */
function recordAudit(dbFile: string, kind: string, detail: Record<string, unknown>): void {
  try {
    const sqlite = openDatabase(dbFile)
    try {
      auditRepo(sqlite).add({ kind, actor: 'system', via: 'local', detail })
    } finally {
      sqlite.close()
    }
  } catch {
    // the database may be older or newer than this build; the archive is what matters
  }
}

function readManifest(stage: string): BackupManifest {
  const file = join(stage, 'manifest.json')
  if (!existsSync(file))
    throw new CliError('the archive has no manifest.json: it is not a keith backup')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new CliError('the archive manifest.json cannot be read')
  }
  const m = parsed as Partial<BackupManifest>
  const counts = m.migrations as Partial<MigrationCounts> | undefined
  if (
    typeof m.version !== 'string' ||
    typeof m.createdAt !== 'string' ||
    !Array.isArray(m.includes) ||
    typeof counts?.core !== 'number' ||
    typeof counts.plugins !== 'object' ||
    counts.plugins === null
  )
    throw new CliError('the archive manifest.json is malformed')
  return m as BackupManifest
}

export interface RestoreResult {
  includes: string[]
  movedTo: string | undefined
  warnings: string[]
  manifest: BackupManifest
}

/**
 * Put an archive back into `config.dataDir`. The caller holds `core.lock`. Nothing is deleted: entries that were there
 * move to `restore-previous-<stamp>/` (only with `force`). Refuses a newer archive and a damaged database before any move.
 */
export async function restoreBackup(
  config: Config,
  archive: string,
  options: { force: boolean; version: string; now?: Date },
): Promise<RestoreResult> {
  if (!existsSync(archive)) throw new CliError(`${archive} does not exist`)
  const at = options.now ?? new Date()
  const stamp = stampOf(at)
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(config.dataDir, '.restore-'))
  try {
    await extractArchive(archive, stage)
    const manifest = readManifest(stage)
    const staged = readdirSync(stage).filter((name) => name !== 'manifest.json')
    const unexpected = staged.filter((name) => !(REPLACED as readonly string[]).includes(name))
    if (unexpected.length > 0)
      throw new CliError(`the archive holds ${unexpected.join(', ')}: not part of a keith backup`)
    if (!staged.includes('keith.db')) throw new CliError('the archive has no keith.db')

    // a newer build wrote this archive: its schema is not one this build can read
    const shipped = shippedCounts()
    if (manifest.migrations.core > shipped.core)
      throw new CliError(
        `this backup is from a newer Keith (${manifest.migrations.core} core migrations, this build ships ${shipped.core}): update Keith first`,
      )
    for (const [id, applied] of Object.entries(manifest.migrations.plugins)) {
      if (applied > (shipped.plugins[id] ?? 0))
        throw new CliError(
          `this backup is from a newer Keith (plugin ${id}: ${applied} migrations, this build ships ${shipped.plugins[id] ?? 0}): update Keith first`,
        )
    }

    let verdict: string | undefined
    try {
      const copy = openReadOnlyDatabase(join(stage, 'keith.db'))
      try {
        verdict = copy
          .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
          .get()?.integrity_check
      } finally {
        copy.close()
      }
    } catch (error) {
      throw new CliError(
        `the database in the archive cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (verdict !== 'ok')
      throw new CliError(
        `the database in the archive fails integrity_check: ${verdict ?? 'no answer'}`,
      )

    const live = REPLACED.filter((name) => existsSync(join(config.dataDir, name)))
    if (live.length > 0 && !options.force)
      throw new CliError(
        `the data folder already holds ${live.join(', ')}: run again with --force to move them to restore-previous-${stamp}/ first`,
      )
    let movedTo: string | undefined
    if (live.length > 0) {
      movedTo = join(config.dataDir, `restore-previous-${stamp}`)
      mkdirSync(movedTo, { mode: 0o700 })
      for (const name of live) renameSync(join(config.dataDir, name), join(movedTo, name))
    }
    for (const name of staged) renameSync(join(stage, name), join(config.dataDir, name))
    const warnings = secureDataDir(config.dataDir)
    recordAudit(config.dbFile, 'backup.restored', {
      includes: manifest.includes,
      createdAt: manifest.createdAt,
      migrations: manifest.migrations,
    })
    return { includes: staged, movedTo, warnings, manifest }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export function backupCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'backup',
    summary: 'Archive the database, secret key, workspace and memory (works while core runs)',
    usage: '[--out <dir>]',
    flags: {
      out: {
        type: 'string',
        placeholder: 'dir',
        description: 'Write the archive into this folder (default <data>/backups)',
      },
    },
    run: async (ctx) => {
      const config = configOf(deps)
      const { version } = await buildInfo(config.buildSha)
      const done = await createBackup(config, { outDir: ctx.string('out'), version })
      const out = ctx.io.stdout
      out.write(`backup ${done.path} (${done.bytes} bytes)\n`)
      out.write(`includes: ${done.includes.join(', ')}\n`)
      if (done.secretInArchive)
        out.write(
          'warning: the archive holds secret.key: keep it private, it is as sensitive as the data folder\n',
        )
      if (done.secretFromEnv)
        out.write(
          'warning: the secret key comes from KEITH_SECRET_KEY and is NOT in the archive: keep that key with the backup, or the stored provider keys cannot be read after a restore\n',
        )
      return 0
    },
  })
}

export function restoreCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'restore',
    summary: 'Put a backup back into the data folder (core must be stopped)',
    usage: '<archive> [--force]',
    positionals: true,
    flags: {
      force: {
        type: 'boolean',
        description: 'Move the files that are there to restore-previous-<stamp>/ first',
      },
    },
    run: async (ctx) => {
      const archive = ctx.positionals[0]
      if (archive === undefined) throw new UsageError('missing archive')
      const config = configOf(deps)
      await requireOffline(config, 'restore')
      const { version } = await buildInfo(config.buildSha)
      // a restore into a new folder: the folder must exist before core.lock is taken in it
      mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
      const lock = acquireLock(join(config.dataDir, LOCK_FILE))
      try {
        const done = await restoreBackup(config, archive, { force: ctx.bool('force'), version })
        for (const warning of done.warnings) ctx.io.stderr?.write(`warning: ${warning}\n`)
        ctx.io.stdout.write(
          `restored ${archive} into ${config.dataDir}: ${done.includes.join(', ')}\n`,
        )
        if (done.movedTo !== undefined)
          ctx.io.stdout.write(`the files that were there are in ${done.movedTo}\n`)
        ctx.io.stdout.write('run keith-core doctor, then keith-core start\n')
      } finally {
        lock.release()
      }
      return 0
    },
  })
}
