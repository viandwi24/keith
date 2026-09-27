/**
 * Turns parsed `chat.completion.chunk`s into `LlmEvent`s: text and reasoning deltas as they come,
 * streamed tool calls assembled and emitted once each, and one `finish` at the very end
 * (adapter obligations 1 and 2).
 */
import type { LlmEvent, LlmFinishReason, LlmToolCall, LlmUsage } from '../types.ts'
import { fromWireToolName, type WireChunk, type WireToolCallDelta, type WireUsage } from './wire.ts'

type PendingCall = { id: string; name: string; args: string }

export function mapFinishReason(reason: string): LlmFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content_filter':
    case 'tool_calls':
      return reason
    case 'function_call':
      return 'tool_calls'
    default:
      return 'other'
  }
}

export function mapUsage(usage: WireUsage): LlmUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? undefined
  const out: LlmUsage = { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 }
  if (cached !== undefined && cached !== null) out.cachedInputTokens = cached
  return out
}

export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: raw }
  }
}

export class ChunkAccumulator {
  private readonly calls = new Map<number, PendingCall>()
  private lastIndex = -1
  private finishReason: LlmFinishReason | undefined
  private usage: LlmUsage | undefined
  private finished = false

  /** True once the vendor sent a `finish_reason`. */
  get sawFinishReason(): boolean {
    return this.finishReason !== undefined
  }

  /** The default mapping of one chunk. */
  push(chunk: WireChunk): LlmEvent[] {
    const events: LlmEvent[] = []
    if (chunk.usage) this.usage = mapUsage(chunk.usage)
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue
      const delta = choice.delta
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) events.push({ type: 'reasoning.delta', text: reasoning })
      if (delta?.content) events.push({ type: 'text.delta', text: delta.content })
      for (const call of delta?.tool_calls ?? []) this.addToolCallDelta(call)
      if (choice.finish_reason) {
        this.finishReason = mapFinishReason(choice.finish_reason)
        // Arguments are complete once the vendor names a finish reason.
        events.push(...this.flushCalls())
      }
    }
    return events
  }

  /** Events a `mapChunk` override produced. A `finish` only records its reason and usage. */
  pushMapped(events: LlmEvent[]): LlmEvent[] {
    const out: LlmEvent[] = []
    for (const event of events) {
      if (event.type === 'finish') {
        this.finishReason = event.reason
        if (event.usage) this.usage = event.usage
      } else {
        out.push(event)
      }
    }
    return out
  }

  /** Flushes pending tool calls and emits the one `finish`. Idempotent. */
  finish(): LlmEvent[] {
    if (this.finished) return []
    this.finished = true
    const events = this.flushCalls()
    const hadCalls = events.length > 0
    const reason = this.finishReason ?? (hadCalls ? 'tool_calls' : 'other')
    events.push(this.usage ? { type: 'finish', reason, usage: this.usage } : { type: 'finish', reason })
    return events
  }

  private addToolCallDelta(delta: WireToolCallDelta): void {
    let index = delta.index ?? (delta.id ? this.lastIndex + 1 : this.lastIndex)
    if (index < 0) index = 0
    const existing = this.calls.get(index)
    // Some vendors reuse index 0 for parallel calls: a new id at a used index is a new call.
    if (existing?.id && delta.id && existing.id !== delta.id) {
      index = Math.max(this.lastIndex, ...this.calls.keys()) + 1
    }
    this.lastIndex = Math.max(this.lastIndex, index)
    const call = this.calls.get(index) ?? { id: delta.id ?? '', name: '', args: '' }
    if (!call.id && delta.id) call.id = delta.id
    const name = delta.function?.name
    if (name && !call.name) call.name = name
    call.args += delta.function?.arguments ?? ''
    this.calls.set(index, call)
  }

  private flushCalls(): LlmEvent[] {
    const indexes = [...this.calls.keys()].sort((a, b) => a - b)
    const events: LlmEvent[] = indexes.map((index) => {
      const pending = this.calls.get(index) as PendingCall
      const call: LlmToolCall = {
        id: pending.id || `call_${index}`,
        name: fromWireToolName(pending.name),
        args: parseToolArguments(pending.args),
      }
      return { type: 'tool.call', call }
    })
    this.calls.clear()
    return events
  }
}
