// The context reset and manual compaction on the client (docs/specs/chat-context.md, docs/specs/client.md "Chat context").
// `chatContextApiOf` wraps the `rpc.chat.*` context procedures in one typed object, like `personaApiOf`: each method is the
// procedure of the same name. `watchChatContext` refetches the generations on each `chat.context.changed` record and on every
// feed resync, so an open client of the person switches to the current generation without a restart.
import {
  CHAT_CONTEXT_CHANGED,
  CHAT_CONTEXT_PENDING,
  type ChatCompactInput,
  type ChatCompactOutput,
  ChatContextChangedRecordSchema,
  type ChatContextPendingRecord,
  ChatContextPendingRecordSchema,
  type ChatContextRefusalReason,
  ChatContextRefusalReasonSchema,
  type ChatGenerationsOutput,
  type ChatHistoryInput,
  type ChatHistoryOutput,
  type ChatNewContextInput,
  type ChatNewContextOutput,
} from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** The context API of one client: each method is one `rpc.chat.*` procedure, typed by `@keith/contracts`. */
export interface ChatContextApi {
  newContext(input?: ChatNewContextInput): Promise<ChatNewContextOutput>
  compact(input?: ChatCompactInput): Promise<ChatCompactOutput>
  generations(): Promise<ChatGenerationsOutput>
  history(input: ChatHistoryInput): Promise<ChatHistoryOutput>
}

/**
 * How long a client waits for a reset or a compaction (`chat.newContext`, `chat.compact`): both run a memory flush and maybe a
 * summary, which a stalled provider can hold for a long time. Past it the client gives up waiting (the core may still finish).
 */
export const CONTEXT_DEADLINE_MS = 3 * 60_000

/** The client's deadline passed before the core answered (`ChatContextDeadlineError`); the call was aborted. */
export class ChatContextDeadlineError extends Error {
  constructor() {
    super('the core did not answer in time')
    this.name = 'ChatContextDeadlineError'
  }
}

export interface ChatContextApiOptions {
  /** The deadline of a reset and a compaction (default `CONTEXT_DEADLINE_MS`). */
  deadlineMs?: number
}

/**
 * Runs one call with a deadline: the call gets an abort signal (its request is cancelled when the transport honours it), and the
 * result is refused with `ChatContextDeadlineError` whether or not the transport did.
 */
function withDeadline<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ChatContextDeadlineError())
      controller.abort()
    }, ms)
  })
  return Promise.race([call(controller.signal), deadline]).finally(() => clearTimeout(timer))
}

/** The context API over a client's typed `rpc` (`client.chatContext` is this for the client it was created with). */
export function chatContextApiOf(
  client: Pick<KeithClient, 'rpc'>,
  options: ChatContextApiOptions = {},
): ChatContextApi {
  const { chat } = client.rpc
  const deadlineMs = options.deadlineMs ?? CONTEXT_DEADLINE_MS
  return {
    newContext: (input = {}) =>
      withDeadline(deadlineMs, (signal) => chat.newContext(input, { signal })),
    compact: (input = {}) => withDeadline(deadlineMs, (signal) => chat.compact(input, { signal })),
    generations: () => chat.generations(),
    history: (input) => chat.history(input),
  }
}

/**
 * The reason of a refused reset or compaction (`CONFLICT` with `data.reason`), or undefined for any other error. A reason the
 * contract does not know is undefined too.
 */
export function chatContextRefusalOf(error: unknown): ChatContextRefusalReason | undefined {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown }
  if (code !== 'CONFLICT' || typeof data !== 'object' || data === null) return undefined
  const parsed = ChatContextRefusalReasonSchema.safeParse((data as { reason?: unknown }).reason)
  return parsed.success ? parsed.data : undefined
}

/** The part of the activity feed the context watch uses (`client.feed()` satisfies it). */
export interface ChatContextFeed {
  subscribeEvents(fn: (record: { type: string; payload: unknown }) => void): () => void
  subscribeResync(fn: (reason: string) => void): () => void
}

/**
 * Calls `refetch` on each `chat.context.changed` record (a generation was started; the record holds no text) and on every feed
 * resync, since a change made while the feed was down is only read again by a refetch. Other records, and a record whose payload
 * does not match its schema, do nothing. Returns the detach function.
 */
export function watchChatContext(options: {
  feed: ChatContextFeed
  refetch: () => void
}): () => void {
  const offEvents = options.feed.subscribeEvents((record) => {
    if (record.type !== CHAT_CONTEXT_CHANGED) return
    if (!ChatContextChangedRecordSchema.safeParse(record.payload).success) return
    options.refetch()
  })
  const offResync = options.feed.subscribeResync(() => options.refetch())
  return () => {
    offEvents()
    offResync()
  }
}

/**
 * Calls `onRecord` with each well-formed `chat.context.pending` record (a `start` before a reset's flush or a compaction, an `end`
 * after it) and `onResync` on every feed resync: a record may have been missed while the feed was down, so the caller forgets
 * what it knows of a change in progress (the next record restores it). Other records, and a payload that does not match its
 * schema, do nothing. Returns the detach function.
 */
export function watchChatContextPending(options: {
  feed: ChatContextFeed
  onRecord(record: ChatContextPendingRecord): void
  onResync(): void
}): () => void {
  const offEvents = options.feed.subscribeEvents((record) => {
    if (record.type !== CHAT_CONTEXT_PENDING) return
    const parsed = ChatContextPendingRecordSchema.safeParse(record.payload)
    if (parsed.success) options.onRecord(parsed.data)
  })
  const offResync = options.feed.subscribeResync(() => options.onResync())
  return () => {
    offEvents()
    offResync()
  }
}
