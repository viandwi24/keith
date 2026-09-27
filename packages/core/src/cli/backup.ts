// `keith backup`: a consistent copy of a (possibly running) KEITH_HOME into a plain folder.
// See docs/architecture/storage.md#backups. `keith restore` is in ./restore.ts.

import { existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { KeithError } from '@keith/sdk'
import { KEITH_VERSION } from '../bootstrap.ts'
import type { KeithPaths } from '../config/types.ts'
import type { Clock } from '../shared/types.ts'
import { backupDatabase, MIGRATIONS_FOLDER } from '../storage/index.ts'

/** Version of the backup folder layout. `keith restore` accepts only this one. */
export const BACKUP_FORMAT = 1
export const MANIFEST_FILE = 'manifest.json'
export const BACKUPS_DIR_NAME = 'backups'
export const BACKUP_DB_FILE = 'keith.db'

/** `manifest.json` in every backup folder. */
export type BackupManifest = {
  format: typeof BACKUP_FORMAT
  keithVersion: string
  /** ISO 8601, UTC. */
  createdAt: string
  /** The newest migration folder name of the build that took the backup. */
  lastMigration: string
}

/** Every item a backup holds besides the manifest, as names under KEITH_HOME. */
export function backupItems(paths: KeithPaths): { name: string; path: string; dir: boolean }[] {
  return [
    { name: 'config.toml', path: paths.configFile, dir: false },
    { name: 'persona.md', path: paths.personaFile, dir: false },
    { name: 'files', path: paths.filesDir, dir: true },
    { name: 'plugins', path: paths.pluginsDir, dir: true },
  ]
}

/** The migration folder names this build knows, oldest first (read at runtime). */
export async function knownMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function timestamp(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

/** Whether `child` is `parent` or inside it (both absolute and normalized). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export type BackupOptions = {
  paths: KeithPaths
  /** Default: `<home>/backups`. */
  out?: string | undefined
  clock: Clock
  print: (line: string) => void
  signal?: AbortSignal | undefined
}

/**
 * Writes `<out>/keith-backup-<YYYYMMDD-HHMMSS>/`. Does not take the home lock: the database
 * snapshot is consistent while Keith runs. Returns the folder.
 */
export async function runBackup(opts: BackupOptions): Promise<string> {
  const { paths, clock } = opts
  const signal = opts.signal ?? new AbortController().signal
  const home = resolve(paths.home)
  if (!existsSync(paths.dbFile)) {
    throw new KeithError(
      'NOT_FOUND',
      `nothing to back up: ${paths.dbFile} does not exist (run 'keith setup')`,
    )
  }
  const out = resolve(opts.out ?? join(home, BACKUPS_DIR_NAME))
  for (const item of backupItems(paths).filter((i) => i.dir)) {
    if (isInside(resolve(item.path), out)) {
      throw new KeithError('INTERNAL', `--out must not be inside ${item.path}: the backup would copy itself`)
    }
  }
  await mkdir(out, { recursive: true })
  const dir = await createFreshDir(out, `keith-backup-${timestamp(clock.now())}`)
  try {
    await backupDatabase(paths.dbFile, join(dir, BACKUP_DB_FILE), signal)
    const skipped: string[] = []
    for (const item of backupItems(paths)) {
      signal.throwIfAborted()
      const stat = await lstat(item.path).catch(() => null)
      if (stat === null) continue
      const target = join(dir, item.name)
      if (stat.isSymbolicLink()) {
        skipped.push(item.path)
      } else if (item.dir && stat.isDirectory()) {
        await cp(item.path, target, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          filter: async (src) => {
            const s = await lstat(src)
            if (s.isSymbolicLink()) skipped.push(src)
            return !s.isSymbolicLink()
          },
        })
      } else if (!item.dir && stat.isFile()) {
        await copyFile(item.path, target)
      }
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      keithVersion: KEITH_VERSION,
      createdAt: new Date(clock.now()).toISOString(),
      lastMigration: (await knownMigrations()).at(-1) ?? '',
    }
    await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    for (const link of skipped) opts.print(`Skipped symbolic link (not followed): ${link}`)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  opts.print(`Backup written to ${dir}`)
  opts.print(
    'Warning: config.toml is copied as it is. Secrets written literally in it (not as env: references) are inside this backup; keep it private.',
  )
  return dir
}

/** Creates `<parent>/<name>` (or `<name>-2`, `-3` … if taken) and returns it. */
async function createFreshDir(parent: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? name : `${name}-${n}`)
    try {
      await mkdir(dir)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
