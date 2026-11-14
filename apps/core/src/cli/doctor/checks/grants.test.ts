import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase } from '@keith/db'
import type { DoctorCtx } from '../types.ts'
import { grantsCheck } from './grants.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ctxWith(grants: Array<[string, string]>): DoctorCtx {
  const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  const sqlite = openDatabase(dbFile)
  migrateDatabase(sqlite)
  for (const [id, role] of [
    ['own', 'owner'],
    ['ana', 'member'],
  ])
    sqlite
      .query(
        'INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES (?, ?, ?, 1, ?, 1)',
      )
      .run(id as string, id as string, role as string, id as string)
  for (const [person, capability] of grants)
    sqlite
      .query(
        'INSERT INTO person_grants (person_id, capability, granted_by, created_at) VALUES (?, ?, ?, 1)',
      )
      .run(person, capability, 'own')
  sqlite.close()
  return {
    config: { dbFile },
    checks: [{ level: 'ok', name: 'database', hint: '' }],
  } as unknown as DoctorCtx
}

describe('doctor: grants', () => {
  test('a stale audit.read grant to a member is one note naming the person', async () => {
    const out = await grantsCheck(ctxWith([['ana', 'audit.read']]))
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.hint).toContain('audit.read granted to ana: ignored since P23')
  })

  test('grants that still work, and the owner row, say nothing', async () => {
    expect(
      await grantsCheck(
        ctxWith([
          ['ana', 'tokens.manage'],
          ['own', 'audit.read'],
        ]),
      ),
    ).toEqual([])
  })
})
