import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../../../platform/config.ts'
import type { DoctorCtx } from '../types.ts'
import { backupCheck } from './backup.ts'

// The `backup` doctor line (P26.2.4): a `!` note when there is no recent archive or snapshot, `✓` when there is one.
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const ctxFor = (dataDir: string): DoctorCtx => ({ config: { dataDir } as Config }) as DoctorCtx

const DAY = 24 * 60 * 60 * 1000

describe('doctor: backup', () => {
  test('no backup yet is a note, never a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-backup-'))
    dirs.push(dir)
    const [line] = await backupCheck(ctxFor(dir))
    expect(line?.level).toBe('warn')
    expect(line?.hint).toContain('keith-core backup')
  })

  test('a recent archive is ok; an old one is a note; a snapshot counts too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-backup-'))
    dirs.push(dir)
    const backups = join(dir, 'backups')
    mkdirSync(backups)
    const archive = join(backups, 'keith-backup-20261101-101010.tar')
    writeFileSync(archive, 'x')
    const now = Date.now()
    utimesSync(archive, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    expect((await backupCheck(ctxFor(dir)))[0]?.level).toBe('ok')

    utimesSync(archive, new Date(now - 45 * DAY), new Date(now - 45 * DAY))
    const old = (await backupCheck(ctxFor(dir)))[0]
    expect(old?.level).toBe('warn')
    expect(old?.hint).toContain('45 days old')

    // a snapshot of a migration is a backup too, and a newer one wins
    const snapshot = join(backups, 'keith-20261110-090000.db')
    writeFileSync(snapshot, 'x')
    expect((await backupCheck(ctxFor(dir)))[0]?.level).toBe('ok')
  })

  test('files that are not backups are ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-backup-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'backups'))
    writeFileSync(join(dir, 'backups', 'notes.txt'), 'x')
    expect((await backupCheck(ctxFor(dir)))[0]?.level).toBe('warn')
  })

  test('a missing data folder is skipped (the data dir check already failed)', async () => {
    expect(await backupCheck(ctxFor(join(tmpdir(), 'keith-no-such-dir-xyz')))).toEqual([])
  })
})
