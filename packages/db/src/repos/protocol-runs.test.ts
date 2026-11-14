import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { protocolRunsRepo } from './protocol-runs.ts'
import { protocolsRepo } from './protocols.ts'

// Runs and run steps (P28.1.5, docs/specs/hypothalamus.md "Engine"): the exactly-once start per trigger, the daily cap,
// the claim of due runs, and the compare-and-set advance that only one of two racing writers wins.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  protocolsRepo(sqlite).create(
    { id: 'pr1', owner: 'ana', name: 'stand up', definition: '{}', savedBy: 'ana' },
    1,
  )
  return sqlite
}

const newRun = (id: string, triggerRef: string, extra: { wakeAt?: number | null } = {}) => ({
  id,
  protocolId: 'pr1',
  version: 1,
  person: 'ana',
  triggerRef,
  step: 'ask',
  status: 'waiting' as const,
  wakeAt: extra.wakeAt ?? null,
})

const patchOf = (status: 'running' | 'waiting' | 'done', step: string | null, extra = {}) => ({
  status,
  step,
  visits: '{"ask":1}',
  answers: '{}',
  wakeAt: null,
  costUsd: 0,
  endedAt: null,
  ...extra,
})

describe('start: exactly once per trigger', () => {
  test('a second start with the same trigger returns the stored run and writes nothing', () => {
    const repo = protocolRunsRepo(db())
    const first = repo.start(newRun('r1', 'fire:1'), 100)
    expect(first).toMatchObject({
      status: 'created',
      run: { id: 'r1', startedAt: 100, updatedAt: 100, costUsd: 0 },
    })

    const again = repo.start(newRun('r2', 'fire:1'), 200)
    expect(again).toMatchObject({ status: 'exists', run: { id: 'r1', startedAt: 100 } })
    // the same run id is also a stored run: the id is the other key of the guard
    expect(repo.start(newRun('r1', 'fire:other'), 300)).toMatchObject({
      status: 'exists',
      run: { triggerRef: 'fire:1' },
    })
    expect(repo.list({ limit: 10 })).toHaveLength(1)
    expect(repo.findByTrigger('pr1', 'fire:1')?.id).toBe('r1')
  })

  test('the daily cap refuses the start without a row; a duplicate trigger is still reported as existing first', () => {
    const repo = protocolRunsRepo(db())
    const cap = { since: 0, max: 2 }
    expect(repo.start(newRun('r1', 'a'), 10, cap).status).toBe('created')
    expect(repo.start(newRun('r2', 'b'), 20, cap).status).toBe('created')
    expect(repo.start(newRun('r3', 'c'), 30, cap)).toEqual({ status: 'limit' })
    expect(repo.start(newRun('r4', 'a'), 40, cap)).toMatchObject({ status: 'exists' })
    expect(repo.get('r3')).toBeUndefined()
    // a new UTC day counts from its own start
    expect(repo.start(newRun('r5', 'c'), 50, { since: 40, max: 2 }).status).toBe('created')
  })

  test('a run may start already ended (a skipped one) and keeps its end', () => {
    const repo = protocolRunsRepo(db())
    const skipped = repo.start(
      { ...newRun('r1', 'x'), status: 'skipped', step: null, endedAt: 77 },
      70,
    )
    expect(skipped).toMatchObject({
      status: 'created',
      run: { status: 'skipped', step: null, endedAt: 77 },
    })
  })
})

describe('claim and advance', () => {
  test('claimDue takes the waiting runs that are due, oldest first, and no other ticker gets them again', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('late', 'l', { wakeAt: 500 }), 1)
    repo.start(newRun('early', 'e', { wakeAt: 200 }), 1)
    repo.start(newRun('future', 'f', { wakeAt: 9_000 }), 1)

    const claimed = repo.claimDue(1_000, 10)
    expect(claimed.map((r) => r.id)).toEqual(['early', 'late'])
    expect(claimed.every((r) => r.status === 'running' && r.wakeAt === null)).toBe(true)
    expect(repo.claimDue(1_000, 10)).toEqual([])
    expect(repo.get('future')?.status).toBe('waiting')
  })

  test('two advances of one run from the same read: only the first wins', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('r1', 't', { wakeAt: 100 }), 1)
    const [claimed] = repo.claimDue(200, 1)
    expect(claimed).toBeDefined()
    const seen = claimed?.updatedAt ?? -1

    const first = repo.advance('r1', seen, patchOf('waiting', 'wait', { wakeAt: 5_000 }), 300)
    const second = repo.advance('r1', seen, patchOf('done', null, { endedAt: 300 }), 301)
    expect(first).toMatchObject({ status: 'waiting', step: 'wait', wakeAt: 5_000 })
    expect(second).toBeUndefined()
    expect(repo.get('r1')).toMatchObject({ status: 'waiting', step: 'wait', endedAt: null })
  })

  test('each advance is a new revision, even within the same millisecond', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('r1', 't'), 1)
    const base = repo.get('r1')?.updatedAt ?? 0
    const a = repo.advance('r1', base, patchOf('waiting', 'ask'), 1)
    expect(a?.updatedAt).toBe(base + 1)
    const b = repo.advance('r1', a?.updatedAt ?? -1, patchOf('done', null, { endedAt: 1 }), 1)
    expect(b).toMatchObject({ status: 'done', updatedAt: base + 2, endedAt: 1 })
    // a claim is a revision too: a stale read cannot advance over it
    expect(repo.advance('r1', base + 1, patchOf('waiting', 'ask'), 5)).toBeUndefined()
  })

  test('a claim makes the previous read stale', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('r1', 't', { wakeAt: 10 }), 1)
    const read = repo.get('r1')?.updatedAt ?? -1
    repo.claimDue(20, 1)
    expect(repo.advance('r1', read, patchOf('done', null), 30)).toBeUndefined()
    expect(repo.get('r1')?.status).toBe('running')
  })

  test('inStatus lists runs of one status, for recovery after a restart', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('w', 'w', { wakeAt: 1 }), 1)
    repo.start(newRun('r', 'r', { wakeAt: 2 }), 1)
    repo.claimDue(5, 1)
    expect(repo.inStatus('running').map((r) => r.id)).toEqual(['w'])
    expect(repo.inStatus('waiting').map((r) => r.id)).toEqual(['r'])
  })

  test('list filters by protocol and person, newest first', () => {
    const sqlite = db()
    const repo = protocolRunsRepo(sqlite)
    repo.start(newRun('r1', 'a'), 10)
    repo.start({ ...newRun('r2', 'b'), person: 'bob' }, 20)
    repo.start(newRun('r3', 'c'), 30)
    expect(repo.list({ limit: 10 }).map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect(repo.list({ person: 'ana', limit: 10 }).map((r) => r.id)).toEqual(['r3', 'r1'])
    expect(repo.list({ protocolId: 'pr1', limit: 1 }).map((r) => r.id)).toEqual(['r3'])
  })
})

describe('steps', () => {
  test('a step row starts `started` and takes its outcome; steps come back in execution order', () => {
    const repo = protocolRunsRepo(db())
    repo.start(newRun('r1', 't'), 1)
    const n1 = repo.appendStep({
      runId: 'r1',
      step: 'notify',
      kind: 'notify',
      outcome: 'started',
      at: 10,
      detail: '{"len":5}',
    })
    const n2 = repo.appendStep({
      runId: 'r1',
      step: 'ask',
      kind: 'ask',
      outcome: 'started',
      at: 11,
    })
    expect(n2).toBeGreaterThan(n1)
    expect(repo.settleStep(n1, 'ok')).toBe(true)
    expect(repo.settleStep(n2, 'answered:yes', '{"option":"yes"}')).toBe(true)
    expect(repo.settleStep(999, 'ok')).toBe(false)

    expect(repo.steps('r1')).toEqual([
      {
        n: n1,
        runId: 'r1',
        step: 'notify',
        kind: 'notify',
        outcome: 'ok',
        at: 10,
        detail: '{"len":5}',
      },
      {
        n: n2,
        runId: 'r1',
        step: 'ask',
        kind: 'ask',
        outcome: 'answered:yes',
        at: 11,
        detail: '{"option":"yes"}',
      },
    ])
  })

  test('steps of a run cannot exist without the run', () => {
    const sqlite = db()
    expect(() =>
      protocolRunsRepo(sqlite).appendStep({
        runId: 'ghost',
        step: 'a',
        kind: 'wait',
        outcome: 'started',
        at: 1,
      }),
    ).toThrow(/FOREIGN KEY/)
  })
})
