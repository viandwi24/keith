/**
 * P16 open verification 4: `eharness/scheduler` over the SQLite store across a restart. A schedule is a
 * durable row; what happens to a slot that came due while the core was down is decided by `catchUp`,
 * and `{ fired: false }` is honoured in `TickReport`. Fresh temp databases only (the tables come from
 * `schemaSql`; Keith's own migrations do not create `eh_schedules`, see docs/specs/db.md).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScheduler, type FireRecord } from 'eharness/scheduler'
import { schemaSql, sqliteScheduleStore } from 'eharness/sqlite'
import { openDatabase } from '../connection.ts'
import { driverOf } from './driver.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-sched-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T0 = 1_790_000_000_000
let seq = 0

/** One "process": its own connection to the file and its own scheduler, on a clock we move. */
function process(
  file: string,
  clock: { t: number },
  fired: string[],
  over: Record<string, unknown> = {},
) {
  const sqlite = openDatabase(file)
  const store = sqliteScheduleStore(driverOf(sqlite))
  const scheduler = createScheduler({
    store,
    now: () => clock.t,
    tickMs: 15_000,
    leaseMs: 30_000,
    graceMs: 30_000,
    owner: `proc-${++seq}`,
    fire: ({ fireId }: FireRecord) => void fired.push(fireId),
    ...over,
  } as never)
  return { sqlite, store, scheduler }
}
function freshFile(name: string): string {
  const file = join(dir, `${name}.db`)
  const sqlite = openDatabase(file)
  for (const m of schemaSql({ prefix: 'eh_' })) sqlite.exec(m.sql)
  sqlite.close()
  return file
}

describe('scheduler across a restart', () => {
  test('a schedule survives the process; a slot missed while down is dropped by default (catchUp skip)', async () => {
    const file = freshFile('skip')
    const clock = { t: T0 }
    const fired: string[] = []
    const a = process(file, clock, fired)
    await a.scheduler.create({
      id: 'r1',
      sessionId: 'front:ben',
      spec: { kind: 'once', at: T0 + 10_000 },
      payload: { text: 'x' },
    })
    expect((await a.scheduler.tick()).fired).toEqual([])
    a.sqlite.close() // core goes down
    clock.t = T0 + 600_000 // ... for ten minutes; the slot was at +10 s
    const b = process(file, clock, fired)
    const report = await b.scheduler.tick()
    expect(report.fired).toEqual([])
    expect(report.skipped).toEqual([
      { scheduleId: 'r1', scheduledAt: T0 + 10_000, reason: 'catch-up' },
    ])
    const row = await b.store.get('r1')
    expect(row?.nextFireAt).toBeNull() // exhausted: the reminder is lost without a trace unless the app audits the skip
    expect(fired).toEqual([])
    b.sqlite.close()
  })

  test('catchUp once fires the missed slot late, exactly once, with its original slot time', async () => {
    const file = freshFile('once')
    const clock = { t: T0 }
    const fired: string[] = []
    const a = process(file, clock, fired)
    await a.scheduler.create({
      id: 'r1',
      sessionId: 'front:ben',
      spec: { kind: 'once', at: T0 + 10_000 },
      catchUp: 'once',
      payload: {},
    })
    a.sqlite.close()
    clock.t = T0 + 600_000
    const b = process(file, clock, fired)
    const first = await b.scheduler.tick()
    expect(first.fired.map((f) => f.scheduledAt)).toEqual([T0 + 10_000])
    expect(fired).toEqual([`sched:r1:${T0 + 10_000}`])
    expect((await b.scheduler.tick()).fired).toEqual([]) // never twice
    b.sqlite.close()
  })

  test('an interval that was down for a minute: catchUp { max: 2 } fires the latest two missed slots (and the fresh one), the rest are reported', async () => {
    const file = freshFile('max')
    const clock = { t: T0 }
    const fired: string[] = []
    const a = process(file, clock, fired)
    await a.scheduler.create({
      id: 'r1',
      sessionId: 'front:ben',
      spec: { kind: 'interval', everyMs: 10_000 },
      catchUp: { max: 2 },
      overlap: 'queue',
      payload: {},
    })
    a.sqlite.close()
    clock.t = T0 + 65_000
    const b = process(file, clock, fired, { graceMs: 5_000 })
    const report = await b.scheduler.tick()
    // the latest two missed slots plus the one fresh slot inside the grace window
    expect(report.fired.length).toBe(3)
    expect(report.skipped.filter((s) => s.reason === 'catch-up').length).toBeGreaterThan(0)
    b.sqlite.close()
  })

  test('fire may decline: { fired: false } is a skipped slot (reason declined), the schedule still advances', async () => {
    const file = freshFile('declined')
    const clock = { t: T0 }
    const fired: string[] = []
    const p = process(file, clock, fired, { fire: () => ({ fired: false }) })
    await p.scheduler.create({
      id: 'r1',
      sessionId: 'front:ben',
      spec: { kind: 'interval', everyMs: 10_000 },
      payload: {},
    })
    clock.t = T0 + 10_000
    const report = await p.scheduler.tick()
    expect(report.fired).toEqual([])
    expect(report.skipped).toEqual([
      { scheduleId: 'r1', scheduledAt: T0 + 10_000, reason: 'declined' },
    ])
    const row = await p.store.get('r1')
    expect(row?.nextFireAt).toBe(T0 + 20_000)
    expect(row?.lastFireAt).toBeUndefined()
    p.sqlite.close()
  })

  test('a process that dies inside a fire: its claim expires and another process takes the row over (the slot is then missed unless catchUp says otherwise)', async () => {
    const file = freshFile('recover')
    const clock = { t: T0 }
    const fired: string[] = []
    const a = process(file, clock, fired)
    await a.scheduler.create({
      id: 'r1',
      sessionId: 'front:ben',
      spec: { kind: 'once', at: T0 + 1_000 },
      payload: {},
    })
    clock.t = T0 + 2_000
    const row = await a.store.get('r1')
    // process A claims the row and "crashes" before firing
    expect(
      await a.store.claim('r1', row?.version as number, 'dead-owner', clock.t + 30_000),
    ).toBeDefined()
    a.sqlite.close()
    const b = process(file, clock, fired)
    expect((await b.scheduler.tick()).fired).toEqual([]) // the lease is still live
    clock.t += 31_000
    const report = await b.scheduler.tick()
    expect(report.recovered).toBe(1)
    // the slot is older than graceMs, so it is a missed slot: catchUp 'skip' (the default) drops it
    expect(fired).toEqual([])
    expect(report.skipped).toEqual([
      { scheduleId: 'r1', scheduledAt: T0 + 1_000, reason: 'catch-up' },
    ])
    b.sqlite.close()
  })
})
