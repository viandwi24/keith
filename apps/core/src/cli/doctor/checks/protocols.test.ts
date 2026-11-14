import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase, protocolsRepo } from '@keith/db'
import { APPROVAL_STALE, seedBuiltIns } from '../../../modules/hypothalamus/index.ts'
import type { Check, DoctorCtx } from '../types.ts'
import { protocolsCheck } from './protocols.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A migrated database; `seed` runs the boot seed, and `off` switches one built-in off after it. */
function ctxWith(options: { seed: boolean; off?: string }): DoctorCtx {
  const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-protocols-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  const sqlite = openDatabase(dbFile)
  migrateDatabase(sqlite)
  const protocols = protocolsRepo(sqlite)
  if (options.seed) seedBuiltIns({ protocols })
  if (options.off !== undefined) {
    const row = protocols.findBuiltIn('keith', options.off)
    if (row !== undefined) protocols.setEnabled(row.id, false, 1)
  }
  sqlite.close()
  return {
    config: { dbFile },
    checks: [{ level: 'ok', name: 'database', hint: 'migrated' }],
  } as unknown as DoctorCtx
}

/** The check is synchronous; its result is the list of lines. */
const linesOf = (ctx: DoctorCtx): Check[] => protocolsCheck(ctx) as Check[]

describe('doctor: protocols', () => {
  test('both built-ins on: one ok line with the count of enabled protocols', () => {
    const [line] = linesOf(ctxWith({ seed: true }))
    expect(line).toEqual({
      level: 'ok',
      name: 'protocols',
      hint: '2 enabled protocols, both built-ins on',
    })
  })

  test('no built-in yet: a warning names both as missing', () => {
    const [line] = linesOf(ctxWith({ seed: false }))
    expect(line?.level).toBe('warn')
    expect(line?.hint).toContain('built-in approval-stale is missing')
    expect(line?.hint).toContain('built-in reminder-missed is missing')
  })

  test('a switched-off built-in is a warning, the count still shown', () => {
    const [line] = linesOf(ctxWith({ seed: true, off: APPROVAL_STALE }))
    expect(line?.level).toBe('warn')
    expect(line?.hint).toBe('1 enabled protocol; built-in approval-stale is switched off')
  })

  test('nothing is checked when the database check failed', () => {
    const ctx = ctxWith({ seed: true })
    const failed = {
      ...ctx,
      checks: [{ level: 'fail', name: 'database', hint: 'missing' }],
    } as DoctorCtx
    expect(linesOf(failed)).toEqual([])
  })
})
