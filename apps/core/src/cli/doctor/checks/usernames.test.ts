import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase } from '@keith/db'
import type { DoctorCtx } from '../types.ts'
import { usernamesCheck } from './usernames.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ctxWith(usernames: string[]): DoctorCtx {
  const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  const sqlite = openDatabase(dbFile)
  migrateDatabase(sqlite)
  for (const [i, username] of usernames.entries())
    sqlite
      .query(
        'INSERT INTO people (id, name, role, created_at, username, updated_at) VALUES (?, ?, ?, 1, ?, 1)',
      )
      .run(`p${i}`, username, 'member', username)
  sqlite.close()
  return {
    config: { dbFile },
    checks: [{ level: 'ok', name: 'database', hint: '' }],
  } as unknown as DoctorCtx
}

describe('doctor: usernames', () => {
  test('a digits-only username from an older version is a note', async () => {
    const out = await usernamesCheck(ctxWith(['ana', '6281234567890']))
    expect(out).toHaveLength(1)
    expect(out[0]?.level).toBe('warn')
    expect(out[0]?.hint).toContain('6281234567890')
    expect(out[0]?.hint).not.toContain('ana')
  })

  test('nothing to say when every username has a letter', async () => {
    expect(await usernamesCheck(ctxWith(['ana', 'a1']))).toEqual([])
  })
})
