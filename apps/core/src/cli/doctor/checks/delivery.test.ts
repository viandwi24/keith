import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveriesRepo, migrateDatabase, openDatabase } from '@keith/db'
import type { DoctorCtx } from '../types.ts'
import { deliveryCheck } from './delivery.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

interface Row {
  id: string
  /** how long ago the row was created (ms) */
  ago: number
  status: 'pending' | 'failed'
  reason?: string
}

function ctxWith(rows: Row[]): DoctorCtx {
  const dir = mkdtempSync(join(tmpdir(), 'keith-doctor-delivery-'))
  dirs.push(dir)
  const dbFile = join(dir, 'keith.db')
  const sqlite = openDatabase(dbFile)
  migrateDatabase(sqlite)
  const now = Date.now()
  for (const r of rows) {
    const repo = deliveriesRepo(sqlite, { now: () => now - r.ago })
    repo.create({
      id: r.id,
      source: 'plugin:reminders',
      recipientId: 'ana',
      name: 'reminder',
      needs: '{}',
      text: 'secret reminder text',
    })
    if (r.status === 'failed')
      repo.settle(r.id, { status: 'failed', reason: r.reason ?? 'budget', attempts: 1 })
  }
  sqlite.close()
  return {
    config: { dbFile },
    checks: [{ level: 'ok', name: 'database', hint: '' }],
  } as unknown as DoctorCtx
}

describe('doctor: delivery', () => {
  test('nothing stale and nothing failed says nothing', async () => {
    expect(await deliveryCheck(ctxWith([{ id: 'fresh', ago: 1000, status: 'pending' }]))).toEqual(
      [],
    )
  })

  test('a pending row older than an hour is a warning with the count', async () => {
    const out = await deliveryCheck(
      ctxWith([
        { id: 'old-1', ago: 2 * HOUR, status: 'pending' },
        { id: 'old-2', ago: 3 * HOUR, status: 'pending' },
        { id: 'fresh', ago: 1000, status: 'pending' },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ level: 'warn', name: 'delivery' })
    expect(out[0]?.hint).toContain('2 pending delivery rows older than an hour')
  })

  test('failed rows of the last 7 days are named as a hint, never with their text', async () => {
    const out = await deliveryCheck(
      ctxWith([
        { id: 'f-recent', ago: 2 * DAY, status: 'failed', reason: 'budget' },
        { id: 'f-old', ago: 10 * DAY, status: 'failed', reason: 'unavailable' },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.hint).toContain('1 failed in the last 7 days: plugin:reminders to ana (budget)')
    expect(out[0]?.hint).not.toContain('secret reminder text')
    expect(out[0]?.hint).not.toContain('unavailable')
  })

  test('a database that is not ok is not read', async () => {
    const ctx = ctxWith([{ id: 'old', ago: 2 * HOUR, status: 'pending' }])
    ctx.checks = [{ level: 'fail', name: 'database', hint: 'missing' }]
    expect(await deliveryCheck(ctx)).toEqual([])
  })
})
