import type { Sqlite } from '../eh/sql.ts'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'timed_out'
  | 'interrupted'

/** A delegated worker on the task board. `id` is the child session id. */
export interface TaskRecord {
  id: string
  parentSessionId: string
  /** Catalog key of the worker agent, e.g. `cortex.research`. */
  agent: string
  description: string
  status: TaskStatus
  steps: number
  summary: string | null
  error: string | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export type TaskInput = Pick<TaskRecord, 'id' | 'parentSessionId' | 'agent' | 'description'> &
  Partial<Omit<TaskRecord, 'id' | 'parentSessionId' | 'agent' | 'description'>>

export interface TaskListQuery {
  parentSessionId?: string
  /** true: only queued, running and waiting; false: only the finished ones. */
  active?: boolean
  limit?: number
}

export interface TasksRepo {
  /** Insert or update by id; an update keeps `createdAt`. */
  /**
   * Insert or update by id; an update keeps `createdAt`. A final status (`done`, `failed`, `stopped`,
   * `timed_out`, `interrupted`) is never replaced by an active one: the row keeps it.
   */
  upsert(task: TaskInput): TaskRecord
  get(id: string): TaskRecord | undefined
  /** Newest updated first. */
  list(query?: TaskListQuery): TaskRecord[]
  /** Set a final status; `finishedAt` and `updatedAt` become now. Undefined when the id is unknown. */
  markFinished(
    id: string,
    result: { status: TaskStatus; summary?: string; error?: string },
  ): TaskRecord | undefined
}

interface TaskRow {
  id: string
  parent_session_id: string
  agent: string
  description: string
  status: string
  steps: number
  summary: string | null
  error: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

const COLUMNS =
  'id, parent_session_id, agent, description, status, steps, summary, error, created_at, updated_at, finished_at'
const ACTIVE = "('queued', 'running', 'waiting')"
/** Final statuses: a row that holds one never goes back to an active one (ADR-0027 §11, F-007). */
const FINAL = "('done', 'failed', 'stopped', 'timed_out', 'interrupted')"

const toRecord = (r: TaskRow): TaskRecord => ({
  id: r.id,
  parentSessionId: r.parent_session_id,
  agent: r.agent,
  description: r.description,
  status: r.status as TaskStatus,
  steps: r.steps,
  summary: r.summary,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
})

export function tasksRepo(sqlite: Sqlite, options: { now?: () => number } = {}): TasksRepo {
  const now = options.now ?? ((): number => Date.now())
  const get = (id: string): TaskRecord | undefined => {
    const row = sqlite.query<TaskRow, [string]>(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id)
    return row === null ? undefined : toRecord(row)
  }

  return {
    upsert(task) {
      const at = now()
      sqlite
        .query(
          `INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             parent_session_id = excluded.parent_session_id, agent = excluded.agent,
             description = excluded.description, steps = excluded.steps,
             summary = excluded.summary, error = excluded.error,
             status = CASE WHEN tasks.status IN ${FINAL} AND excluded.status NOT IN ${FINAL}
               THEN tasks.status ELSE excluded.status END,
             finished_at = CASE WHEN tasks.status IN ${FINAL} AND excluded.status NOT IN ${FINAL}
               THEN tasks.finished_at ELSE excluded.finished_at END,
             updated_at = excluded.updated_at`,
        )
        .run(
          task.id,
          task.parentSessionId,
          task.agent,
          task.description,
          task.status ?? 'queued',
          task.steps ?? 0,
          task.summary ?? null,
          task.error ?? null,
          task.createdAt ?? at,
          task.updatedAt ?? at,
          task.finishedAt ?? null,
        )
      return get(task.id) as TaskRecord
    },
    get,
    list(query = {}) {
      const where: string[] = []
      const params: string[] = []
      if (query.parentSessionId !== undefined) {
        where.push('parent_session_id = ?')
        params.push(query.parentSessionId)
      }
      if (query.active !== undefined) {
        where.push(`status ${query.active ? 'IN' : 'NOT IN'} ${ACTIVE}`)
      }
      const sql = `SELECT ${COLUMNS} FROM tasks${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, rowid DESC LIMIT ?`
      return sqlite
        .query<TaskRow, Array<string | number>>(sql)
        .all(...params, query.limit ?? 100)
        .map(toRecord)
    },
    markFinished(id, result) {
      const at = now()
      sqlite
        .query(
          `UPDATE tasks SET status = ?, summary = COALESCE(?, summary), error = COALESCE(?, error),
             updated_at = ?, finished_at = ? WHERE id = ?`,
        )
        .run(result.status, result.summary ?? null, result.error ?? null, at, at, id)
      return get(id)
    },
  }
}
