// The activity logs (docs/specs/activity-logs.md, ADR-0032 §3, P36.2.1): one row per session, one row per provider call, and one
// row of gzip blobs per call that keeps bodies. No foreign keys (as `front_generations`): a removed person's rows are deleted by the
// activity-logs removal part, and bodies are purged apart from figures so retention can drop them alone. Times are epoch
// milliseconds; cost is integer micro-dollars. The closed sets come from the contract (`@keith/contracts`), so the CHECKs read them.
import {
  LLM_BODY_STATES,
  LLM_CALL_KINDS,
  LLM_CALL_STATUSES,
  LLM_TRIGGERS,
  SESSION_KIND_NAMES,
} from '@keith/contracts'
import { sql } from 'drizzle-orm'
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The list of an SQL `IN (...)` check, quoted from the contract's values. */
const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ')

/**
 * One session. `id` is the session id (the source of truth, never changed); `kind` is computed once at its first call from the
 * registry (`session-kinds.ts`). `calls`, `cost_micro`, `first_at`, `last_at`, `primary_model` and `primary_provider` are totals of its
 * calls (the primary is the model with the most calls). `bodies_off` is 1 when the session holds no body.
 */
export const llmSessions = sqliteTable(
  'llm_sessions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    personId: text('person_id'),
    roomId: text('room_id'),
    app: text('app').notNull(),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
    calls: integer('calls').notNull().default(0),
    costMicro: integer('cost_micro').notNull().default(0),
    primaryModel: text('primary_model'),
    primaryProvider: text('primary_provider'),
    bodiesOff: integer('bodies_off').notNull().default(0),
  },
  (t) => [
    index('llm_sessions_person_last').on(t.personId, t.lastAt),
    index('llm_sessions_room_last').on(t.roomId, t.lastAt),
    index('llm_sessions_last').on(t.lastAt),
    check('llm_sessions_kind_known', sql`${t.kind} IN (${sql.raw(inList(SESSION_KIND_NAMES))})`),
    check('llm_sessions_cost_nonneg', sql`${t.costMicro} >= 0`),
    check('llm_sessions_calls_nonneg', sql`${t.calls} >= 0`),
  ],
)

/**
 * One provider call. `call_kind` is eharness `ModelCallKind` plus `embedding` (reserved). `trigger` is the turn kind that made the
 * call, NULL when it has no turn. `cost_micro` is NULL when the model has no price. `request_bytes` and `response_bytes` are the sizes
 * before gzip. `body_state` says what is kept of the bodies (`llm_bodies`).
 */
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    callKind: text('call_kind').notNull(),
    trigger: text('trigger'),
    turnId: text('turn_id'),
    stepIndex: integer('step_index'),
    messageId: text('message_id'),
    startedAt: integer('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    firstChunkMs: integer('first_chunk_ms'),
    status: text('status').notNull(),
    finishReason: text('finish_reason'),
    modelId: text('model_id').notNull(),
    provider: text('provider').notNull(),
    upstreamProvider: text('upstream_provider'),
    tokensIn: integer('tokens_in').notNull(),
    tokensOut: integer('tokens_out').notNull(),
    cacheRead: integer('cache_read'),
    cacheWrite: integer('cache_write'),
    reasoning: integer('reasoning'),
    costMicro: integer('cost_micro'),
    costSource: text('cost_source'),
    fallbacks: text('fallbacks'),
    errorName: text('error_name'),
    errorMessage: text('error_message'),
    requestBytes: integer('request_bytes').notNull(),
    responseBytes: integer('response_bytes').notNull(),
    bodyState: text('body_state').notNull(),
    speakerId: text('speaker_id'),
  },
  (t) => [
    index('llm_calls_session_started').on(t.sessionId, t.startedAt),
    index('llm_calls_started').on(t.startedAt),
    check('llm_calls_call_kind_known', sql`${t.callKind} IN (${sql.raw(inList(LLM_CALL_KINDS))})`),
    check(
      'llm_calls_trigger_known',
      sql`${t.trigger} IS NULL OR ${t.trigger} IN (${sql.raw(inList(LLM_TRIGGERS))})`,
    ),
    check('llm_calls_status_known', sql`${t.status} IN (${sql.raw(inList(LLM_CALL_STATUSES))})`),
    check(
      'llm_calls_body_state_known',
      sql`${t.bodyState} IN (${sql.raw(inList(LLM_BODY_STATES))})`,
    ),
    check(
      'llm_calls_cost_source_known',
      sql`${t.costSource} IS NULL OR ${t.costSource} IN ('provider', 'estimate')`,
    ),
    check('llm_calls_cost_nonneg', sql`${t.costMicro} IS NULL OR ${t.costMicro} >= 0`),
  ],
)

/**
 * The bodies of one call, each a gzip blob of the redacted JSON (`Bun.gzipSync`). A column is NULL when that part was not kept.
 * Retention deletes the row and sets the call's `body_state` to `purged`; the figures stay in `llm_calls`.
 */
export const llmBodies = sqliteTable('llm_bodies', {
  callId: text('call_id').primaryKey(),
  request: blob('request', { mode: 'buffer' }),
  response: blob('response', { mode: 'buffer' }),
  output: blob('output', { mode: 'buffer' }),
})
