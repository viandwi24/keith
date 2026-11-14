// The activity logs store (docs/specs/activity-logs.md, ADR-0032 §3, P36.2.1): sessions, calls and body blobs. A batch of calls is
// one `BEGIN IMMEDIATE`: the calls and their bodies are inserted, each session row is upserted (its last time, call count and cost
// move with the insert), then its primary model (the model with the most calls) is recomputed. Purges delete rows and then refresh
// the totals of the sessions they touched, so a session's totals always equal the sum of the calls it still holds. Bodies arrive as
// gzip blobs (the caller packs them); the repo never reads or writes plain text of a body. Times are epoch milliseconds.
import type { SQLQueryBindings } from 'bun:sqlite'
import {
  type LlmCallRecord,
  type LlmSessionKind,
  type LlmSessionRecord,
  LOGS_GENERATIONS_MAX,
  LOGS_PAGE_MAX,
} from '@keith/contracts'
import { immediate, type Sqlite } from './eh/sql.ts'

/** The session row a call belongs to. `kind`, `personId`, `roomId` and `app` are set at its first call and never change. */
export interface ActivitySessionInput {
  id: string
  kind: LlmSessionKind
  personId: string | null
  roomId: string | null
  app: string
}

/** The gzip blobs of one call's bodies. A null part was not kept. */
export interface ActivityBodiesInput {
  request: Uint8Array | null
  response: Uint8Array | null
  output: Uint8Array | null
}

/** One call to store: its session, its figures (`call.sessionId` must be `session.id`) and its bodies when kept. */
export interface ActivityCallInput {
  session: ActivitySessionInput
  call: LlmCallRecord
  bodies?: ActivityBodiesInput
}

/** The filters of a session list. `from` and `to` select sessions that were active in the range. `q` matches the start of the id. */
export interface ActivitySessionFilter {
  kind?: LlmSessionKind
  personId?: string
  roomId?: string
  model?: string
  from?: number
  to?: number
  q?: string
  /** A reader's view: the sessions of `personId`, and the room sessions of the rooms in `roomIds` (no other room). */
  visibleTo?: { personId: string; roomIds: string[] }
}

export interface ActivitySessionPage {
  sessions: LlmSessionRecord[]
  /** The cursor of the next page, or null when this page is the last. */
  nextCursor: string | null
}

/** The stored blobs of one call. */
export interface ActivityBodies {
  callId: string
  request: Uint8Array | null
  response: Uint8Array | null
  output: Uint8Array | null
}

export interface ActivityLogsStatus {
  sessions: number
  calls: number
  /** Rows of `llm_bodies`. */
  bodies: number
  /** Bytes of the stored blobs (after gzip). */
  bodyBytes: number
}

export interface ActivityLogsRepo {
  /** Stores a batch in one transaction. Returns the number of calls written. */
  insertCalls(batch: ActivityCallInput[]): number
  /** Sessions newest first (by `last_at`, then id), `limit` rows (default 50, at most `LOGS_PAGE_MAX`). */
  listSessions(
    filter?: ActivitySessionFilter,
    page?: { limit?: number | undefined; cursor?: string | undefined },
  ): ActivitySessionPage
  getSession(id: string): LlmSessionRecord | undefined
  /** The calls of a session, oldest first, at most `limit` (default and maximum `LOGS_GENERATIONS_MAX`). */
  listCalls(sessionId: string, limit?: number): LlmCallRecord[]
  getCall(id: string): LlmCallRecord | undefined
  getBodies(callId: string): ActivityBodies | undefined
  /** Deletes the bodies of calls started before `ts` and sets their `body_state` to `purged`. Figures stay. */
  purgeBodiesBefore(ts: number): { bodies: number }
  /** Deletes the calls (and their bodies) started before `ts`, then the sessions with no call left. */
  purgeBefore(ts: number): { calls: number; bodies: number; sessions: number }
  /** Deletes a person's sessions with their calls and bodies; a room call of the person keeps its room and loses the speaker. */
  purgePerson(personId: string): { sessions: number; calls: number; bodies: number }
  /** Deletes the bodies of a person's own sessions and sets their `body_state` to `purged`. Figures stay; room calls are not touched. */
  purgeBodiesOf(personId: string): { bodies: number }
  /** A person's own sessions, their calls and the bytes of their stored bodies (the figures a member sees of their own logs). */
  statusOf(personId: string): { sessions: number; calls: number; bodyBytes: number }
  /** The person's sessions, their calls (and the calls where they spoke in a room) and the stored bodies. */
  exportPerson(personId: string): {
    sessions: LlmSessionRecord[]
    calls: LlmCallRecord[]
    bodies: ActivityBodies[]
  }
  status(): ActivityLogsStatus
}

const CALL_COLUMNS = [
  'id',
  'session_id',
  'call_kind',
  'trigger',
  'turn_id',
  'step_index',
  'started_at',
  'duration_ms',
  'first_chunk_ms',
  'status',
  'finish_reason',
  'model_id',
  'provider',
  'upstream_provider',
  'tokens_in',
  'tokens_out',
  'cache_read',
  'cache_write',
  'reasoning',
  'cost_micro',
  'cost_source',
  'fallbacks',
  'error_name',
  'error_message',
  'request_bytes',
  'response_bytes',
  'body_state',
  'speaker_id',
] as const

const SESSION_COLUMNS =
  'id, kind, person_id, room_id, app, first_at, last_at, calls, cost_micro, primary_model, primary_provider'

interface CallRow {
  id: string
  session_id: string
  call_kind: string
  trigger: string | null
  turn_id: string | null
  step_index: number | null
  started_at: number
  duration_ms: number
  first_chunk_ms: number | null
  status: string
  finish_reason: string | null
  model_id: string
  provider: string
  upstream_provider: string | null
  tokens_in: number
  tokens_out: number
  cache_read: number | null
  cache_write: number | null
  reasoning: number | null
  cost_micro: number | null
  cost_source: string | null
  fallbacks: string | null
  error_name: string | null
  error_message: string | null
  request_bytes: number
  response_bytes: number
  body_state: string
  speaker_id: string | null
}

interface SessionRow {
  id: string
  kind: string
  person_id: string | null
  room_id: string | null
  app: string
  first_at: number
  last_at: number
  calls: number
  cost_micro: number
  primary_model: string | null
  primary_provider: string | null
}

const toCall = (r: CallRow): LlmCallRecord => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.call_kind as LlmCallRecord['kind'],
  trigger: r.trigger as LlmCallRecord['trigger'],
  turnId: r.turn_id,
  stepIndex: r.step_index,
  startedAt: r.started_at,
  durationMs: r.duration_ms,
  firstChunkMs: r.first_chunk_ms,
  status: r.status as LlmCallRecord['status'],
  finishReason: r.finish_reason,
  modelId: r.model_id,
  provider: r.provider,
  upstreamProvider: r.upstream_provider,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  cacheRead: r.cache_read,
  cacheWrite: r.cache_write,
  reasoning: r.reasoning,
  costMicro: r.cost_micro,
  costSource: r.cost_source as LlmCallRecord['costSource'],
  fallbackNote: r.fallbacks,
  errorName: r.error_name,
  errorMessage: r.error_message,
  requestBytes: r.request_bytes,
  responseBytes: r.response_bytes,
  bodyState: r.body_state as LlmCallRecord['bodyState'],
  speakerId: r.speaker_id,
})

const toSession = (r: SessionRow): LlmSessionRecord => ({
  id: r.id,
  kind: r.kind as LlmSessionKind,
  personId: r.person_id,
  roomId: r.room_id,
  app: r.app,
  firstAt: r.first_at,
  lastAt: r.last_at,
  calls: r.calls,
  costMicro: r.cost_micro,
  primaryModel: r.primary_model,
  primaryProvider: r.primary_provider,
})

/** The values of one call row, in `CALL_COLUMNS` order. */
const callValues = (c: LlmCallRecord): SQLQueryBindings[] => [
  c.id,
  c.sessionId,
  c.kind,
  c.trigger,
  c.turnId,
  c.stepIndex,
  c.startedAt,
  c.durationMs,
  c.firstChunkMs,
  c.status,
  c.finishReason,
  c.modelId,
  c.provider,
  c.upstreamProvider,
  c.tokensIn,
  c.tokensOut,
  c.cacheRead,
  c.cacheWrite,
  c.reasoning,
  c.costMicro,
  c.costSource,
  c.fallbackNote,
  c.errorName,
  c.errorMessage,
  c.requestBytes,
  c.responseBytes,
  c.bodyState,
  c.speakerId,
]

/** A cursor is `<last_at>:<id>`: the sort key of the last row of a page. */
const encodeCursor = (lastAt: number, id: string): string => `${lastAt}:${id}`

function decodeCursor(cursor: string): { lastAt: number; id: string } {
  const at = cursor.indexOf(':')
  const lastAt = at > 0 ? Number(cursor.slice(0, at)) : Number.NaN
  if (!Number.isSafeInteger(lastAt)) throw new Error('invalid activity-log cursor')
  return { lastAt, id: cursor.slice(at + 1) }
}

const clampLimit = (limit: number | undefined, max: number, fallback: number): number =>
  Math.min(Math.max(1, Math.trunc(limit ?? fallback)), max)

export function activityLogsRepo(sqlite: Sqlite): ActivityLogsRepo {
  const insertCall = `INSERT INTO llm_calls (${CALL_COLUMNS.join(', ')}) VALUES (${CALL_COLUMNS.map(() => '?').join(', ')})`

  /** The model with the most calls of a session becomes its primary (ties: the most recent, then the name). */
  const refreshPrimary = (id: string): void => {
    const top = sqlite
      .query<{ model_id: string; provider: string }, [string]>(
        `SELECT model_id, provider FROM llm_calls WHERE session_id = ?
         GROUP BY model_id, provider ORDER BY COUNT(*) DESC, MAX(started_at) DESC, model_id ASC LIMIT 1`,
      )
      .get(id)
    sqlite
      .query('UPDATE llm_sessions SET primary_model = ?, primary_provider = ? WHERE id = ?')
      .run(top?.model_id ?? null, top?.provider ?? null, id)
  }

  /** Recomputes every total of a session from the calls it still holds. A session with no call is left to the caller. */
  const refreshTotals = (id: string): void => {
    const count =
      sqlite
        .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM llm_calls WHERE session_id = ?')
        .get(id)?.n ?? 0
    if (count === 0) return
    sqlite
      .query(
        `UPDATE llm_sessions SET
           calls = (SELECT COUNT(*) FROM llm_calls c WHERE c.session_id = llm_sessions.id),
           cost_micro = (SELECT COALESCE(SUM(c.cost_micro), 0) FROM llm_calls c WHERE c.session_id = llm_sessions.id),
           first_at = (SELECT MIN(c.started_at) FROM llm_calls c WHERE c.session_id = llm_sessions.id),
           last_at = (SELECT MAX(c.started_at) FROM llm_calls c WHERE c.session_id = llm_sessions.id),
           bodies_off = CASE WHEN EXISTS (
             SELECT 1 FROM llm_bodies b JOIN llm_calls c ON c.id = b.call_id WHERE c.session_id = llm_sessions.id
           ) THEN 0 ELSE 1 END
         WHERE id = ?`,
      )
      .run(id)
    refreshPrimary(id)
  }

  const sessionIdsWhere = (where: string, ...params: SQLQueryBindings[]): string[] =>
    sqlite
      .query<{ id: string }, SQLQueryBindings[]>(
        `SELECT DISTINCT session_id AS id FROM llm_calls WHERE ${where}`,
      )
      .all(...params)
      .map((r) => r.id)

  return {
    insertCalls(batch) {
      if (batch.length === 0) return 0
      return immediate(sqlite, () => {
        const touched = new Map<
          string,
          {
            session: ActivitySessionInput
            calls: number
            cost: number
            first: number
            last: number
            bodies: boolean
          }
        >()
        const insert = sqlite.query(insertCall)
        const insertBodies = sqlite.query(
          'INSERT INTO llm_bodies (call_id, request, response, output) VALUES (?, ?, ?, ?)',
        )
        for (const { session, call, bodies } of batch) {
          if (call.sessionId !== session.id) {
            throw new Error(`call ${call.id} belongs to ${call.sessionId}, not ${session.id}`)
          }
          insert.run(...callValues(call))
          const kept = bodies !== undefined && (bodies.request || bodies.response || bodies.output)
          if (bodies !== undefined && kept) {
            insertBodies.run(call.id, bodies.request, bodies.response, bodies.output)
          }
          const t = touched.get(session.id) ?? {
            session,
            calls: 0,
            cost: 0,
            first: call.startedAt,
            last: call.startedAt,
            bodies: false,
          }
          t.calls += 1
          t.cost += call.costMicro ?? 0
          t.first = Math.min(t.first, call.startedAt)
          t.last = Math.max(t.last, call.startedAt)
          t.bodies = t.bodies || Boolean(kept)
          touched.set(session.id, t)
        }
        const upsert = sqlite.query(
          `INSERT INTO llm_sessions (id, kind, person_id, room_id, app, first_at, last_at, calls, cost_micro, bodies_off)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             first_at = MIN(llm_sessions.first_at, excluded.first_at),
             last_at = MAX(llm_sessions.last_at, excluded.last_at),
             calls = llm_sessions.calls + excluded.calls,
             cost_micro = llm_sessions.cost_micro + excluded.cost_micro,
             bodies_off = CASE WHEN excluded.bodies_off = 0 THEN 0 ELSE llm_sessions.bodies_off END`,
        )
        for (const [id, t] of touched) {
          upsert.run(
            id,
            t.session.kind,
            t.session.personId,
            t.session.roomId,
            t.session.app,
            t.first,
            t.last,
            t.calls,
            t.cost,
            t.bodies ? 0 : 1,
          )
          refreshPrimary(id)
        }
        return batch.length
      })
    },

    listSessions(filter = {}, page = {}) {
      const where: string[] = []
      const params: SQLQueryBindings[] = []
      if (filter.kind !== undefined) {
        where.push('kind = ?')
        params.push(filter.kind)
      }
      if (filter.visibleTo !== undefined) {
        const { personId, roomIds } = filter.visibleTo
        const rooms =
          roomIds.length > 0 ? ` OR room_id IN (${roomIds.map(() => '?').join(', ')})` : ''
        where.push(`(person_id = ?${rooms})`)
        params.push(personId, ...roomIds)
      }
      if (filter.personId !== undefined) {
        where.push('person_id = ?')
        params.push(filter.personId)
      }
      if (filter.roomId !== undefined) {
        where.push('room_id = ?')
        params.push(filter.roomId)
      }
      if (filter.model !== undefined) {
        where.push(
          'EXISTS (SELECT 1 FROM llm_calls c WHERE c.session_id = llm_sessions.id AND c.model_id = ?)',
        )
        params.push(filter.model)
      }
      if (filter.from !== undefined) {
        where.push('last_at >= ?')
        params.push(filter.from)
      }
      if (filter.to !== undefined) {
        where.push('first_at <= ?')
        params.push(filter.to)
      }
      if (filter.q !== undefined && filter.q !== '') {
        where.push('substr(id, 1, ?) = ?')
        params.push(filter.q.length, filter.q)
      }
      if (page.cursor !== undefined) {
        const key = decodeCursor(page.cursor)
        where.push('(last_at < ? OR (last_at = ? AND id < ?))')
        params.push(key.lastAt, key.lastAt, key.id)
      }
      const limit = clampLimit(page.limit, LOGS_PAGE_MAX, 50)
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const rows = sqlite
        .query<SessionRow, SQLQueryBindings[]>(
          `SELECT ${SESSION_COLUMNS} FROM llm_sessions ${clause} ORDER BY last_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, limit + 1)
      const shown = rows.slice(0, limit)
      const last = shown.at(-1)
      return {
        sessions: shown.map(toSession),
        nextCursor:
          rows.length > limit && last !== undefined ? encodeCursor(last.last_at, last.id) : null,
      }
    },

    getSession(id) {
      const row = sqlite
        .query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM llm_sessions WHERE id = ?`)
        .get(id)
      return row === null ? undefined : toSession(row)
    },

    listCalls(sessionId, limit = LOGS_GENERATIONS_MAX) {
      return sqlite
        .query<CallRow, [string, number]>(
          `SELECT ${CALL_COLUMNS.join(', ')} FROM llm_calls WHERE session_id = ?
           ORDER BY started_at ASC, id ASC LIMIT ?`,
        )
        .all(sessionId, clampLimit(limit, LOGS_GENERATIONS_MAX, LOGS_GENERATIONS_MAX))
        .map(toCall)
    },

    getCall(id) {
      const row = sqlite
        .query<CallRow, [string]>(`SELECT ${CALL_COLUMNS.join(', ')} FROM llm_calls WHERE id = ?`)
        .get(id)
      return row === null ? undefined : toCall(row)
    },

    getBodies(callId) {
      const row = sqlite
        .query<
          { request: Uint8Array | null; response: Uint8Array | null; output: Uint8Array | null },
          [string]
        >('SELECT request, response, output FROM llm_bodies WHERE call_id = ?')
        .get(callId)
      return row === null ? undefined : { callId, ...row }
    },

    purgeBodiesBefore(ts) {
      return immediate(sqlite, () => {
        const ids = sessionIdsWhere('started_at < ? AND id IN (SELECT call_id FROM llm_bodies)', ts)
        sqlite
          .query(
            'UPDATE llm_calls SET body_state = ? WHERE started_at < ? AND id IN (SELECT call_id FROM llm_bodies)',
          )
          .run('purged', ts)
        const bodies = sqlite
          .query(
            'DELETE FROM llm_bodies WHERE call_id IN (SELECT id FROM llm_calls WHERE started_at < ?)',
          )
          .run(ts).changes
        for (const id of ids) refreshTotals(id)
        return { bodies }
      })
    },

    purgeBodiesOf(personId) {
      return immediate(sqlite, () => {
        const own =
          'SELECT c.id FROM llm_calls c JOIN llm_sessions s ON s.id = c.session_id WHERE s.person_id = ?'
        sqlite
          .query(
            `UPDATE llm_calls SET body_state = 'purged' WHERE id IN (${own}) AND id IN (SELECT call_id FROM llm_bodies)`,
          )
          .run(personId)
        const bodies = sqlite
          .query(`DELETE FROM llm_bodies WHERE call_id IN (${own})`)
          .run(personId).changes
        sqlite.query('UPDATE llm_sessions SET bodies_off = 1 WHERE person_id = ?').run(personId)
        return { bodies }
      })
    },

    statusOf(personId) {
      const n = (sql: string): number =>
        sqlite.query<{ n: number }, [string]>(sql).get(personId)?.n ?? 0
      return {
        sessions: n('SELECT COUNT(*) AS n FROM llm_sessions WHERE person_id = ?'),
        calls: n(
          'SELECT COUNT(*) AS n FROM llm_calls WHERE session_id IN (SELECT id FROM llm_sessions WHERE person_id = ?)',
        ),
        bodyBytes: n(
          `SELECT COALESCE(SUM(length(b.request) + length(b.response) + length(b.output)), 0) AS n
           FROM llm_bodies b JOIN llm_calls c ON c.id = b.call_id JOIN llm_sessions s ON s.id = c.session_id
           WHERE s.person_id = ?`,
        ),
      }
    },

    purgeBefore(ts) {
      return immediate(sqlite, () => {
        const ids = sessionIdsWhere('started_at < ?', ts)
        const bodies = sqlite
          .query(
            'DELETE FROM llm_bodies WHERE call_id IN (SELECT id FROM llm_calls WHERE started_at < ?)',
          )
          .run(ts).changes
        const calls = sqlite.query('DELETE FROM llm_calls WHERE started_at < ?').run(ts).changes
        const sessions = sqlite
          .query(
            'DELETE FROM llm_sessions WHERE NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.session_id = llm_sessions.id)',
          )
          .run().changes
        for (const id of ids) refreshTotals(id)
        return { calls, bodies, sessions }
      })
    },

    purgePerson(personId) {
      return immediate(sqlite, () => {
        const own = 'SELECT id FROM llm_sessions WHERE person_id = ?'
        const bodies = sqlite
          .query(
            `DELETE FROM llm_bodies WHERE call_id IN (SELECT id FROM llm_calls WHERE session_id IN (${own}))`,
          )
          .run(personId).changes
        const calls = sqlite
          .query(`DELETE FROM llm_calls WHERE session_id IN (${own})`)
          .run(personId).changes
        const sessions = sqlite
          .query('DELETE FROM llm_sessions WHERE person_id = ?')
          .run(personId).changes
        sqlite.query('UPDATE llm_calls SET speaker_id = NULL WHERE speaker_id = ?').run(personId)
        return { sessions, calls, bodies }
      })
    },

    exportPerson(personId) {
      const sessions = sqlite
        .query<SessionRow, [string]>(
          `SELECT ${SESSION_COLUMNS} FROM llm_sessions WHERE person_id = ? ORDER BY first_at ASC, id ASC`,
        )
        .all(personId)
        .map(toSession)
      const calls = sqlite
        .query<CallRow, [string, string]>(
          `SELECT ${CALL_COLUMNS.join(', ')} FROM llm_calls
           WHERE session_id IN (SELECT id FROM llm_sessions WHERE person_id = ?) OR speaker_id = ?
           ORDER BY started_at ASC, id ASC`,
        )
        .all(personId, personId)
        .map(toCall)
      const bodies = sqlite
        .query<
          {
            call_id: string
            request: Uint8Array | null
            response: Uint8Array | null
            output: Uint8Array | null
          },
          [string, string]
        >(
          `SELECT call_id, request, response, output FROM llm_bodies WHERE call_id IN (
             SELECT id FROM llm_calls WHERE session_id IN (SELECT id FROM llm_sessions WHERE person_id = ?) OR speaker_id = ?)`,
        )
        .all(personId, personId)
        .map((r) => ({
          callId: r.call_id,
          request: r.request,
          response: r.response,
          output: r.output,
        }))
      return { sessions, calls, bodies }
    },

    status() {
      const count = (table: string): number =>
        sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0
      const bytes =
        sqlite
          .query<{ n: number }, []>(
            'SELECT COALESCE(SUM(length(request) + length(response) + length(output)), 0) AS n FROM llm_bodies',
          )
          .get()?.n ?? 0
      return {
        sessions: count('llm_sessions'),
        calls: count('llm_calls'),
        bodies: count('llm_bodies'),
        bodyBytes: bytes,
      }
    },
  }
}
