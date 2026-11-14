// The activity logs RPC area `logs` (docs/specs/activity-logs.md "RPC", ADR-0032 §9). Every procedure asks the rights
// (`createLogRights`) before it returns a session or a call: a member sees their own sessions and the room sessions of the
// rooms they are in; the owner's reads of another person go through the audited owner path. A list carries figures only;
// a detail carries the messages sent; raw JSON is its own call, cut to MAX_RAW_WIRE_BYTES. A session the reader may not see
// answers NOT_FOUND, the same as a missing one.

import {
  type Capability,
  type LlmCallRecord,
  type LlmSessionRecord,
  LOGS_GENERATIONS_MAX,
  LOGS_MESSAGES_MAX,
  LOGS_PURGE,
  LOGS_SETTINGS,
  type LogMessage,
  type LogsCallOutput,
  type LogsSettings,
  type LogToolCall,
  MAX_RAW_WIRE_BYTES,
  type PersonStatus,
} from '@keith/contracts'
import type { ActivityBodies, ActivityLogsRepo, ActivitySessionFilter } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../../platform/rpc.ts'
import { unpack } from './pack.ts'
import type { AuditedLogsReader, LogRights, LogsSession } from './rights.ts'
import type { ActivityLogSettings } from './settings.ts'

export interface ActivityLogsProcedureDeps {
  repo: ActivityLogsRepo
  rights: LogRights
  settings: Pick<ActivityLogSettings, 'get' | 'set'>
  /** The writer's queue: the events waiting and the events overflow dropped (owner only in `logs.status`). */
  queue: { readonly size: number; readonly dropped: number }
  /** The person's status; undefined when there is no such person. Synchronous: the rights and the lookups use it per row. */
  statusOf: (personId: string) => PersonStatus | undefined
  /** The rooms the person is an active member of: their room sessions are readable through them. */
  roomIdsOf: (personId: string) => string[]
}

const notFound = (message: string) => new ORPCError('NOT_FOUND', { message })

/** The reader of a request: who asks, and whether the owner's capability (`logs.read`) is held. */
function readerOf(context: RpcContext): AuditedLogsReader {
  return {
    personId: context.principal.personId,
    isOwner: context.capabilities.has('logs.read'),
    capabilities: context.capabilities as ReadonlySet<Capability>,
    via: context.via,
  }
}

const asLogsSession = (s: LlmSessionRecord): LogsSession => ({
  id: s.id,
  kind: s.kind,
  personId: s.personId ?? undefined,
  roomId: s.roomId ?? undefined,
})

/** Cuts a text to the bytes left of a wire budget. `cut` is true when it did not fit. */
function take(text: string, budget: { left: number }): { text: string; cut: boolean } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= budget.left) {
    budget.left -= bytes
    return { text, cut: false }
  }
  const kept = Buffer.from(text).subarray(0, budget.left).toString('utf8')
  budget.left = 0
  return { text: kept, cut: true }
}

/** A stored blob read back; undefined when it is missing or unreadable (a corrupt blob shows no content, it does not fail the call). */
function readBlob(bytes: Uint8Array | null | undefined): unknown {
  if (bytes === null || bytes === undefined) return undefined
  try {
    return unpack(bytes as Uint8Array<ArrayBuffer>)
  } catch {
    return undefined
  }
}

/** The text of one prompt message: its text parts, and a short line for each other part (binary parts are placeholders). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: unknown) => {
      const p = (part ?? {}) as Record<string, unknown>
      if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') return p.text
      if (p.type === 'tool-call')
        return `[tool call ${String(p.toolName)} ${JSON.stringify(p.input)}]`
      if (p.type === 'tool-result')
        return `[tool result ${String(p.toolName)} ${JSON.stringify(p.output)}]`
      return `[${typeof p.type === 'string' ? p.type : 'part'}]`
    })
    .join('\n')
}

/** The detail of one call from its stored bodies. A call without bodies (off, purged) has figures and no messages. */
function callDetail(repo: ActivityLogsRepo, call: LlmCallRecord): LogsCallOutput {
  const budget = { left: MAX_RAW_WIRE_BYTES }
  let truncated = call.bodyState === 'truncated'
  const bodies: ActivityBodies | undefined = repo.getBodies(call.id)
  if (bodies === undefined)
    return { call, messages: [], toolCalls: [], outputText: '', reasoning: '', truncated }

  const request = readBlob(bodies.request) as { options?: { prompt?: unknown } } | undefined
  const prompt = Array.isArray(request?.options?.prompt) ? request.options.prompt : []
  const messages: LogMessage[] = []
  for (const message of prompt.slice(0, LOGS_MESSAGES_MAX)) {
    const m = (message ?? {}) as { role?: unknown; content?: unknown }
    const text = take(textOf(m.content), budget)
    if (text.cut) truncated = true
    messages.push({
      role: typeof m.role === 'string' ? m.role.slice(0, 20) : 'unknown',
      text: text.text,
    })
  }
  if (prompt.length > LOGS_MESSAGES_MAX) truncated = true

  const output = (readBlob(bodies.output) ?? {}) as {
    text?: unknown
    reasoning?: unknown
    toolCalls?: unknown
  }
  const toolCalls: LogToolCall[] = []
  for (const tc of Array.isArray(output.toolCalls) ? output.toolCalls : []) {
    const c = (tc ?? {}) as { toolCallId?: unknown; toolName?: unknown; input?: unknown }
    const input = take(JSON.stringify(c.input) ?? '', budget)
    if (input.cut) truncated = true
    toolCalls.push({
      toolCallId: String(c.toolCallId ?? '').slice(0, 100),
      toolName: String(c.toolName ?? '').slice(0, 200),
      input: input.text,
    })
  }
  const outputText = take(typeof output.text === 'string' ? output.text : '', budget)
  const reasoning = take(typeof output.reasoning === 'string' ? output.reasoning : '', budget)
  if (outputText.cut || reasoning.cut) truncated = true
  return {
    call,
    messages,
    toolCalls,
    outputText: outputText.text,
    reasoning: reasoning.text,
    truncated,
  }
}

/** A stored blob as JSON text for the wire, cut to MAX_RAW_WIRE_BYTES. `null` when the part is not kept. */
function wireJson(bytes: Uint8Array | null | undefined): { text: string | null; cut: boolean } {
  const value = readBlob(bytes)
  if (value === undefined) return { text: null, cut: false }
  const taken = take(JSON.stringify(value, null, 2) ?? 'null', { left: MAX_RAW_WIRE_BYTES })
  return { text: taken.text, cut: taken.cut }
}

export function activityLogsProcedures(deps: ActivityLogsProcedureDeps) {
  /**
   * A procedure that names a person: the caller's own id is always allowed; another existing person is FORBIDDEN for a member
   * and allowed for the owner; a person that does not exist is NOT_FOUND for everyone.
   */
  const checkPerson = (context: RpcContext, person: string): void => {
    if (person === context.principal.personId) return
    if (deps.statusOf(person) === undefined) throw notFound('no such person')
    if (!context.capabilities.has('logs.read'))
      throw new ORPCError('FORBIDDEN', { message: "only the owner reads another person's logs" })
  }

  /** The session of an id the reader may see, with the rights decision for `purpose`; NOT_FOUND otherwise. */
  const visibleSession = (
    context: RpcContext,
    session: LlmSessionRecord | undefined,
    purpose: 'detail' | 'raw',
    callId?: string,
  ): LlmSessionRecord => {
    if (session === undefined) throw notFound('no such session')
    const access = deps.rights.authorize(readerOf(context), asLogsSession(session), {
      purpose,
      callId,
    })
    if (access === 'deny') throw notFound('no such session')
    return session
  }

  return {
    status: rpc.logs.status.handler(({ context }) => {
      if (context.capabilities.has('logs.read')) {
        const all = deps.repo.status()
        return {
          queued: deps.queue.size,
          dropped: deps.queue.dropped,
          sessions: all.sessions,
          calls: all.calls,
          bodyBytes: all.bodyBytes,
        }
      }
      // a member sees the figures of their own logs; the writer's queue is the instance's, so it reads as nothing here
      const own = deps.repo.statusOf(context.principal.personId)
      return {
        queued: 0,
        dropped: 0,
        sessions: own.sessions,
        calls: own.calls,
        bodyBytes: own.bodyBytes,
      }
    }),

    settings: {
      get: rpc.logs.settings.get.handler(() => deps.settings.get()),
      set: rpc.logs.settings.set.handler(({ input, context }) => {
        const before = deps.settings.get()
        let after: LogsSettings
        try {
          after = deps.settings.set(input)
        } catch (error) {
          throw new ORPCError('BAD_REQUEST', {
            message: error instanceof Error ? error.message : 'bad logs setting',
          })
        }
        // the names of the fields that changed, never a value (ADR-0032 §8)
        const changed = (Object.keys(input) as Array<keyof LogsSettings>).filter(
          (key) => before[key] !== after[key],
        )
        if (changed.length > 0) context.record(LOGS_SETTINGS, { changed })
        return after
      }),
    },

    sessions: rpc.logs.sessions.handler(({ input, context }) => {
      const reader = readerOf(context)
      const self = context.principal.personId
      const everyone = reader.isOwner && input.person === 'everyone'
      if (!everyone && input.person !== undefined && input.person !== self)
        checkPerson(context, input.person)

      const filter: ActivitySessionFilter = {
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.q === undefined ? {} : { q: input.q }),
      }
      if (everyone) {
        // every person's sessions: the owner's list, authorized per person below
      } else if (input.person !== undefined && input.person !== self) {
        filter.personId = input.person
      } else {
        filter.visibleTo = { personId: self, roomIds: deps.roomIdsOf(self) }
      }

      const page = deps.repo.listSessions(filter, { limit: input.limit, cursor: input.cursor })
      // one rights decision per person (a room or guest session: per session); a denied row never leaves
      const decided = new Map<string, boolean>()
      const sessions = page.sessions.filter((s) => {
        const key = s.personId === null ? `session:${s.id}` : `person:${s.personId}`
        let allowed = decided.get(key)
        if (allowed === undefined) {
          allowed = deps.rights.authorize(reader, asLogsSession(s), { purpose: 'list' }) !== 'deny'
          decided.set(key, allowed)
        }
        return allowed
      })
      return { sessions, nextCursor: page.nextCursor }
    }),

    session: rpc.logs.session.handler(({ input, context }) => {
      const session = visibleSession(context, deps.repo.getSession(input.id), 'detail')
      const generations = deps.repo.listCalls(session.id, LOGS_GENERATIONS_MAX)
      return {
        session,
        generations,
        // the session's own count, so a session with more calls than the page says so
        more: session.calls > generations.length,
      }
    }),

    call: rpc.logs.call.handler(({ input, context }) => {
      const call = deps.repo.getCall(input.id)
      if (call === undefined) throw notFound('no such call')
      visibleSession(context, deps.repo.getSession(call.sessionId), 'detail', call.id)
      return callDetail(deps.repo, call)
    }),

    raw: rpc.logs.raw.handler(({ input, context }) => {
      const call = deps.repo.getCall(input.callId)
      if (call === undefined) throw notFound('no such call')
      visibleSession(context, deps.repo.getSession(call.sessionId), 'raw', call.id)
      const bodies = deps.repo.getBodies(call.id)
      const request = wireJson(bodies?.request)
      const response = wireJson(bodies?.response)
      return {
        callId: call.id,
        bodyState: call.bodyState,
        request: request.text,
        response: response.text,
        truncated: call.bodyState === 'truncated' || request.cut || response.cut,
      }
    }),

    purge: rpc.logs.purge.handler(({ input, context }) => {
      const target = input.person ?? context.principal.personId
      if (target !== context.principal.personId) checkPerson(context, target)
      const removed =
        input.mode === 'all'
          ? deps.repo.purgePerson(target)
          : { ...deps.repo.purgeBodiesOf(target), calls: 0, sessions: 0 }
      const counts = { bodies: removed.bodies, calls: removed.calls, sessions: removed.sessions }
      context.record(LOGS_PURGE, { subject: target, mode: input.mode, ...counts })
      return counts
    }),
  }
}
