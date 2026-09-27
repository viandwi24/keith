// `keith restore <dir>`: brings a `keith backup` folder back into a stopped KEITH_HOME.
// See docs/architecture/storage.md#backups.

import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { KeithError } from '@keith/sdk'
import type { KeithPaths } from '../config/types.ts'
import { LOCK_FILE_NAME, withHomeLock } from '../shared/index.ts'
import type { Clock } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import {
  BACKUP_DB_FILE,
  BACKUP_FORMAT,
  BACKUPS_DIR_NAME,
  type BackupManifest,
  backupItems,
  isInside,
  knownMigrations,
  MANIFEST_FILE,
  timestamp,
} from './backup.ts'

export type RestoreOptions = {
  paths: KeithPaths
  /** The backup folder. */
  from: string
  force: boolean
  clock: Clock
  print: (line: string) => void
}

function invalid(message: string): KeithError {
  return new KeithError('INTERNAL', `invalid backup: ${message}`)
}

/** Reads and checks `manifest.json`: format 1 and a `lastMigration` this build knows. */
export async function readManifest(dir: string): Promise<BackupManifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'))
  } catch (cause) {
    throw new KeithError('INTERNAL', `invalid backup: cannot read ${join(dir, MANIFEST_FILE)}`, { cause })
  }
  if (typeof raw !== 'object' || raw === null) throw invalid(`${MANIFEST_FILE} is not an object`)
  const m = raw as Record<string, unknown>
  if (m.format !== BACKUP_FORMAT) {
    throw invalid(`unsupported format ${JSON.stringify(m.format)} (this Keith reads format ${BACKUP_FORMAT})`)
  }
  for (const key of ['keithVersion', 'createdAt', 'lastMigration'] as const) {
    if (typeof m[key] !== 'string' || m[key] === '') throw invalid(`${MANIFEST_FILE} has no ${key}`)
  }
  const manifest = m as BackupManifest
  const known = await knownMigrations()
  if (!known.includes(manifest.lastMigration)) {
    const newer = manifest.lastMigration > (known.at(-1) ?? '')
    throw new KeithError(
      'INTERNAL',
      newer
        ? `this backup was made by a newer Keith (${manifest.keithVersion}, migration ${manifest.lastMigration}); upgrade Keith before restoring it`
        : `this backup's migration ${manifest.lastMigration} is unknown to this Keith`,
    )
  }
  return manifest
}

/**
 * Refuses symbolic links and anything that is not a plain file or folder, anywhere in the backup,
 * and paths that resolve outside it. Nothing is followed.
 */
async function checkTree(root: string, dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const rel = relative(root, path)
    if (rel === '' || !isInside(root, resolve(path))) throw invalid(`${path} escapes the backup folder`)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw invalid(`${rel} is a symbolic link (not followed)`)
    if (stat.isDirectory()) await checkTree(root, path)
    else if (!stat.isFile()) throw invalid(`${rel} is not a regular file`)
  }
}

/** Restores the backup at `opts.from` into `opts.paths.home` while holding the home lock. */
export async function runRestore(opts: RestoreOptions): Promise<void> {
  const { paths, clock, print } = opts
  const home = resolve(paths.home)
  const fromStat = await lstat(opts.from).catch(() => null)
  if (fromStat === null || !fromStat.isDirectory()) {
    throw invalid(`${opts.from} is not a folder`)
  }
  const from = await realpath(opts.from)
  const manifest = await readManifest(from)
  await checkTree(from, from)
  const dbStat = await lstat(join(from, BACKUP_DB_FILE)).catch(() => null)
  if (dbStat === null || !dbStat.isFile()) throw invalid(`${BACKUP_DB_FILE} is missing`)
  const items = backupItems(paths)
  const present: typeof items = []
  for (const item of items) {
    const s = await lstat(join(from, item.name)).catch(() => null)
    if (s === null) continue
    if (item.dir !== s.isDirectory())
      throw invalid(`${item.name} should be a ${item.dir ? 'folder' : 'file'}`)
    present.push(item)
  }

  await mkdir(home, { recursive: true })
  const realHome = await realpath(home)
  if (isInside(realHome, from) && relative(realHome, from).split(sep)[0] !== BACKUPS_DIR_NAME) {
    throw new KeithError(
      'INTERNAL',
      `the backup folder must not be inside ${home} (except ${BACKUPS_DIR_NAME}/)`,
    )
  }

  await withHomeLock(home, async () => {
    const existing = (await readdir(home)).filter((n) => n !== LOCK_FILE_NAME && n !== BACKUPS_DIR_NAME)
    if (existing.length > 0) {
      if (!opts.force) {
        const what = existing.includes(BACKUP_DB_FILE)
          ? `${paths.dbFile} already exists`
          : `${home} is not empty`
        throw new KeithError(
          'INTERNAL',
          `${what}; use 'keith restore <dir> --force' to move the current state aside`,
        )
      }
      const aside = await freshSibling(home, `.before-restore-${timestamp(clock.now())}`)
      await mkdir(aside)
      for (const name of existing) await rename(join(home, name), join(aside, name))
      print(`Moved the current state of ${home} to ${aside}`)
    }

    await copyFile(join(from, BACKUP_DB_FILE), paths.dbFile)
    for (const item of present) {
      const src = join(from, item.name)
      if (item.dir) {
        await cp(src, item.path, { recursive: true, dereference: false, errorOnExist: true, force: false })
      } else {
        await copyFile(src, item.path)
      }
    }
    // Applies the migrations this build has and the backup doesn't (an older backup is upgraded).
    openDb(paths.dbFile).close()
  })

  print(`Restored the backup from ${manifest.createdAt} (Keith ${manifest.keithVersion}) into ${home}:`)
  for (const name of [BACKUP_DB_FILE, ...present.map((i) => i.name)]) print(`  ${name}`)
  const latest = (await knownMigrations()).at(-1)
  if (latest !== manifest.lastMigration)
    print(`Database upgraded from ${manifest.lastMigration} to ${latest}`)
}

/** `<path><suffix>`, or with `-2`, `-3` … appended when taken. */
async function freshSibling(path: string, suffix: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = `${path}${suffix}${n === 1 ? '' : `-${n}`}`
    if ((await lstat(candidate).catch(() => null)) === null) return candidate
  }
}
