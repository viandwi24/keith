// The activity logs (ADR-0032, docs/specs/activity-logs.md): the record of every model call, per session, the RPC area `logs`, the
// settings and their bounds, the audit details. Strict: an unknown field is refused. A list never carries content; a detail carries
// the messages sent; raw JSON is a separate call and is cut to MAX_RAW_WIRE_BYTES on the wire. Re-exported by area-runtime.ts.
import { z } from 'zod'
import { SESSION_KIND_NAMES } from './session-kinds.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Closed sets

/** The kind of a provider call (eharness `ModelCallKind`), plus `embedding`, reserved: nothing writes it yet (ADR-0032 §1). */
export const LLM_CALL_KINDS = ['step', 'compaction', 'flush', 'other', 'embedding'] as const
export const LlmCallKindSchema = z.enum(LLM_CALL_KINDS)
export type LlmCallKind = z.infer<typeof LlmCallKindSchema>

/** The kind of a turn that made a call (eharness `TurnInfo.kind`). `null` for a call with no turn (a helper outside a session). */
export const LLM_TRIGGERS = ['send', 'respond', 'regenerate', 'edit', 'wake'] as const
export const LlmTriggerSchema = z.enum(LLM_TRIGGERS)
export type LlmTrigger = z.infer<typeof LlmTriggerSchema>

/** eharness `ModelCallRecord.status`. */
export const LLM_CALL_STATUSES = ['ok', 'error', 'aborted'] as const
export const LlmCallStatusSchema = z.enum(LLM_CALL_STATUSES)
export type LlmCallStatus = z.infer<typeof LlmCallStatusSchema>

/**
 * What is kept of a call's bodies: `stored` (gzip blobs present), `truncated` (stored, cut to `maxBodyBytes`), `purged` (kept
 * before, removed by retention or a purge; figures remain), `off` (capture of bodies is off for this call; figures only).
 */
export const LLM_BODY_STATES = ['stored', 'truncated', 'purged', 'off'] as const
export const LlmBodyStateSchema = z.enum(LLM_BODY_STATES)
export type LlmBodyState = z.infer<typeof LlmBodyStateSchema>

/** A session kind on the wire: the registry's names (`session-kinds.ts`). */
export const LlmSessionKindSchema = z.enum(SESSION_KIND_NAMES)
export type LlmSessionKind = z.infer<typeof LlmSessionKindSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** The most bytes of JSON one `logs.raw` answer carries per part (request, response). A longer body is cut and flagged. */
export const MAX_RAW_WIRE_BYTES = 256 * 1024
/** The most rows one `logs.sessions` page returns. */
export const LOGS_PAGE_MAX = 100
/** The most generations (calls) one `logs.session` answer lists. */
export const LOGS_GENERATIONS_MAX = 200
/** The most messages one `logs.call` answer lists. */
export const LOGS_MESSAGES_MAX = 500
/** The longest id a log row carries (a session id, a call id). */
export const LOGS_ID_MAX = 300

/** The bounds of the settings (ADR-0032 §6). `bodyRetentionDays` never exceeds `metaRetentionDays`. */
export const LOGS_SETTINGS_BOUNDS = {
  bodyRetentionDays: { min: 1, max: 90, default: 14 },
  metaRetentionDays: { min: 1, max: 3650, default: 365 },
  maxBodyBytes: { min: 16 * 1024, max: 4 * 1024 * 1024, default: 512 * 1024 },
} as const

// ---------------------------------------------------------------------------------------------------------------------
// Records

/** One provider call (the figures; no message text, no body). Cost is integer micro-dollars (1e-6 USD), null when unknown. */
export const LlmCallRecordSchema = z.strictObject({
  id: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(LOGS_ID_MAX),
  kind: LlmCallKindSchema,
  trigger: LlmTriggerSchema.nullable(),
  turnId: z.string().max(100).nullable(),
  stepIndex: z.number().int().min(0).nullable(),
  startedAt: z.number().int(),
  durationMs: z.number().int().min(0),
  firstChunkMs: z.number().int().min(0).nullable(),
  status: LlmCallStatusSchema,
  finishReason: z.string().max(40).nullable(),
  modelId: z.string().max(200),
  provider: z.string().max(100),
  upstreamProvider: z.string().max(100).nullable(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  cacheRead: z.number().int().min(0).nullable(),
  cacheWrite: z.number().int().min(0).nullable(),
  reasoning: z.number().int().min(0).nullable(),
  costMicro: z.number().int().min(0).nullable(),
  costSource: z.enum(['provider', 'estimate']).nullable(),
  /** A note when the provider that served the call differs from the one asked for; null otherwise. */
  fallbackNote: z.string().max(200).nullable(),
  errorName: z.string().max(100).nullable(),
  errorMessage: z.string().max(500).nullable(),
  requestBytes: z.number().int().min(0),
  responseBytes: z.number().int().min(0),
  bodyState: LlmBodyStateSchema,
  /** The person who spoke in a room turn (the session belongs to the room); null elsewhere. */
  speakerId: z.string().max(100).nullable(),
})
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>

/** One session: its kind, the person or room it belongs to, its time range and totals. */
export const LlmSessionRecordSchema = z.strictObject({
  id: z.string().min(1).max(LOGS_ID_MAX),
  kind: LlmSessionKindSchema,
  personId: z.string().max(100).nullable(),
  roomId: z.string().max(100).nullable(),
  /** The app name the kind is listed under (`Front`, `Worker`, `Room`, `Guest`, `Dreaming`, `Helper`). */
  app: z.string().max(40),
  firstAt: z.number().int(),
  lastAt: z.number().int(),
  calls: z.number().int().min(0),
  costMicro: z.number().int().min(0),
  primaryModel: z.string().max(200).nullable(),
  primaryProvider: z.string().max(100).nullable(),
})
export type LlmSessionRecord = z.infer<typeof LlmSessionRecordSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Filters and pages

/**
 * The filters of `logs.sessions`. A member lists their own sessions only (`person` must be the caller or absent); the owner
 * may name any `person` (an audited read). `q` matches the start of a session id. `cursor` is opaque: the last page's
 * `nextCursor`.
 */
export const LogsSessionsInputSchema = z
  .strictObject({
    kind: LlmSessionKindSchema.optional(),
    person: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(200).optional(),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    q: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(LOGS_PAGE_MAX).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .refine((f) => f.from === undefined || f.to === undefined || f.from <= f.to, {
    message: 'from is after to',
    path: ['from'],
  })
export type LogsSessionsInput = z.infer<typeof LogsSessionsInputSchema>

export const LogsSessionsOutputSchema = z.strictObject({
  sessions: z.array(LlmSessionRecordSchema),
  /** The cursor of the next page, or null when this is the last. */
  nextCursor: z.string().nullable(),
})
export type LogsSessionsOutput = z.infer<typeof LogsSessionsOutputSchema>

export const LogsSessionInputSchema = z.strictObject({ id: z.string().min(1).max(LOGS_ID_MAX) })

/** One session: its overview and its generations (calls, figures only, oldest first). */
export const LogsSessionOutputSchema = z.strictObject({
  session: LlmSessionRecordSchema,
  generations: z.array(LlmCallRecordSchema).max(LOGS_GENERATIONS_MAX),
  /** True when the session has more calls than `generations` lists. */
  more: z.boolean(),
})
export type LogsSessionOutput = z.infer<typeof LogsSessionOutputSchema>

export const LogsCallInputSchema = z.strictObject({ id: z.string().min(1).max(64) })

/** A message sent to the model, flattened to text (binary parts are placeholders). */
export const LogMessageSchema = z.strictObject({
  role: z.string().max(20),
  text: z.string(),
})
export type LogMessage = z.infer<typeof LogMessageSchema>

export const LogToolCallSchema = z.strictObject({
  toolCallId: z.string().max(100),
  toolName: z.string().max(200),
  /** The input as JSON text (cut to MAX_RAW_WIRE_BYTES). */
  input: z.string(),
})
export type LogToolCall = z.infer<typeof LogToolCallSchema>

/** One call in detail: the figures, the messages sent, the tool calls and the output. */
export const LogsCallOutputSchema = z.strictObject({
  call: LlmCallRecordSchema,
  messages: z.array(LogMessageSchema).max(LOGS_MESSAGES_MAX),
  toolCalls: z.array(LogToolCallSchema),
  /** The text the model produced (cut to MAX_RAW_WIRE_BYTES). */
  outputText: z.string(),
  /** The reasoning text the model produced (cut to MAX_RAW_WIRE_BYTES). */
  reasoning: z.string(),
  /** True when the body was cut (by capture or by the wire cap). */
  truncated: z.boolean(),
})
export type LogsCallOutput = z.infer<typeof LogsCallOutputSchema>

export const LogsRawInputSchema = z.strictObject({ callId: z.string().min(1).max(64) })

/** The raw request and response JSON of one call, each cut to MAX_RAW_WIRE_BYTES; null when the call has no stored body. */
export const LogsRawOutputSchema = z.strictObject({
  callId: z.string().min(1).max(64),
  bodyState: LlmBodyStateSchema,
  request: z.string().nullable(),
  response: z.string().nullable(),
  truncated: z.boolean(),
})
export type LogsRawOutput = z.infer<typeof LogsRawOutputSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Status and settings

/** The writer's state and the store's size. `dropped` counts events the bounded queue dropped (oldest first). */
export const LogsStatusSchema = z.strictObject({
  queued: z.number().int().min(0),
  dropped: z.number().int().min(0),
  sessions: z.number().int().min(0),
  calls: z.number().int().min(0),
  bodyBytes: z.number().int().min(0),
})
export type LogsStatus = z.infer<typeof LogsStatusSchema>

/** The settings fields without defaults: the change (`set`) takes only what is given, the full settings fill the defaults. */
const LOGS_SETTING_FIELDS = {
  captureBodies: z.boolean(),
  guestBodies: z.boolean(),
  bodyRetentionDays: z
    .number()
    .int()
    .min(LOGS_SETTINGS_BOUNDS.bodyRetentionDays.min)
    .max(LOGS_SETTINGS_BOUNDS.bodyRetentionDays.max),
  metaRetentionDays: z
    .number()
    .int()
    .min(LOGS_SETTINGS_BOUNDS.metaRetentionDays.min)
    .max(LOGS_SETTINGS_BOUNDS.metaRetentionDays.max),
  maxBodyBytes: z
    .number()
    .int()
    .min(LOGS_SETTINGS_BOUNDS.maxBodyBytes.min)
    .max(LOGS_SETTINGS_BOUNDS.maxBodyBytes.max),
}

const bodiesNoLongerThanFigures = (s: {
  bodyRetentionDays?: number | undefined
  metaRetentionDays?: number | undefined
}) =>
  s.bodyRetentionDays === undefined ||
  s.metaRetentionDays === undefined ||
  s.bodyRetentionDays <= s.metaRetentionDays
const BODIES_RULE = {
  message: 'bodies are kept no longer than the figures (bodyRetentionDays <= metaRetentionDays)',
}

/** The settings of the activity logs, all defaults filled (owner, instance-wide). */
export const LogsSettingsSchema = z
  .strictObject({
    captureBodies: LOGS_SETTING_FIELDS.captureBodies.default(true),
    guestBodies: LOGS_SETTING_FIELDS.guestBodies.default(false),
    bodyRetentionDays: LOGS_SETTING_FIELDS.bodyRetentionDays.default(
      LOGS_SETTINGS_BOUNDS.bodyRetentionDays.default,
    ),
    metaRetentionDays: LOGS_SETTING_FIELDS.metaRetentionDays.default(
      LOGS_SETTINGS_BOUNDS.metaRetentionDays.default,
    ),
    maxBodyBytes: LOGS_SETTING_FIELDS.maxBodyBytes.default(
      LOGS_SETTINGS_BOUNDS.maxBodyBytes.default,
    ),
  })
  .refine(bodiesNoLongerThanFigures, BODIES_RULE)
export type LogsSettings = z.infer<typeof LogsSettingsSchema>

/** A partial change: at least one field, the given fields only. */
export const LogsSettingsSetSchema = z
  .strictObject(LOGS_SETTING_FIELDS)
  .partial()
  .refine((s) => Object.keys(s).length > 0, { message: 'give at least one logs setting' })
  .refine(bodiesNoLongerThanFigures, BODIES_RULE)
export type LogsSettingsSet = z.infer<typeof LogsSettingsSetSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Purge

/**
 * `bodies`: remove the stored bodies, keep the figures. `all`: remove the sessions, calls and bodies. A member purges their own
 * logs only (no `person`); the owner may name a `person` (audited).
 */
export const LogsPurgeInputSchema = z.strictObject({
  mode: z.enum(['bodies', 'all']),
  person: z.string().min(1).max(100).optional(),
})
export type LogsPurgeInput = z.infer<typeof LogsPurgeInputSchema>

export const LogsPurgeOutputSchema = z.strictObject({
  bodies: z.number().int().min(0),
  calls: z.number().int().min(0),
  sessions: z.number().int().min(0),
})
export type LogsPurgeOutput = z.infer<typeof LogsPurgeOutputSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Audit (ADR-0032 §8): the subject and counts only. No text, no id of a call in a `logs.settings` row.

export const LOGS_OWNER_READ = 'logs.owner-read' as const
export const LOGS_PURGE = 'logs.purge' as const
export const LOGS_SETTINGS = 'logs.settings' as const

/**
 * `logs.owner-read`: the owner read a member's sessions (`list`), one session, one call or raw JSON. `subject` is the person
 * the read is about; it is absent for a guest session (no person) and a room with no active member. `room` names a room session.
 */
export const LogsOwnerReadAuditDetailSchema = z.strictObject({
  subject: z.string().min(1).optional(),
  room: z.string().min(1).max(100).optional(),
  scope: z.enum(['list', 'session', 'call', 'raw']),
  sessionId: z.string().max(LOGS_ID_MAX).optional(),
  callId: z.string().max(64).optional(),
  count: z.number().int().min(0).optional(),
})
export type LogsOwnerReadAuditDetail = z.infer<typeof LogsOwnerReadAuditDetailSchema>

/** `logs.purge`: what was removed, by mode and counts. */
export const LogsPurgeAuditDetailSchema = z.strictObject({
  subject: z.string().min(1),
  mode: z.enum(['bodies', 'all']),
  bodies: z.number().int().min(0),
  calls: z.number().int().min(0),
  sessions: z.number().int().min(0),
})
export type LogsPurgeAuditDetail = z.infer<typeof LogsPurgeAuditDetailSchema>

/** `logs.settings`: the names of the fields changed, never a value. */
export const LogsSettingsAuditDetailSchema = z.strictObject({
  changed: z.array(z.enum(Object.keys(LOGS_SETTING_FIELDS) as [string, ...string[]])),
})
export type LogsSettingsAuditDetail = z.infer<typeof LogsSettingsAuditDetailSchema>
