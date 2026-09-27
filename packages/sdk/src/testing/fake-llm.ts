import { KeithError } from '../errors.ts'
import { definePlugin } from '../plugin.ts'
import type { LlmEvent, LlmProvider, LlmRequest, LlmToolCall } from '../providers/types.ts'
import { ProviderError } from '../providers/types.ts'

/** Wait `ms` before the next event. Honors the abort signal. */
export type FakeLlmDelay = { delay: number }

export type FakeLlmStep = LlmEvent | FakeLlmDelay

/**
 * One scripted completion: a list of steps, or a function of the request (and the 0-based call
 * index) that returns them. A `finish` event is appended when the turn has none.
 */
export type FakeLlmTurn = FakeLlmStep[] | ((req: LlmRequest, call: number) => FakeLlmStep[])

export type FakeLlmOptions = {
  /** Provider id. Default `'fake'`. */
  id?: string
  /** Used for every call after the script runs out. Without it, an exhausted script throws. */
  fallback?: FakeLlmTurn
  /** Injectable sleep for `delay` steps. Default: a real, abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export type FakeLlm = LlmProvider & {
  /** Every request received, in order (deep copies). */
  readonly requests: LlmRequest[]
  /** Number of `stream` calls so far. */
  readonly calls: number
  /** Appends turns to the script. */
  push(...turns: FakeLlmTurn[]): void
}

/**
 * A scripted `LlmProvider` for tests (R-13). Each `stream` call plays the next turn of the script.
 * It follows the adapter obligations: exactly one `finish`, always last, and an abort ends the
 * stream by throwing `ProviderError('aborted')`.
 */
export function createFakeLlm(script: FakeLlmTurn[] = [], options: FakeLlmOptions = {}): FakeLlm {
  const turns = [...script]
  const requests: LlmRequest[] = []
  const sleep = options.sleep ?? abortableSleep
  let calls = 0

  async function* stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const call = calls++
    requests.push(structuredClone(req))
    throwIfAborted(signal)
    const turn = turns.shift() ?? options.fallback
    if (turn === undefined) {
      throw new ProviderError('unknown', `fake llm script exhausted at call ${call + 1}`)
    }
    const steps = withFinish(typeof turn === 'function' ? turn(req, call) : turn)
    for (const step of steps) {
      if ('delay' in step) {
        await sleep(step.delay, signal)
      } else {
        yield step
      }
      throwIfAborted(signal)
    }
  }

  return {
    id: options.id ?? 'fake',
    stream,
    requests,
    get calls() {
      return calls
    },
    push(...more) {
      turns.push(...more)
    },
  }
}

function withFinish(steps: FakeLlmStep[]): FakeLlmStep[] {
  const finishes = steps.filter((s) => 'type' in s && s.type === 'finish')
  if (finishes.length > 1) throw new KeithError('INTERNAL', 'fake llm turn has more than one finish event')
  const last = steps.at(-1)
  if (finishes.length === 1) {
    if (last !== finishes[0])
      throw new KeithError('INTERNAL', 'fake llm turn has a finish event that is not last')
    return steps
  }
  const hasToolCall = steps.some((s) => 'type' in s && s.type === 'tool.call')
  return [...steps, { type: 'finish', reason: hasToolCall ? 'tool_calls' : 'stop' }]
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError('aborted', 'request aborted', { cause: signal.reason })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('aborted', 'request aborted', { cause: signal.reason }))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ProviderError('aborted', 'request aborted', { cause: signal.reason }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Script builders

/** Text split into deltas of at most `chunkSize` characters (default: one delta). */
export function fakeText(text: string, chunkSize = text.length || 1): LlmEvent[] {
  const events: LlmEvent[] = []
  for (let i = 0; i < text.length; i += chunkSize)
    events.push({ type: 'text.delta', text: text.slice(i, i + chunkSize) })
  return events
}

/** A complete tool call event. */
export function fakeToolCall(
  name: string,
  args: unknown,
  id = `call_${name.replaceAll('.', '_')}`,
): LlmEvent {
  const call: LlmToolCall = { id, name, args }
  return { type: 'tool.call', call }
}

/** A pause of `ms` milliseconds. */
export function fakeDelay(ms: number): FakeLlmDelay {
  return { delay: ms }
}

/**
 * A `provider` plugin that registers a fake LLM, for booting the core in tests
 * (`bootstrap({ plugins: [createFakeLlmPlugin(fake)] })`). Map a model role to it with
 * `"<fake.id>:<any-model>"` in config.
 */
export function createFakeLlmPlugin(fake: LlmProvider, opts: { id?: string; namespace?: string } = {}) {
  return definePlugin({
    id: opts.id ?? '@keith/provider-fake',
    namespace: opts.namespace ?? 'fake_llm',
    version: '0.0.0',
    kind: 'provider',
    setup(ctx) {
      ctx.providers.llm.register(fake)
    },
  })
}
