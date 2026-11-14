// The activity-log capture (ADR-0032 §1, §4, §5; docs/specs/activity-logs.md "Capture"). A `model.call` hook maps each
// ModelCallEvent to one call row and its session row, redacts and truncates its bodies, packs them, and enqueues the result.
// The hook is synchronous: it never awaits the store, never throws, and changes nothing about the call.
import {
  LLM_TRIGGERS,
  type LlmBodyState,
  type LlmCallKind,
  type LlmCallRecord,
  type LlmTrigger,
  type LogsSettings,
  type SessionKindName,
  sessionKindOf,
  sessionKindRow,
  sessionRefOf,
} from '@keith/contracts'
import type { ActivityCallInput, ActivitySessionInput } from '@keith/db'
import { definePlugin, type HarnessPlugin, type ModelCallEvent } from 'eharness'
import { pack } from './pack.ts'
import type { LogQueue } from './queue.ts'
import { redact, redactString } from './redact.ts'
import type { ActivityLogSettings } from './settings.ts'
import { truncateBody } from './truncate.ts'

/** One queued item: what `activity-logs` writes in one call (the repo's `insertCalls` input). */
export type CaptureRecord = ActivityCallInput

/** What the hook reads from its context: the principal and the kind of the running turn. */
export interface CaptureContext {
  principalId?: string | undefined
  /** `ctx.turn?.kind` at the hook. Undefined when no turn is running. */
  turnKind?: string | undefined
}

// Column limits of `llm_calls` and the contract (cut, never refused: a long provider string must not drop a row).
const TURN_ID_MAX = 100
const FINISH_MAX = 40
const MODEL_MAX = 200
const PROVIDER_MAX = 100
const ERROR_NAME_MAX = 100
const ERROR_MESSAGE_MAX = 500
const MICRO_PER_USD = 1_000_000

const nonNegative = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0

const optionalCount = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null

const cut = (text: string | undefined, max: number): string | null =>
  typeof text === 'string' && text !== '' ? text.slice(0, max) : null

/** The start time as epoch ms. An unparsable time falls back to now, so the row still sorts with the others. */
function epochOf(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Date.now()
}

/** Bytes of the JSON of a value, before redaction and before gzip. 0 when the value cannot be serialized. */
function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null')
  } catch {
    return 0
  }
}

function isTrigger(value: string | undefined): value is LlmTrigger {
  return value !== undefined && (LLM_TRIGGERS as readonly string[]).includes(value)
}

/**
 * The upstream provider (OpenRouter's `provider.openrouter.provider`). eharness already sets `upstreamProvider` from it; this is
 * the fallback when a record carries only the metadata. Null when neither reports one.
 */
function upstreamOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const openrouter = metadata?.openrouter
  if (typeof openrouter !== 'object' || openrouter === null) return undefined
  const provider = (openrouter as Record<string, unknown>).provider
  return typeof provider === 'string' ? provider : undefined
}

/**
 * Whether a call stores its bodies: the setting is on, and a guest session keeps its text only when `guestBodies` is on
 * (ADR-0032 §6: guests keep nothing else on disk).
 */
function bodiesWanted(kind: SessionKindName, settings: LogsSettings): boolean {
  if (!settings.captureBodies) return false
  return kind !== 'guest' || settings.guestBodies
}

/**
 * Maps one `model.call` event to the rows to store, or undefined when the session id matches no kind (such a call is not
 * captured, ADR-0032 §2). Pure: the caller decides what to do with the result.
 *
 * Session: the kind and app come from the registry; the person is the registry's person (chat, task, aux), the principal for a
 * dream judge (its id names no person), and null for a room or a guest. A room call records its speaker (`speakerId`) from the
 * principal; the session belongs to the room.
 *
 * Call: `trigger` is the turn kind when the hook sees a turn, else null. Compaction and flush calls usually run inside a turn,
 * so they carry the turn's kind; a call with no turn has null. Fallbacks: eharness (0.14.0) reports no fallback chain, so
 * `fallbackNote` is null (the served provider is `upstreamProvider`). Missing usage counters are 0 (`tokensIn`, `tokensOut`) or
 * null (cache, reasoning). A missing cost is null (no price in the catalog). `costSource` is kept only with a cost.
 *
 * Bodies: each of the request (`{ options, body }`), the response and the output goes through redact, then truncate
 * (`maxBodyBytes`), then pack (gzip). `requestBytes` and `responseBytes` are the JSON size of the event's request and response
 * before any of that. `body_state`: `off` when bodies are not kept, `truncated` when a cut happened, else `stored`.
 */
export function toRecord(
  event: ModelCallEvent,
  context: CaptureContext,
  settings: LogsSettings,
): CaptureRecord | undefined {
  const kind = sessionKindOf(event.sessionId)
  if (kind === undefined) return undefined
  const ref = sessionRefOf(event.sessionId)
  const principal = cut(context.principalId, 100)

  const session: ActivitySessionInput = {
    id: event.sessionId,
    kind,
    personId: kind === 'dream' ? principal : (ref?.personId ?? null),
    roomId: kind === 'room' ? (ref?.roomId ?? null) : null,
    app: sessionKindRow(kind).app,
  }

  const usage = event.usage
  const costMicro =
    typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)
      ? Math.max(0, Math.round(event.costUsd * MICRO_PER_USD))
      : null
  const bodyState: LlmBodyState = bodiesWanted(kind, settings) ? 'stored' : 'off'

  const call: LlmCallRecord = {
    id: event.id,
    sessionId: event.sessionId,
    kind: event.kind as LlmCallKind,
    trigger: isTrigger(context.turnKind) ? context.turnKind : null,
    turnId: cut(event.turnId, TURN_ID_MAX),
    stepIndex: event.stepIndex ?? null,
    startedAt: epochOf(event.startedAt),
    durationMs: nonNegative(event.durationMs),
    firstChunkMs: event.firstChunkMs === undefined ? null : nonNegative(event.firstChunkMs),
    status: event.status,
    finishReason: cut(event.finishReason, FINISH_MAX),
    modelId: event.model.modelId.slice(0, MODEL_MAX),
    provider: event.model.provider.slice(0, PROVIDER_MAX),
    upstreamProvider: cut(
      event.upstreamProvider ?? upstreamOf(event.providerMetadata),
      PROVIDER_MAX,
    ),
    tokensIn: nonNegative(usage.inputTokens),
    tokensOut: nonNegative(usage.outputTokens),
    cacheRead: optionalCount(usage.inputTokenDetails?.cacheReadTokens),
    cacheWrite: optionalCount(usage.inputTokenDetails?.cacheWriteTokens),
    reasoning: optionalCount(usage.outputTokenDetails?.reasoningTokens),
    costMicro,
    costSource: costMicro === null ? null : (event.costSource ?? null),
    fallbackNote: null,
    // a provider error may echo a key ("Incorrect API key provided: sk-…"): redacted before the cut, so half a key cannot slip by
    errorName: cut(
      event.error?.name === undefined ? undefined : redactString(event.error.name),
      ERROR_NAME_MAX,
    ),
    errorMessage: cut(
      event.error?.message === undefined ? undefined : redactString(event.error.message),
      ERROR_MESSAGE_MAX,
    ),
    requestBytes: jsonBytes({ options: event.request.options, body: event.request.body }),
    responseBytes: jsonBytes(event.response),
    bodyState,
    speakerId: kind === 'room' ? principal : null,
  }

  if (bodyState === 'off') return { session, call }

  let truncated = false
  const stored = (value: unknown): Uint8Array<ArrayBuffer> => {
    const cutValue = truncateBody(redact(value), { maxBodyBytes: settings.maxBodyBytes })
    if (cutValue.truncated) truncated = true
    return pack(cutValue.value)
  }
  const bodies = {
    request: stored({ options: event.request.options, body: event.request.body }),
    response: stored(event.response),
    output: stored(event.output),
  }
  call.bodyState = truncated ? 'truncated' : 'stored'
  return { session, call, bodies }
}

export interface ActivityLogsDeps {
  /** Where captured records go. The hook only calls `enqueue`. */
  queue: Pick<LogQueue<CaptureRecord>, 'enqueue'>
  settings: Pick<ActivityLogSettings, 'get'>
}

/**
 * The `activity-logs` core plugin: records every model call of an agent it is added to (ADR-0032 §1). Observe-only: it does
 * not change a call, a turn or a budget charge. The settings are read per call, so a change applies to the next call.
 */
export function activityLogs(deps: ActivityLogsDeps): HarnessPlugin {
  return definePlugin({
    name: 'activity-logs',
    setup: () => ({
      hooks: {
        'model.call': (ctx, event) => {
          try {
            const record = toRecord(
              event,
              { principalId: ctx.principal?.id, turnKind: ctx.turn?.kind },
              deps.settings.get(),
            )
            if (record !== undefined) deps.queue.enqueue(record)
          } catch {
            // the hook never throws into eharness: a capture failure loses one row, never the turn
          }
        },
      },
    }),
  })
}
