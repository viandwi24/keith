/**
 * Provider interfaces v1. See docs/contracts/providers.md. Adapters implement these; the core
 * owns the agent loop (ADR-0004).
 */

import type { AudioCodec } from '@keith/protocol'

/** A JSON Schema object, converted from zod by the core. */
export type JsonSchema = { [key: string]: unknown }

export interface LlmProvider {
  /** 'openrouter', 'deepseek': the prefix in model refs (`<providerId>:<modelId>`). */
  id: string
  listModels?(signal?: AbortSignal): Promise<LlmModelInfo[]>
  /** Streams one completion. Ends with exactly one `finish` event (adapter obligation 1). */
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>
}

export type LlmReasoning = 'off' | 'low' | 'medium' | 'high'

export interface LlmRequest {
  /** The part of the model ref after `<providerId>:`. */
  model: string
  system: string
  messages: LlmMessage[]
  tools?: LlmToolSpec[] | undefined
  temperature?: number | undefined
  maxOutputTokens?: number | undefined
  /** Adapters map or ignore it. */
  reasoning?: LlmReasoning | undefined
}

export type LlmMessage =
  /** `name` is the author in group threads (phase 5). */
  | { role: 'user'; content: string; name?: string | undefined }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] | undefined }
  | { role: 'tool'; toolCallId: string; content: string }

export interface LlmToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface LlmToolCall {
  id: string
  name: string
  /** Already JSON-parsed. Unparseable arguments arrive as `{ __raw: string }`. */
  args: unknown
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other'

export type LlmUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number | undefined }

export type LlmEvent =
  | { type: 'text.delta'; text: string }
  /** Never shown to nodes by default; logged at debug. */
  | { type: 'reasoning.delta'; text: string }
  /** Emitted once per call, when its arguments are complete. */
  | { type: 'tool.call'; call: LlmToolCall }
  | { type: 'finish'; reason: LlmFinishReason; usage?: LlmUsage | undefined }

export interface LlmModelInfo {
  id: string
  contextWindow?: number | undefined
  supportsTools?: boolean | undefined
}

export const PROVIDER_ERROR_CODES = [
  'auth',
  'rate_limited',
  'bad_request',
  'unavailable',
  'timeout',
  'aborted',
  'unknown',
] as const
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

/** Codes that are retryable unless the adapter says otherwise. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limited',
  'unavailable',
  'timeout',
])

export type ProviderErrorOptions = {
  retryable?: boolean
  /** HTTP status of the vendor response, when there was one. */
  status?: number
  cause?: unknown
}

/**
 * The error every provider adapter throws (adapter obligation 4). The core maps it to the
 * `PROVIDER_ERROR` code when it reaches a node.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(code: ProviderErrorCode, message: string = code, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code)
    this.status = options.status
  }
}

export function isProviderError(error: unknown, code?: ProviderErrorCode): error is ProviderError {
  return error instanceof ProviderError && (code === undefined || error.code === code)
}

// Voice (phase 3). Finalized by task P3-K1 (ADR-0013).

/**
 * A piece of encoded audio. For `pcm16`, `data` holds 16-bit signed little-endian mono samples
 * and always an even number of bytes (whole samples).
 */
export type AudioChunk = {
  data: Uint8Array
  codec: AudioCodec
  /** Hz. */
  sampleRate: number
}
/** One complete utterance for batch STT (`SttProvider.transcribe`). The core sends `pcm16`. */
export type AudioInput = AudioChunk
export type SttOptions = {
  /** BCP-47 or ISO-639-1 hint, e.g. `en`. Omitted: the provider detects the language. */
  language?: string | undefined
  /** Vocabulary or context hint (names, jargon). Adapters pass it on or ignore it. */
  prompt?: string | undefined
}
export type TtsOptions = {
  /** Overrides the adapter's configured voice. */
  voice?: string | undefined
  /** Hint for multilingual voices. Adapters pass it on or ignore it. */
  language?: string | undefined
}
/** Finalized in phase 8. */
export type RealtimeOptions = { [key: string]: unknown }
/** Finalized in phase 8. */
export type RealtimeEvent = { type: string; [key: string]: unknown }

export interface VadProvider {
  id: string
  create(opts: { sampleRate: number }): VadStream
}
export interface VadStream {
  push(pcm16: Int16Array): VadEvent[]
  close(): void
}
export type VadEvent = { type: 'speech.start'; atMs: number } | { type: 'speech.end'; atMs: number }

/** Implements at least one of `transcribe` and `stream`. */
export interface SttProvider {
  id: string
  transcribe?(
    audio: AudioInput,
    opts: SttOptions,
    signal: AbortSignal,
  ): Promise<{ text: string; language?: string | undefined }>
  stream?(opts: SttOptions, signal: AbortSignal): SttStream
}
export interface SttStream {
  push(chunk: AudioChunk): void
  end(): void
  events(): AsyncIterable<{ type: 'partial' | 'final'; text: string }>
}

/** Every chunk of one `stream()` call has the same `codec` and `sampleRate`. */
export interface TtsProvider {
  id: string
  stream(
    text: AsyncIterable<string> | string,
    opts: TtsOptions,
    signal: AbortSignal,
  ): AsyncIterable<AudioChunk>
}

/** Phase 8. */
export interface RealtimeProvider {
  id: string
  open(opts: RealtimeOptions, signal: AbortSignal): Promise<RealtimeSession>
}
export interface RealtimeSession {
  sendAudio(chunk: AudioChunk): void
  /** Typed input during a voice session. */
  sendText(text: string): void
  sendToolResult(callId: string, content: string): void
  /** Audio out, transcripts, tool calls, turn end. */
  events(): AsyncIterable<RealtimeEvent>
  close(): Promise<void>
}
