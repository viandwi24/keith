// The memory dreaming rows (docs/specs/dreaming.md, ADR-0031 §5, §8, P35.2.1): the mode of each person and one row per run.
// A run row is written twice: `startRun` inserts it as `running`, `endRun` sets its final status, counts, cursor and undo
// time. The cadence anchor (`latestStarted`) ignores `skipped` rows; the cursor (`cursorOf`) comes from the latest `applied`
// or `staged` row, so a run that failed before its apply does not move it. Counts and cursors are JSON; the counts are
// checked against the contract's shape. Mode values are checked against the contract's list.
import {
  type DreamMode,
  DreamModeSchema,
  type DreamRunCounts,
  DreamRunCountsSchema,
  type DreamTrigger,
  DreamTriggerSchema,
} from '@keith/contracts'
import { immediate, type Sqlite } from '../eh/sql.ts'

/**
 * The status a run row holds. It is not the contract's `DreamRunStatus` (a run view): the row keeps what the applier did
 * (`applied`, `staged`, `rejected`) and `running` while the run lasts.
 */
export const DREAM_ROW_STATUSES = [
  'running',
  'applied',
  'staged',
  'skipped',
  'refused',
  'failed',
  'rejected',
] as const
export type DreamRowStatus = (typeof DREAM_ROW_STATUSES)[number]

/** The counts of a run that has not written anything yet: every count at zero (the contract's shape). */
const ZERO_COUNTS: DreamRunCounts = {
  candidates: 0,
  promoted: 0,
  merged: 0,
  superseded: 0,
  dropped: 0,
}

/** The cursor of a run: the last message id collected, per session id. */
export type DreamCursor = Record<string, string>

/**
 * The reserved cursor key of a failed run that holds a resume point (docs/specs/dreaming.md, "Failed batches"). Its value is the JSON
 * array of the source message ids of the batch the judge failed on (a run that may be retried), or `[]` when the run skipped that
 * batch (the cursor moved past it). Never a session id (those start with `front:`); `cursorOf` returns the cursor without it.
 */
export const FAILED_BATCH_KEY = '$failed-batch'

/** One run row as the repo reads it. */
export interface DreamRunRecord {
  id: string
  personId: string
  trigger: DreamTrigger
  mode: DreamMode
  status: DreamRowStatus
  reason: string | null
  startedAt: number
  endedAt: number | null
  counts: DreamRunCounts
  cursor: DreamCursor
  undoUntil: number | null
}

/** What a new run starts with. */
export interface NewDreamRun {
  personId: string
  trigger: DreamTrigger
  mode: DreamMode
}

/**
 * The final state of a run. Omitted `counts` and `cursor` keep what the row holds; `undoUntil` is null for a run that set no
 * undo window.
 */
export interface DreamRunEnd {
  status: Exclude<DreamRowStatus, 'running'>
  reason?: string | null
  counts?: DreamRunCounts
  cursor?: DreamCursor
  undoUntil?: number | null
  /**
   * A failed run that holds a resume point: the source message ids of the batch it failed on (`[]` when the batch was skipped and
   * `cursor` moved past it), stored under `FAILED_BATCH_KEY`. Omitted: the failed row holds no resume point (the cursor stays).
   */
  failedBatch?: readonly string[]
}

export interface DreamingRepoOptions {
  now?: () => number
}

export interface DreamingRepo {
  /** The stored mode of a person, or undefined when no row exists (the caller applies the owner or member default). */
  getMode(personId: string): DreamMode | undefined
  /** Stores the mode of a person (one row per person, replaced on each write). Returns the mode written. */
  setMode(personId: string, mode: DreamMode, updatedBy: string): DreamMode
  /** Inserts a `running` row and returns its id (UUIDv7). */
  startRun(input: NewDreamRun): string
  /** Sets the final status of a run and stamps `ended_at`. False when no row has that id. */
  endRun(id: string, end: DreamRunEnd): boolean
  /**
   * Ends every `running` row as `failed` with reason `interrupted` (the core stopped during the run) and returns the rows
   * it ended, as they were before (their id, person and trigger are what the boot repair announces). Called at boot only:
   * nothing runs before the boot, so every `running` row belongs to a process that is gone.
   */
  failRunning(): DreamRunRecord[]
  /** The latest `started_at` of a run that is not `skipped`, or undefined when there is none (the cadence anchor). */
  latestStarted(personId: string): number | undefined
  /** The cursor of the latest `applied` or `staged` run, or undefined when there is none (collect from the start). */
  cursorOf(personId: string): DreamCursor | undefined
  /**
   * The batch the latest run failed on, when that run was a failure that may be retried (`failedBatch` of its `endRun`, not empty),
   * else undefined. A later `applied` or `staged` run, or a failure that skipped its batch, clears it.
   */
  failedBatchOf(personId: string): string[] | undefined
  /** The runs of a person, newest first. */
  listRuns(personId: string, limit?: number): DreamRunRecord[]
  /** Deletes the mode and the runs of a person (the purge of a removed person). Returns the rows deleted per table. */
  deleteForPerson(personId: string): { settings: number; runs: number }
}

interface RunRow {
  id: string
  person_id: string
  trigger: string
  mode: string
  status: string
  reason: string | null
  started_at: number
  ended_at: number | null
  counts: string
  cursor: string
  undo_until: number | null
}

const RUN_COLUMNS = `id, person_id, trigger, mode, status, reason, started_at, ended_at, counts, cursor, undo_until`

const toRun = (row: RunRow): DreamRunRecord => ({
  id: row.id,
  personId: row.person_id,
  trigger: DreamTriggerSchema.parse(row.trigger),
  mode: DreamModeSchema.parse(row.mode),
  status: row.status as DreamRowStatus,
  reason: row.reason,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  counts: DreamRunCountsSchema.parse(JSON.parse(row.counts)),
  cursor: JSON.parse(row.cursor) as DreamCursor,
  undoUntil: row.undo_until,
})

export function dreamingRepo(sqlite: Sqlite, options: DreamingRepoOptions = {}): DreamingRepo {
  const now = options.now ?? Date.now

  // The row that holds the resume point: an applied or staged run, or a failed run that holds one (it carries the reserved key;
  // a failed run without it, such as a plain crash, never moves the cursor).
  const cursorRow = (personId: string): { cursor: string } | null =>
    sqlite
      .query<{ cursor: string }, [string, string]>(
        `SELECT cursor FROM dream_runs
         WHERE person_id = ? AND (status IN ('applied', 'staged') OR (status = 'failed' AND instr(cursor, ?) > 0))
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(personId, `"${FAILED_BATCH_KEY}"`)
  const cursorOfRow = (row: { cursor: string }): DreamCursor => {
    const parsed = JSON.parse(row.cursor) as DreamCursor
    const { [FAILED_BATCH_KEY]: _batch, ...cursor } = parsed
    return cursor
  }

  return {
    getMode(personId) {
      const row = sqlite
        .query<{ mode: string }, [string]>('SELECT mode FROM dream_settings WHERE person_id = ?')
        .get(personId)
      return row === null ? undefined : DreamModeSchema.parse(row.mode)
    },
    setMode(personId, mode, updatedBy) {
      const value = DreamModeSchema.parse(mode)
      sqlite
        .query(
          `INSERT INTO dream_settings (person_id, mode, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT (person_id) DO UPDATE SET mode = excluded.mode,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(personId, value, now(), updatedBy)
      return value
    },
    startRun({ personId, trigger, mode }) {
      const id = Bun.randomUUIDv7()
      sqlite
        .query(
          `INSERT INTO dream_runs (id, person_id, trigger, mode, status, started_at, counts)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          id,
          personId,
          DreamTriggerSchema.parse(trigger),
          DreamModeSchema.parse(mode),
          now(),
          JSON.stringify(ZERO_COUNTS),
        )
      return id
    },
    endRun(id, end) {
      const counts =
        end.counts === undefined ? null : JSON.stringify(DreamRunCountsSchema.parse(end.counts))
      const withBatch: DreamCursor | undefined =
        end.failedBatch === undefined
          ? end.cursor
          : { ...end.cursor, [FAILED_BATCH_KEY]: JSON.stringify(end.failedBatch) }
      const cursor = withBatch === undefined ? null : JSON.stringify(withBatch)
      const undoUntil = end.undoUntil ?? null
      const changes = sqlite
        .query(
          `UPDATE dream_runs SET status = ?, reason = ?, ended_at = ?,
             counts = COALESCE(?, counts), cursor = COALESCE(?, cursor), undo_until = ?
           WHERE id = ?`,
        )
        .run(end.status, end.reason ?? null, now(), counts, cursor, undoUntil, id).changes
      return changes > 0
    },
    failRunning() {
      const running = (
        sqlite
          .query(`SELECT ${RUN_COLUMNS} FROM dream_runs WHERE status = 'running'`)
          .all() as RunRow[]
      ).map(toRun)
      const ended = now()
      for (const run of running)
        sqlite
          .query(
            `UPDATE dream_runs SET status = 'failed', reason = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(ended, run.id)
      return running.map((run) => ({
        ...run,
        status: 'failed' as const,
        reason: 'interrupted',
        endedAt: ended,
      }))
    },
    latestStarted(personId) {
      const row = sqlite
        .query<{ at: number | null }, [string]>(
          `SELECT MAX(started_at) AS at FROM dream_runs WHERE person_id = ? AND status <> 'skipped'`,
        )
        .get(personId)
      return row?.at ?? undefined
    },
    cursorOf(personId) {
      const row = cursorRow(personId)
      return row === null ? undefined : cursorOfRow(row)
    },
    failedBatchOf(personId) {
      const row = cursorRow(personId)
      if (row === null) return undefined
      const raw = (JSON.parse(row.cursor) as DreamCursor)[FAILED_BATCH_KEY]
      if (raw === undefined) return undefined
      const batch: unknown = JSON.parse(raw)
      if (!Array.isArray(batch) || batch.length === 0) return undefined
      return batch.filter((id): id is string => typeof id === 'string')
    },
    listRuns(personId, limit = 50) {
      return sqlite
        .query<RunRow, [string, number]>(
          `SELECT ${RUN_COLUMNS} FROM dream_runs WHERE person_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(personId, limit)
        .map(toRun)
    },
    deleteForPerson(personId) {
      return immediate(sqlite, () => ({
        runs: sqlite.query('DELETE FROM dream_runs WHERE person_id = ?').run(personId).changes,
        settings: sqlite.query('DELETE FROM dream_settings WHERE person_id = ?').run(personId)
          .changes,
      }))
    },
  }
}
