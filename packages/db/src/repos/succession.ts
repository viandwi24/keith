// The `succession_state` row (docs/specs/succession.md, "States"). A move applies only when the row is still in the state
// the caller read: each write is one `BEGIN IMMEDIATE`, so two writers cannot both leave the same state. The claim runs
// its guard, the transfer and the state change in `transaction`, so a failure rolls all three back.
import { immediate, type Sqlite } from '../eh/sql.ts'

export const SUCCESSION_STATES = ['idle', 'check-in', 'grace', 'claimable', 'claimed'] as const
export type SuccessionStateName = (typeof SUCCESSION_STATES)[number]

export interface SuccessionRecord {
  state: SuccessionStateName
  runId: string | null
  heir: string | null
  startedAt: number | null
  graceStartedAt: number | null
  claimableAt: number | null
  lastSignAt: number | null
  /** 0 when no row was ever written (the idle default). */
  updatedAt: number
}

export interface SuccessionStart {
  runId: string
  heir: string
  startedAt: number
  lastSignAt: number | null
}

/** The times a move may set; an omitted one keeps its stored value. */
export interface SuccessionFields {
  graceStartedAt?: number | null
  claimableAt?: number | null
}

export interface SuccessionRepo {
  /** The row, or the idle default when no run was ever started. */
  get(): SuccessionRecord
  /**
   * Starts a run: only from `idle` or `claimed` (the last outcome stays until the next run). Returns false, and writes
   * nothing, while a run is active.
   */
  start(input: SuccessionStart, at: number): boolean
  /** Moves `from` to `to` when the row is in `from`; false and no write otherwise. */
  move(
    from: SuccessionStateName,
    to: SuccessionStateName,
    at: number,
    fields?: SuccessionFields,
  ): boolean
  /** Runs `fn` in one `BEGIN IMMEDIATE`: a throw rolls back every write it made, the state included. */
  transaction<T>(fn: () => T): T
}

interface Row {
  state: string
  run_id: string | null
  heir: string | null
  started_at: number | null
  grace_started_at: number | null
  claimable_at: number | null
  last_sign_at: number | null
  updated_at: number
}

const IDLE: SuccessionRecord = {
  state: 'idle',
  runId: null,
  heir: null,
  startedAt: null,
  graceStartedAt: null,
  claimableAt: null,
  lastSignAt: null,
  updatedAt: 0,
}

export function successionRepo(sqlite: Sqlite): SuccessionRepo {
  const read = (): SuccessionRecord => {
    const row = sqlite
      .query<Row, []>(
        `SELECT state, run_id, heir, started_at, grace_started_at, claimable_at, last_sign_at, updated_at
         FROM succession_state WHERE id = 1`,
      )
      .get()
    if (row === null) return IDLE
    return {
      state: row.state as SuccessionStateName,
      runId: row.run_id,
      heir: row.heir,
      startedAt: row.started_at,
      graceStartedAt: row.grace_started_at,
      claimableAt: row.claimable_at,
      lastSignAt: row.last_sign_at,
      updatedAt: row.updated_at,
    }
  }

  const write = (record: SuccessionRecord): void => {
    sqlite
      .query(
        `INSERT INTO succession_state
           (id, state, run_id, heir, started_at, grace_started_at, claimable_at, last_sign_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           state = excluded.state, run_id = excluded.run_id, heir = excluded.heir,
           started_at = excluded.started_at, grace_started_at = excluded.grace_started_at,
           claimable_at = excluded.claimable_at, last_sign_at = excluded.last_sign_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.state,
        record.runId,
        record.heir,
        record.startedAt,
        record.graceStartedAt,
        record.claimableAt,
        record.lastSignAt,
        record.updatedAt,
      )
  }

  return {
    get: read,
    start(input, at) {
      return immediate(sqlite, () => {
        const current = read()
        if (current.state !== 'idle' && current.state !== 'claimed') return false
        write({
          state: 'check-in',
          runId: input.runId,
          heir: input.heir,
          startedAt: input.startedAt,
          graceStartedAt: null,
          claimableAt: null,
          lastSignAt: input.lastSignAt,
          updatedAt: at,
        })
        return true
      })
    },
    move(from, to, at, fields = {}) {
      return immediate(sqlite, () => {
        const current = read()
        if (current.state !== from) return false
        write({
          ...current,
          state: to,
          graceStartedAt:
            fields.graceStartedAt === undefined ? current.graceStartedAt : fields.graceStartedAt,
          claimableAt: fields.claimableAt === undefined ? current.claimableAt : fields.claimableAt,
          updatedAt: at,
        })
        return true
      })
    },
    transaction: (fn) => immediate(sqlite, fn),
  }
}
