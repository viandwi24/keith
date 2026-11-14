import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorCheck } from '../types.ts'

/** Older than this, the newest backup is a warning (ADR-0027 §25: the owner runs `backup` from cron). */
export const BACKUP_MAX_AGE_DAYS = 30

/** An archive from `backup` or a snapshot of a migration, both kept in `<data>/backups/` (`backup.md`). */
const BACKUP_NAME = /^keith-(?:backup-\d{8}-\d{6}(?:-\d+)?\.tar|\d{8}-\d{6}(?:-\d+)?\.db)$/

/** The newest backup file in `dir` by modification time, or undefined when there is none. */
export function newestBackupIn(dir: string): { name: string; at: number } | undefined {
  if (!existsSync(dir)) return undefined
  let newest: { name: string; at: number } | undefined
  for (const name of readdirSync(dir)) {
    if (!BACKUP_NAME.test(name)) continue
    const at = statSync(join(dir, name)).mtimeMs
    if (newest === undefined || at > newest.at) newest = { name, at }
  }
  return newest
}

/**
 * Whether a backup exists and is recent (P26.2.4). A `!` note, never a `✗`: a fresh install has none until the owner
 * runs `keith-core backup`. Archives written with `backup --out <dir>` are not in `<data>/backups/` and are not seen.
 */
export const backupCheck: DoctorCheck = ({ config }) => {
  if (!existsSync(config.dataDir)) return []
  const newest = newestBackupIn(join(config.dataDir, 'backups'))
  if (newest === undefined)
    return [
      {
        level: 'warn',
        name: 'backup',
        hint: 'none in backups/: run keith-core backup, and copy the archive off this machine',
      },
    ]
  const days = Math.floor((Date.now() - newest.at) / (24 * 60 * 60 * 1000))
  if (days > BACKUP_MAX_AGE_DAYS)
    return [
      {
        level: 'warn',
        name: 'backup',
        hint: `newest ${newest.name} is ${days} days old: run keith-core backup`,
      },
    ]
  return [{ level: 'ok', name: 'backup', hint: `newest ${newest.name} (${days} days ago)` }]
}
