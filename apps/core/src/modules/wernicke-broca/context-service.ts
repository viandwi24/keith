// The context reset and manual compaction of a person's front session (docs/specs/chat-context.md, ADR-0030 §3 to §6, §9).
// `newContext` starts the next generation: refusals, the memory flush, a re-check, the bump of the stored generation, the
// activity record on the old session and one audit row. `compact` shortens the current generation with the same flush.
// `generations` and `history` read the caller's own chain. The caller is the session's person; no method takes another
// person's id, so no call can reach another person's context (ADR-0020 §2).
import {
  CHAT_CONTEXT_CHANGED,
  CHAT_CONTEXT_COMPACT,
  CHAT_CONTEXT_NEW,
  CHAT_CONTEXT_PENDING,
  CHAT_HISTORY_LIMIT_MAX,
  type ChatCompactInput,
  type ChatCompactOutput,
  type ChatContextRefusalReason,
  type ChatGeneration,
  type ChatHistoryInput,
  type ChatHistoryMessage,
  type ChatNewContextOutput,
} from '@keith/contracts'
import type { AuditVia, TasksRepo } from '@keith/db'
import type {
  FlushPayload,
  HarnessAgent,
  HarnessMetadata,
  HarnessUIMessage,
  InboxAdapter,
  NoticePayload,
  SessionFlushResult,
  SessionLock,
} from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { frontSessionId, frontSessionOptions, personOfSession } from '../../platform/sessions.ts'
import type { Audit } from '../audit/index.ts'
import { emit } from '../brain-events/index.ts'
import type { FrontGenerations } from './generations.ts'

/** Messages of a generation the history read returns when the caller names no limit. */
export const CHAT_HISTORY_DEFAULT_LIMIT = 50

/** The caller of a context call: the person (the session's principal) and the listener of the call. */
export interface ChatCaller {
  by: string
  via: AuditVia
}

export type ChatContextErrorCode = 'CONFLICT' | 'NOT_FOUND'

/** A refusal of the context service. `code` is the RPC code; `reason` names a CONFLICT refusal (`data.reason`). */
export class ChatContextError extends Error {
  constructor(
    readonly code: ChatContextErrorCode,
    message: string,
    readonly reason?: ChatContextRefusalReason,
  ) {
    super(message)
    this.name = 'ChatContextError'
  }
}

export interface ContextServiceDeps {
  /** The lead agent (read lazily: it is built after the workers). */
  lead: () => HarnessAgent
  /** The shared session lock; every session of a context is opened with it (`frontSessionOptions`). */
  lock: SessionLock
  /** The sqlite inbox of the agents (the same instance as `storage.inbox`): its counts decide `task-running`. */
  inbox: Pick<InboxAdapter, 'stats'>
  /** The tasks of the core: a queued, running or waiting worker of a session refuses a reset. */
  tasks: Pick<TasksRepo, 'list'>
  /** The stored current generation of each person (`generations.ts`). */
  generations: FrontGenerations
  audit: Pick<Audit, 'record'>
  /** The activity feed: `chat.context.changed` is written on the old session id. */
  store: ActivityStore
  now?: () => number
  warn?: (message: string) => void
}

export interface ContextService {
  /** `/new`: starts the next generation of the caller's front session (ADR-0030 §3). */
  newContext(caller: ChatCaller, input: { flush: boolean }): Promise<ChatNewContextOutput>
  /** `/compact`: shortens the caller's current generation with the flush; the generation does not change (ADR-0030 §4). */
  compact(caller: ChatCaller, input: ChatCompactInput): Promise<ChatCompactOutput>
  /** The caller's generations, oldest first (ADR-0030 §6). */
  generations(caller: ChatCaller): Promise<ChatGeneration[]>
  /** The messages of one generation of the caller's chain, as the person reads them (ADR-0030 §6). */
  history(caller: ChatCaller, input: ChatHistoryInput): Promise<ChatHistoryMessage[]>
}

/** The outcome of the flush of one compaction: saved, not run (nothing to flush), or failed (refuses the reset). */
type FlushOutcome = 'flushed' | 'skipped'

/** The flush record read after a compaction: saved, failed (`error`), or none (the flush did not run). */
type FlushRecord = 'saved' | 'failed' | 'none'

const kindOf = (message: HarnessUIMessage): string | undefined =>
  (message.metadata as HarnessMetadata | undefined)?.eharness?.kind

/** The data of the one `data-<kind>` part of a kind message, if it has one. */
function dataOf<T>(message: HarnessUIMessage, type: string): T | undefined {
  const part = message.parts.find((p) => p.type === type) as { data?: unknown } | undefined
  return part?.data as T | undefined
}

/**
 * A manual compaction marker: the `eh.compaction` message a `/compact` run leaves in the transcript of its generation
 * (eharness writes `trigger: 'manual'` for the API compaction; automatic ones are `auto` or `turn`).
 */
const isManualCompaction = (message: HarnessUIMessage): boolean =>
  kindOf(message) === 'eh.compaction' &&
  dataOf<{ trigger?: unknown }>(message, 'data-eh.compaction')?.trigger === 'manual'

/**
 * A refusal of eharness for a manual compaction whose flush did not save (spec 06 §5.2a rule 9a, spec 10 `EH_COMPACTION_FAILED`):
 * the compaction did not run, so nothing was summarised. A summarizer failure has another `details.reason` and is not this.
 */
const isFlushRefusal = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { code, details } = error as { code?: unknown; details?: unknown }
  return (
    code === 'EH_COMPACTION_FAILED' &&
    (details as { reason?: unknown } | undefined)?.reason === 'flush'
  )
}

const createdAtOf = (message: HarnessUIMessage): number =>
  (message.metadata as HarnessMetadata | undefined)?.eharness?.createdAt ?? 0

/** A busy-session error of eharness (a turn of this session is live), as the service's `turn-running` refusal. */
const isBusyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'EH_SESSION_BUSY'

/** One history line of a stored message, or undefined when the person does not read it (kind messages, tool-only turns). */
function historyLineOf(message: HarnessUIMessage, seq: number): ChatHistoryMessage | undefined {
  const meta = (message.metadata as HarnessMetadata | undefined)?.eharness
  const at = meta?.createdAt ?? 0
  if (meta?.kind === 'eh.notice') {
    const notice = dataOf<NoticePayload>(message, 'data-eh.notice')
    return notice === undefined ? undefined : { seq, role: 'system', text: notice.message, at }
  }
  if (meta?.kind !== undefined) return undefined
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  // the trailing text parts a turn adds for the model (`augmented`) are not the person's words
  const texts = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []))
  const shown = texts.slice(0, Math.max(0, texts.length - (meta?.augmented ?? 0)))
  const text = shown.join('')
  return text === '' ? undefined : { seq, role: message.role, text, at }
}

export function createContextService(deps: ContextServiceDeps): ContextService {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? (() => undefined)

  const currentIdOf = (personId: string): string =>
    frontSessionId(personId, deps.generations.current(personId))
  const peekOf = (sessionId: string) => deps.lead().peek(sessionId)
  const openOf = (sessionId: string) =>
    deps.lead().session(sessionId, frontSessionOptions(sessionId, deps.lock))

  /** The refusal of the session now, in ADR-0030 §3 order; undefined when the reset may go on. */
  const refusalOf = async (sessionId: string): Promise<ChatContextRefusalReason | undefined> => {
    const peek = peekOf(sessionId)
    if ((await peek.busy()) !== null) return 'turn-running'
    const pending = await peek.pending()
    if (
      pending !== null &&
      (pending.approvals.length > 0 ||
        pending.clientTools.length > 0 ||
        (pending.externals?.length ?? 0) > 0)
    )
      return 'approval-pending'
    if (deps.tasks.list({ parentSessionId: sessionId, active: true, limit: 1 }).length > 0)
      return 'task-running'
    const stats = deps.inbox.stats
    if (stats === undefined) throw new Error('the inbox of the agents cannot count its items')
    const counts = await stats.call(deps.inbox, { sessionId })
    if (counts.ready + counts.claimed + counts.delayed > 0) return 'task-running'
    return undefined
  }

  const refuse = (reason: ChatContextRefusalReason): ChatContextError =>
    new ChatContextError('CONFLICT', refusalText(reason), reason)

  /** The id of the last stored message, read before a compaction: the flush record is newer than it. */
  const lastIdOf = async (sessionId: string): Promise<string | undefined> =>
    (await peekOf(sessionId).messages({ includeHidden: true, limit: 1 }))[0]?.id

  /**
   * The flush record written after `after`: a record without `error` is saved, one with `error` failed. No record means
   * the flush did not run: eharness skips it when there is nothing to drop or no gain (spec 06 §4, §5.2a), or it has no
   * hook, a window too small or a used-up budget. Nothing was lost then, so it is not a failure (ADR-0030 §3).
   */
  const flushRecordAfter = async (sessionId: string, after: string): Promise<FlushRecord> => {
    const stored = await peekOf(sessionId).messages({ includeHidden: true, limit: 200 })
    const records = stored.filter((m) => m.id > after && kindOf(m) === 'eh.flush')
    const last = records[records.length - 1]
    if (last === undefined) return 'none'
    return dataOf<FlushPayload>(last, 'data-eh.flush')?.error === undefined ? 'saved' : 'failed'
  }

  /**
   * The memory flush of the old session: one `session.flush()` under the session lock (eharness 0.14.0, spec 06 §5.2a
   * rule 11). It runs the same `compaction.before` hooks as a manual compaction but writes no summary, so a reset costs
   * the flush call only. An empty session has nothing to save and runs no call. A failed flush, one the flush model's
   * window could not hold, or one the session's closing aborted is the refusal `flush-failed` and changes nothing. A
   * flush that did not run (no hook, nothing to flush, a used-up budget) is not a refusal (`skipped`, `flushed: false`).
   */
  const flushOf = async (sessionId: string): Promise<FlushOutcome> => {
    if ((await lastIdOf(sessionId)) === undefined) return 'skipped'
    let result: SessionFlushResult
    try {
      result = await openOf(sessionId).flush()
    } catch (error) {
      if (isBusyError(error)) throw refuse('turn-running')
      warn(`chat: the flush of ${sessionId} failed: ${errorText(error)}`)
      throw refuse('flush-failed')
    }
    if (result.status === 'flushed') return 'flushed'
    if (result.status === 'failed') {
      warn(`chat: the flush of ${sessionId} failed: ${result.error}`)
      throw refuse('flush-failed')
    }
    if (result.reason === 'window' || result.reason === 'aborted') {
      warn(`chat: the flush of ${sessionId} did not run: ${result.reason}`)
      throw refuse('flush-failed')
    }
    return 'skipped'
  }

  /**
   * The pending record of a context change, on the person's session id (so only that person's feeds get it, activity-filter.ts):
   * `start` before the flush or the compaction runs, `end` after it (`ok` says whether the change went through).
   */
  const pendingOf = (
    sessionId: string,
    kind: 'new' | 'compact',
    state: 'start' | 'end',
    ok?: boolean,
  ): void =>
    emit(
      deps.store,
      CHAT_CONTEXT_PENDING,
      sessionId,
      null,
      ok === undefined ? { kind, state } : { kind, state, ok },
      warn,
    )

  const auditContext = (
    caller: ChatCaller,
    kind: typeof CHAT_CONTEXT_NEW | typeof CHAT_CONTEXT_COMPACT,
    generation: number,
    flushed: boolean,
  ): void =>
    deps.audit.record({
      kind,
      actor: caller.by,
      via: caller.via,
      detail: { subject: caller.by, generation, flushed },
    })

  return {
    async newContext(caller, input) {
      const personId = caller.by
      const old = currentIdOf(personId)
      const first = await refusalOf(old)
      if (first !== undefined) throw refuse(first)
      pendingOf(old, 'new', 'start')
      let ok = false
      try {
        let flushed = false
        if (input.flush) {
          flushed = (await flushOf(old)) === 'flushed'
          // a message may have been queued during the flush: the same three checks again
          const again = await refusalOf(old)
          if (again !== undefined) throw refuse(again)
        }
        const generation = deps.generations.bump(personId, now())
        emit(deps.store, CHAT_CONTEXT_CHANGED, old, null, { generation }, warn)
        auditContext(caller, CHAT_CONTEXT_NEW, generation, flushed)
        ok = true
        return { generation, flushed }
      } finally {
        pendingOf(old, 'new', 'end', ok)
      }
    },

    async compact(caller, input) {
      const personId = caller.by
      const sessionId = currentIdOf(personId)
      if ((await peekOf(sessionId).busy()) !== null) throw refuse('turn-running')
      const before = await lastIdOf(sessionId)
      const options = input.keepLast === undefined ? {} : { keepLast: input.keepLast }
      pendingOf(sessionId, 'compact', 'start')
      let ok = false
      try {
        await openOf(sessionId).compact(options)
        ok = true
      } catch (error) {
        if (isBusyError(error)) throw refuse('turn-running')
        // the flush did not save, so eharness wrote no summary and no marker: nothing was compacted
        if (isFlushRefusal(error)) {
          warn(`chat: the compaction of ${sessionId} was not run: ${errorText(error)}`)
          throw refuse('flush-failed')
        }
        throw error
      } finally {
        pendingOf(sessionId, 'compact', 'end', ok)
      }
      // the compaction ran: a flush that did not run (no hook, nothing to drop) is reported as flushed false, not refused
      const flushed =
        before !== undefined && (await flushRecordAfter(sessionId, before)) === 'saved'
      const generation = deps.generations.current(personId)
      auditContext(caller, CHAT_CONTEXT_COMPACT, generation, flushed)
      return { generation, flushed }
    },

    async generations(caller) {
      const personId = caller.by
      const current = deps.generations.current(personId)
      const out: ChatGeneration[] = []
      for (let generation = 0; generation <= current; generation++) {
        const stored = await peekOf(frontSessionId(personId, generation)).messages({
          includeHidden: true,
          limit: Number.MAX_SAFE_INTEGER,
        })
        const first = stored[0]
        out.push({
          generation,
          startedAt: first === undefined ? 0 : createdAtOf(first),
          messages: stored.filter((m) => kindOf(m) === undefined).length,
          compactions: stored.filter(isManualCompaction).length,
        })
      }
      return out
    },

    async history(caller, input) {
      const personId = caller.by
      // only a generation of the caller's own chain exists for them; anything else is not found
      if (input.generation > deps.generations.current(personId))
        throw new ChatContextError('NOT_FOUND', 'there is no such context')
      const sessionId = frontSessionId(personId, input.generation)
      if (personOfSession(sessionId) !== personId)
        throw new ChatContextError('NOT_FOUND', 'there is no such context')
      const limit = Math.min(input.limit ?? CHAT_HISTORY_DEFAULT_LIMIT, CHAT_HISTORY_LIMIT_MAX)
      const stored = await peekOf(sessionId).messages({ limit })
      const lines: ChatHistoryMessage[] = []
      for (const message of stored) {
        const line = historyLineOf(message, lines.length + 1)
        if (line !== undefined) lines.push(line)
      }
      return lines
    },
  }
}

/** The text a refusal shows, as the TUI says it (chat-context.md "TUI"). */
export function refusalText(reason: ChatContextRefusalReason): string {
  switch (reason) {
    case 'turn-running':
      return 'a turn is running'
    case 'approval-pending':
      return 'an approval is waiting'
    case 'task-running':
      return 'a task is still running'
    case 'flush-failed':
      return 'Could not save to memory, so nothing was changed. Try /new again later, or /new --no-flush to start fresh without saving.'
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
