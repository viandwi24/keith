/**
 * `createOpenAICompatibleLlm`: an `LlmProvider` for any vendor that speaks OpenAI-compatible Chat
 * Completions with SSE streaming (docs/contracts/providers.md#createopenaicompatiblellm).
 */
import {
  isProviderError,
  type LlmEvent,
  type LlmModelInfo,
  type LlmProvider,
  type LlmRequest,
  ProviderError,
} from '../types.ts'
import { ChunkAccumulator } from './accumulator.ts'
import { providerErrorFromResponse, providerErrorFromWire } from './errors.ts'
import { buildChatBody } from './request.ts'
import { SseDecoder } from './sse.ts'
import { wireChunkSchema, wireModelsSchema } from './wire.ts'

export type OpenAICompatibleLlmOptions = {
  /** 'openrouter', 'deepseek': the prefix in model refs. */
  id: string
  /** The API root, e.g. 'https://api.deepseek.com'. `/chat/completions` and `/models` are appended. */
  baseUrl: string
  apiKey: string
  /** Extra headers on every request (e.g. attribution). */
  headers?: Record<string, string> | undefined
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
  /** Adjusts the default `chat/completions` body, e.g. to map `req.reasoning`. */
  mapRequest?: ((body: Record<string, unknown>, req: LlmRequest) => Record<string, unknown>) | undefined
  /**
   * Maps one parsed chunk for vendor-specific fields. Return events to replace the default mapping
   * of that chunk, or `undefined` to use the default. A returned `finish` only sets the finish
   * reason and usage: the helper still emits exactly one `finish`, last.
   */
  mapChunk?: ((chunk: unknown) => LlmEvent[] | undefined) | undefined
}

type Ctx = OpenAICompatibleLlmOptions & { base: string }

export function createOpenAICompatibleLlm(opts: OpenAICompatibleLlmOptions): LlmProvider {
  const ctx: Ctx = { ...opts, base: opts.baseUrl.replace(/\/+$/, '') }
  return {
    id: opts.id,
    listModels: (signal) => listModels(ctx, signal),
    stream: (req, signal) => streamCompletion(ctx, req, signal),
  }
}

function headersFor(ctx: Ctx, accept: string): Record<string, string> {
  return {
    ...ctx.headers,
    authorization: `Bearer ${ctx.apiKey}`,
    accept,
  }
}

function abortedError(ctx: Ctx, signal: AbortSignal): ProviderError {
  return new ProviderError('aborted', `${ctx.id}: aborted`, { cause: signal.reason })
}

async function send(ctx: Ctx, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, { ...init, signal })
  } catch (cause) {
    if (signal.aborted) throw abortedError(ctx, signal)
    throw new ProviderError('unavailable', `${ctx.id}: request failed`, { cause })
  }
  if (!response.ok) throw await providerErrorFromResponse(ctx.id, response)
  return response
}

async function listModels(ctx: Ctx, signal?: AbortSignal): Promise<LlmModelInfo[]> {
  const effective = signal ?? new AbortController().signal
  if (effective.aborted) throw abortedError(ctx, effective)
  const response = await send(
    ctx,
    `${ctx.base}/models`,
    { headers: headersFor(ctx, 'application/json') },
    effective,
  )
  let json: unknown
  try {
    json = await response.json()
  } catch (cause) {
    if (effective.aborted) throw abortedError(ctx, effective)
    throw new ProviderError('unknown', `${ctx.id}: malformed models response`, { cause })
  }
  const parsed = wireModelsSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProviderError('unknown', `${ctx.id}: unexpected models response`, { cause: parsed.error })
  }
  return parsed.data.data.map((model) => {
    const info: LlmModelInfo = { id: model.id }
    const contextWindow = model.context_length ?? model.context_window
    if (typeof contextWindow === 'number') info.contextWindow = contextWindow
    if (model.supported_parameters) info.supportsTools = model.supported_parameters.includes('tools')
    return info
  })
}

function mapData(ctx: Ctx, data: string, acc: ChunkAccumulator): LlmEvent[] {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch (cause) {
    throw new ProviderError('unknown', `${ctx.id}: malformed stream chunk`, { cause })
  }
  const parsed = wireChunkSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProviderError('unknown', `${ctx.id}: unexpected stream chunk`, { cause: parsed.error })
  }
  if (parsed.data.error) throw providerErrorFromWire(ctx.id, parsed.data.error)
  const mapped = ctx.mapChunk?.(json)
  return mapped === undefined ? acc.push(parsed.data) : acc.pushMapped(mapped)
}

async function* streamCompletion(ctx: Ctx, req: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
  if (signal.aborted) throw abortedError(ctx, signal)
  // Our own controller also closes the HTTP request when the consumer stops iterating early.
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  let reader: { cancel(): Promise<void> } | undefined
  try {
    const defaults = buildChatBody(req)
    const body = ctx.mapRequest ? ctx.mapRequest(defaults, req) : defaults
    const init: RequestInit = {
      method: 'POST',
      headers: { ...headersFor(ctx, 'text/event-stream'), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
    const response = await send(ctx, `${ctx.base}/chat/completions`, init, controller.signal)
    if (!response.body) throw new ProviderError('unavailable', `${ctx.id}: empty response body`)
    const activeReader = response.body.getReader()
    reader = activeReader

    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(abortedError(ctx, signal))
      if (controller.signal.aborted) fail()
      else controller.signal.addEventListener('abort', fail, { once: true })
    })
    // Observed by the race below; this only keeps an unraced rejection from being reported.
    aborted.catch(() => undefined)

    const decoder = new TextDecoder()
    const sse = new SseDecoder()
    const acc = new ChunkAccumulator()
    let sawDone = false
    while (!sawDone) {
      let result: Awaited<ReturnType<typeof activeReader.read>>
      try {
        result = await Promise.race([activeReader.read(), aborted])
      } catch (cause) {
        if (signal.aborted) throw abortedError(ctx, signal)
        if (isProviderError(cause)) throw cause
        throw new ProviderError('unavailable', `${ctx.id}: stream interrupted`, { cause })
      }
      const payloads = result.done
        ? [...sse.push(decoder.decode()), ...sse.end()]
        : sse.push(decoder.decode(result.value, { stream: true }))
      for (const data of payloads) {
        if (data === '[DONE]') {
          sawDone = true
          break
        }
        for (const event of mapData(ctx, data, acc)) {
          yield event
          if (signal.aborted) throw abortedError(ctx, signal)
        }
      }
      if (result.done) break
    }
    if (!sawDone && !acc.sawFinishReason) {
      throw new ProviderError('unavailable', `${ctx.id}: stream ended before a finish reason`)
    }
    for (const event of acc.finish()) yield event
  } finally {
    signal.removeEventListener('abort', onAbort)
    controller.abort()
    // Cancelling an already closed or errored stream rejects; there is nothing left to release.
    reader?.cancel().catch(() => undefined)
  }
}
