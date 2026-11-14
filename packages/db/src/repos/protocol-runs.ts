// The `protocol_runs` and `protocol_run_steps` tables (docs/specs/hypothalamus.md, "Data model" and "Engine"). A run is
// started once per trigger, claimed by one ticker, and advanced by compare-and-set on its `updated_at`, so two engines
// (or a tick racing a restart) cannot both move it. The engine decides the transitions; this repo guards that each
// write applies to the state the engine read. Pruning of ended runs is in retention.ts.
import { immediate, type Sqlite } from '../eh/sql.ts'
import type { RunStatus } from './protocols.ts'

export interface RunRecord {
  id: string
  protocolId: string
  version: number
  /** The principal the run acts for. */
  person: string
  /** The fire id, `absence:<lastSignAt>`, a signal id or an event sequence: the exactly-once key with the protocol. */
  triggerRef: string
  status: RunStatus
  /** The current step id; null once the run ended. */
  step: string | null
  /** JSON counts of executions per step id. */
  visits: string
  /** JSON answers of `ask` steps. */
  answers: string
  wakeAt: number | null
  costUsd: number
  startedAt: number
  updatedAt: number
  endedAt: number | null
}

export interface NewRun {
  id: string
  protocolId: string
  version: number
  person: string
  triggerRef: string
  /** The first step, or null when the run starts ended. */
  step: string | null
  status: RunStatus
  wakeAt: number | null
  visits?: string
  answers?: string
  endedAt?: number | null
}

/**
 * `created`: a new row. `exists`: the trigger already started a run (the stored row, nothing written). `limit`: the
 * protocol started `max` runs since `cap.since` (its `maxRunsPerDay`); no row is written.
 */
export type StartRunResult =
  | { status: 'created'; run: RunRecord }
  | { status: 'exists'; run: RunRecord }
  | { status: 'limit' }

/** The state a run moves to. `wakeAt` is absolute; `endedAt` is set when the status is an end. */
export interface RunPatch {
  status: RunStatus
  step: string | null
  visits: string
  answers: string
  wakeAt: number | null
  costUsd: number
  endedAt: number | null
}

export interface RunStepRecord {
  n: number
  runId: string
  step: string
  kind: string
  /** `started`, then `ok`, `answered:<x>`, `timeout`, `refused:<reason>`, `failed:<reason>` or `unknown`. */
  outcome: string
  at: number
  /** JSON of ids, lengths and reasons; never message text. */
  detail: string | null
}

export interface NewRunStep {
  runId: string
  step: string
  kind: string
  outcome: string
  at: number
  detail?: string | null
}

export interface ProtocolRunsRepo {
  /**
   * Starts a run unless the trigger already did: one `BEGIN IMMEDIATE` checks the stored run of the same id or of the
   * same `(protocolId, triggerRef)` first (`exists`), then the optional daily cap (`limit`), then inserts (`created`).
   */
  start(input: NewRun, at: number, cap?: { since: number; max: number }): StartRunResult
  get(id: string): RunRecord | undefined
  findByTrigger(protocolId: string, triggerRef: string): RunRecord | undefined
  /** Runs, newest first; filtered by protocol and person when given. */
  list(filter: { protocolId?: string; person?: string; limit: number }): RunRecord[]
  /** Runs in a status, oldest first (recovery reads `running` and `waiting`). */
  inStatus(status: RunStatus): RunRecord[]
  /**
   * Claims the waiting runs whose `wake_at` is at or before `now`, oldest first, at most `limit`: each moves to `running`
   * with no `wake_at`, in one `BEGIN IMMEDIATE`. A run another ticker already claimed is not returned again.
   */
  claimDue(now: number, limit: number): RunRecord[]
  /**
   * Writes `patch` only when the run still has `expectedUpdatedAt` (the compare-and-set of two advances of one run: the
   * second one gets `undefined`). The stored `updated_at` becomes `max(at, expectedUpdatedAt + 1)`, so every write is a
   * new revision even within one millisecond.
   */
  advance(id: string, expectedUpdatedAt: number, patch: RunPatch, at: number): RunRecord | undefined
  /** Appends a step row and returns its `n` (the AUTOINCREMENT order). */
  appendStep(input: NewRunStep): number
  /** Sets the outcome of a step row (the `started` row becomes `ok`, `failed:…`, `unknown`, …); false when no row. */
  settleStep(n: number, outcome: string, detail?: string | null): boolean
  /** The steps of a run in execution order. */
  steps(runId: string, limit?: number): RunStepRecord[]
}

interface RunRow {
  id: string
  protocol_id: string
  version: number
  person: string
  trigger_ref: string
  status: string
  step: string | null
  visits: string
  answers: string
  wake_at: number | null
  cost_usd: number
  started_at: number
  updated_at: number
  ended_at: number | null
}

interface StepRow {
  n: number
  run_id: string
  step: string
  kind: string
  outcome: string
  at: number
  detail: string | null
}

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  protocolId: r.protocol_id,
  version: r.version,
  person: r.person,
  triggerRef: r.trigger_ref,
  status: r.status as RunStatus,
  step: r.step,
  visits: r.visits,
  answers: r.answers,
  wakeAt: r.wake_at,
  costUsd: r.cost_usd,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  endedAt: r.ended_at,
})

const toStep = (r: StepRow): RunStepRecord => ({
  n: r.n,
  runId: r.run_id,
  step: r.step,
  kind: r.kind,
  outcome: r.outcome,
  at: r.at,
  detail: r.detail,
})

export function protocolRunsRepo(sqlite: Sqlite): ProtocolRunsRepo {
  const row = (id: string) =>
    sqlite.query<RunRow, [string]>('SELECT * FROM protocol_runs WHERE id = ?').get(id)
  const byTrigger = (protocolId: string, triggerRef: string) =>
    sqlite
      .query<RunRow, [string, string]>(
        'SELECT * FROM protocol_runs WHERE protocol_id = ? AND trigger_ref = ?',
      )
      .get(protocolId, triggerRef)

  return {
    start(input, at, cap) {
      return immediate(sqlite, (): StartRunResult => {
        const stored = row(input.id) ?? byTrigger(input.protocolId, input.triggerRef)
        if (stored !== null) return { status: 'exists', run: toRun(stored) }
        if (cap !== undefined) {
          const started = sqlite
            .query<{ n: number }, [string, number]>(
              'SELECT COUNT(*) AS n FROM protocol_runs WHERE protocol_id = ? AND started_at >= ?',
            )
            .get(input.protocolId, cap.since)
          if ((started?.n ?? 0) >= cap.max) return { status: 'limit' }
        }
        const ended = input.endedAt ?? null
        sqlite
          .query(
            `INSERT INTO protocol_runs (id, protocol_id, version, person, trigger_ref, status, step, visits, answers,
               wake_at, cost_usd, started_at, updated_at, ended_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.protocolId,
            input.version,
            input.person,
            input.triggerRef,
            input.status,
            input.step,
            input.visits ?? '{}',
            input.answers ?? '{}',
            input.wakeAt,
            at,
            at,
            ended,
          )
        const created = row(input.id)
        if (created === null)
          throw new Error(`protocol_runs: row ${input.id} vanished after insert`)
        return { status: 'created', run: toRun(created) }
      })
    },
    get(id) {
      const r = row(id)
      return r === null ? undefined : toRun(r)
    },
    findByTrigger(protocolId, triggerRef) {
      const r = byTrigger(protocolId, triggerRef)
      return r === null ? undefined : toRun(r)
    },
    list(filter) {
      const where: string[] = []
      const params: (string | number)[] = []
      if (filter.protocolId !== undefined) {
        where.push('protocol_id = ?')
        params.push(filter.protocolId)
      }
      if (filter.person !== undefined) {
        where.push('person = ?')
        params.push(filter.person)
      }
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      return sqlite
        .query<RunRow, (string | number)[]>(
          `SELECT * FROM protocol_runs ${clause} ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, filter.limit)
        .map(toRun)
    },
    inStatus(status) {
      return sqlite
        .query<RunRow, [string]>(
          'SELECT * FROM protocol_runs WHERE status = ? ORDER BY updated_at, id',
        )
        .all(status)
        .map(toRun)
    },
    claimDue(now, limit) {
      return immediate(sqlite, () => {
        const due = sqlite
          .query<{ id: string }, [number, number]>(
            `SELECT id FROM protocol_runs WHERE status = 'waiting' AND wake_at <= ?
             ORDER BY wake_at, id LIMIT ?`,
          )
          .all(now, limit)
        const claimed: RunRecord[] = []
        for (const { id } of due) {
          const changes = sqlite
            .query(
              `UPDATE protocol_runs SET status = 'running', wake_at = NULL, updated_at = max(?, updated_at + 1)
               WHERE id = ? AND status = 'waiting'`,
            )
            .run(now, id).changes
          if (changes === 0) continue
          const r = row(id)
          if (r !== null) claimed.push(toRun(r))
        }
        return claimed
      })
    },
    advance(id, expectedUpdatedAt, patch, at) {
      const changes = sqlite
        .query(
          `UPDATE protocol_runs SET status = ?, step = ?, visits = ?, answers = ?, wake_at = ?, cost_usd = ?,
             ended_at = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(
          patch.status,
          patch.step,
          patch.visits,
          patch.answers,
          patch.wakeAt,
          patch.costUsd,
          patch.endedAt,
          Math.max(at, expectedUpdatedAt + 1),
          id,
          expectedUpdatedAt,
        ).changes
      if (changes === 0) return undefined
      const r = row(id)
      return r === null ? undefined : toRun(r)
    },
    appendStep(input) {
      const result = sqlite
        .query(
          'INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at, detail) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(input.runId, input.step, input.kind, input.outcome, input.at, input.detail ?? null)
      return Number(result.lastInsertRowid)
    },
    settleStep(n, outcome, detail) {
      if (detail === undefined) {
        return (
          sqlite.query('UPDATE protocol_run_steps SET outcome = ? WHERE n = ?').run(outcome, n)
            .changes > 0
        )
      }
      return (
        sqlite
          .query('UPDATE protocol_run_steps SET outcome = ?, detail = ? WHERE n = ?')
          .run(outcome, detail, n).changes > 0
      )
    },
    steps(runId, limit = 1000) {
      return sqlite
        .query<StepRow, [string, number]>(
          'SELECT * FROM protocol_run_steps WHERE run_id = ? ORDER BY n LIMIT ?',
        )
        .all(runId, limit)
        .map(toStep)
    },
  }
}
