// The context reset and manual compaction of a person's front session (docs/specs/chat-context.md, ADR-0030). Re-exported by
// area-runtime.ts. The RPC input and output schemas, the refusal reasons, the audit kinds and the activity record. The
// procedures are declared in contract.ts under `chat`. Every call is `chat`: the caller's own session, no step-up (ADR-0030 §8).
import { z } from 'zod'

/** `chat.history` returns at most this many messages in one call. */
export const CHAT_HISTORY_LIMIT_MAX = 200

/** The refusals of a reset or a compaction (ADR-0030 §3). Each leaves as a `CONFLICT` with `data.reason`. */
export const CHAT_CONTEXT_REFUSAL_REASONS = [
  'turn-running',
  'approval-pending',
  'task-running',
  'flush-failed',
] as const
export const ChatContextRefusalReasonSchema = z.enum(CHAT_CONTEXT_REFUSAL_REASONS)
export type ChatContextRefusalReason = z.infer<typeof ChatContextRefusalReasonSchema>

/** The `data` of a `CONFLICT` refusal: the reason, nothing else (no text, no session id). */
export const ChatContextRefusalDataSchema = z.object({
  reason: ChatContextRefusalReasonSchema,
})
export type ChatContextRefusalData = z.infer<typeof ChatContextRefusalDataSchema>

/** A generation of a person's front session: 0 is the first one (`front:<personId>`), `n` is `front:<personId>:g<n>`. */
export const ChatGenerationNumberSchema = z.number().int().min(0)
export type ChatGenerationNumber = z.infer<typeof ChatGenerationNumberSchema>

/** `chat.newContext`: `flush` (default true) saves the lasting facts of the old context before the switch. */
export const ChatNewContextInputSchema = z.object({
  flush: z.boolean().default(true),
})
export type ChatNewContextInput = z.input<typeof ChatNewContextInputSchema>

/** The result of a reset: the generation now current, and whether the flush ran. */
export const ChatNewContextOutputSchema = z.object({
  generation: ChatGenerationNumberSchema,
  flushed: z.boolean(),
})
export type ChatNewContextOutput = z.infer<typeof ChatNewContextOutputSchema>

/** `chat.compact`: `keepLast` is the number of recent messages kept as they are (at least 1; the default is eharness's). */
export const ChatCompactInputSchema = z.object({
  keepLast: z.number().int().min(1).optional(),
})
export type ChatCompactInput = z.infer<typeof ChatCompactInputSchema>

/** The result of a compaction: the current generation (unchanged) and whether the flush ran. */
export const ChatCompactOutputSchema = z.object({
  generation: ChatGenerationNumberSchema,
  flushed: z.boolean(),
})
export type ChatCompactOutput = z.infer<typeof ChatCompactOutputSchema>

/**
 * One generation of the caller's chain: its number, when it started, how many messages it holds, and how many `/compact`
 * runs shortened it while it was current (the manual `eh.compaction` markers of its transcript; 0 when none).
 */
export const ChatGenerationSchema = z.object({
  generation: ChatGenerationNumberSchema,
  startedAt: z.number(),
  messages: z.number().int().min(0),
  compactions: z.number().int().min(0),
})
export type ChatGeneration = z.infer<typeof ChatGenerationSchema>

/** `chat.generations`: the caller's generations, oldest first. */
export const ChatGenerationsOutputSchema = z.array(ChatGenerationSchema)
export type ChatGenerationsOutput = z.infer<typeof ChatGenerationsOutputSchema>

/** `chat.history`: one old generation of the caller's own transcript, read as the caller's session. */
export const ChatHistoryInputSchema = z.object({
  generation: ChatGenerationNumberSchema,
  limit: z.number().int().min(1).max(CHAT_HISTORY_LIMIT_MAX).optional(),
})
export type ChatHistoryInput = z.input<typeof ChatHistoryInputSchema>

/**
 * One message of a transcript as the person reads it. `text` is the message text only: no tool payloads and no
 * model or cost fields. A notice of a failed turn is `system`.
 */
export const ChatHistoryMessageSchema = z.object({
  seq: z.number().int().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  at: z.number(),
})
export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>

export const ChatHistoryOutputSchema = z.array(ChatHistoryMessageSchema)
export type ChatHistoryOutput = z.infer<typeof ChatHistoryOutputSchema>

/** The audit kinds of a reset and a compaction (ADR-0030 §9). The row names the subject and the flag only. */
export const CHAT_CONTEXT_NEW = 'chat.context.new' as const
export const CHAT_CONTEXT_COMPACT = 'chat.context.compact' as const

/** Detail of `chat.context.new` and `chat.context.compact`: the subject person, the generation, and the flush flag. No text. */
export const ChatContextAuditDetailSchema = z.object({
  subject: z.string().min(1),
  generation: ChatGenerationNumberSchema,
  flushed: z.boolean(),
})
export type ChatContextAuditDetail = z.infer<typeof ChatContextAuditDetailSchema>

/** The activity-feed type of a reset: written on the old session id so every open client of the person switches. */
export const CHAT_CONTEXT_CHANGED = 'chat.context.changed' as const

/** Payload of `chat.context.changed`: the generation now current. It holds no text. */
export const ChatContextChangedRecordSchema = z.object({
  generation: z.number().int().min(1),
})
export type ChatContextChangedRecord = z.infer<typeof ChatContextChangedRecordSchema>

/**
 * The activity-feed type of a context change in progress: `start` before its memory flush or compaction runs, `end` after it
 * (in a `finally`, so a failed change also ends). Written on the person's current session id, so only that person's feeds get it.
 */
export const CHAT_CONTEXT_PENDING = 'chat.context.pending' as const

/** Payload of `chat.context.pending`: the kind of change, its state and, on `end`, whether it went through. It holds no text. */
export const ChatContextPendingRecordSchema = z.object({
  kind: z.enum(['new', 'compact']),
  state: z.enum(['start', 'end']),
  ok: z.boolean().optional(),
})
export type ChatContextPendingRecord = z.infer<typeof ChatContextPendingRecordSchema>
