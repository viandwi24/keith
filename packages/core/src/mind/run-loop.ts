// The one turn loop behind user turns, delivery turns, briefings and tasks.
// See docs/architecture/core.md#the-turn-loop.

import { uiBlockToText } from '@keith/protocol'
import {
  type EventBus,
  isProviderError,
  KeithError,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
  type LlmToolSpec,
  type ToolResult,
} from '@keith/sdk'
import { z } from 'zod'
import type { CoreProviderRegistries, CoreToolRegistry, ToolInvocation } from '../plugins/types.ts'
import type { Clock, Ids, Logger, PersonDto, PersonId, ThreadId } from '../shared/types.ts'
import type { MessageRecord, Repositories } from '../storage/types.ts'
import type { RunLoop, RunLoopArgs, RunLoopEvent, RunLoopResult } from './types.ts'

export type RunLoopDeps = {
  providers: Pick<CoreProviderRegistries, 'llm'>
  tools: Pick<CoreToolRegistry, 'get' | 'invoke'>
  repos: Pick<Repositories, 'persons' | 'messages'>
  events: Pick<EventBus, 'emit'>
  ids: Ids
  clock: Clock
  log: Logger
  /** `mind.turn.stallMs`: a step with no stream event for this long is aborted. */
  stallMs: number
  /** Retries of a retryable provider error before the step fails. Default 2. */
  retries?: number | undefined
  /** Backoff before retry n (1-based) is `retryBaseMs * 2^(n-1)`. Default 500. */
  retryBaseMs?: number | undefined
}

type StepOutput = { text: string; calls: LlmToolCall[]; aborted: boolean }

const TOOL_SUMMARY_MAX = 200

export function createRunLoop(deps: RunLoopDeps): RunLoop {
  const retries = deps.retries ?? 2
  const retryBaseMs = deps.retryBaseMs ?? 500

  return async (a: RunLoopArgs): Promise<RunLoopResult> => {
    const emit = (e: RunLoopEvent) => a.onEvent?.(e)
    const { provider, model } = deps.providers.llm.resolve(a.modelRole)
    const specs = toolSpecs(deps, a.tools)
    const person = await loadPerson(deps, a.runCtx.personId)
    const participants = await Promise.all(a.runCtx.participants.map((id) => loadPerson(deps, id)))
    const messages: LlmMessage[] = [...a.messages]
    let text = ''

    for (let step = 1; step <= a.maxSteps; step++) {
      if (a.signal.aborted) return { text, steps: step - 1, stoppedBy: 'cancelled' }
      const out = await streamWithRetry(provider, {
        model,
        system: a.system,
        messages,
        tools: specs,
        signal: a.signal,
        step,
        onText: (t) => {
          text += t
          emit({ type: 'text.delta', text: t })
        },
      })
      if (out.aborted) return { text, steps: step, stoppedBy: 'cancelled' }
      if (out.calls.length === 0) {
        emit({ type: 'step.completed', step })
        return { text, steps: step, stoppedBy: 'stop' }
      }

      const results = await Promise.all(
        out.calls.map((call) =>
          runTool(call, {
            toolCallId: call.id,
            person,
            participants,
            threadId: a.runCtx.threadId,
            taskId: a.runCtx.taskId,
            signal: a.signal,
          }),
        ),
      )
      messages.push({ role: 'assistant', content: out.text, toolCalls: out.calls })
      for (const [i, call] of out.calls.entries()) {
        messages.push({ role: 'tool', toolCallId: call.id, content: results[i]?.content ?? '' })
      }
      if (a.persist) await persistStep(a.persist.threadId, out, results)
      emit({ type: 'step.completed', step })
      if (a.signal.aborted) return { text, steps: step, stoppedBy: 'cancelled' }
    }
    return { text, steps: a.maxSteps, stoppedBy: 'step_limit' }

    async function runTool(call: LlmToolCall, inv: ToolInvocation): Promise<ToolResult> {
      emit({ type: 'tool.started', toolCallId: call.id, name: call.name })
      deps.events.emit('tool.called', {
        threadId: inv.threadId,
        taskId: inv.taskId,
        toolCallId: call.id,
        name: call.name,
      })
      const started = deps.clock.now()
      let result: ToolResult
      try {
        result = await deps.tools.invoke(call.name, call.args, inv)
      } catch (error) {
        // The registry never throws for tool problems; this guards the turn against a bug there.
        deps.log.error('tool invoke threw', { tool: call.name, error: String(error) })
        result = { content: `Tool ${call.name} failed: ${errorMessage(error)}`, error: true }
      }
      const ok = result.error !== true
      emit({
        type: 'tool.completed',
        toolCallId: call.id,
        name: call.name,
        ok,
        summary: ok ? undefined : result.content.slice(0, TOOL_SUMMARY_MAX),
      })
      deps.events.emit('tool.completed', {
        toolCallId: call.id,
        name: call.name,
        ok,
        ms: deps.clock.now() - started,
      })
      if (result.ui) {
        emit({
          type: 'ui',
          toolCallId: call.id,
          toolName: call.name,
          block: result.ui,
          fallbackText: result.fallbackText ?? uiBlockToText(result.ui),
        })
      }
      return result
    }

    async function persistStep(threadId: ThreadId, out: StepOutput, results: ToolResult[]) {
      const rows: MessageRecord[] = [
        {
          id: deps.ids.next('msg'),
          threadId,
          role: 'assistant',
          authorPersonId: null,
          nodeId: null,
          modality: 'text',
          content: out.text,
          meta: null,
          createdAt: deps.clock.now(),
          toolCalls: out.calls,
          ui: null,
        },
        ...out.calls.map(
          (call, i): MessageRecord => ({
            id: deps.ids.next('msg'),
            threadId,
            role: 'tool',
            authorPersonId: null,
            nodeId: null,
            modality: 'text',
            content: results[i]?.content ?? '',
            meta: null,
            createdAt: deps.clock.now(),
            toolCallId: call.id,
            toolName: call.name,
            isError: results[i]?.error === true,
          }),
        ),
      ]
      for (const row of rows) {
        await deps.repos.messages.append(row)
        deps.events.emit('thread.message_added', {
          threadId,
          messageId: row.id,
          role: row.role,
          authorPersonId: null,
        })
      }
    }
  }

  type StreamArgs = {
    model: string
    system: string
    messages: LlmMessage[]
    tools: LlmToolSpec[]
    signal: AbortSignal
    step: number
    onText: (text: string) => void
  }

  async function streamWithRetry(provider: LlmProvider, s: StreamArgs): Promise<StepOutput> {
    for (let attempt = 0; ; attempt++) {
      let emitted = false
      try {
        return await streamStep(provider, s, () => {
          emitted = true
        })
      } catch (error) {
        const retryable = isProviderError(error) && error.retryable && !emitted && attempt < retries
        if (!retryable) {
          throw isProviderError(error)
            ? new KeithError('PROVIDER_ERROR', error.message, { cause: error, details: { code: error.code } })
            : error
        }
        const wait = retryBaseMs * 2 ** attempt
        deps.log.warn('llm call failed, retrying', {
          attempt: attempt + 1,
          waitMs: wait,
          error: String(error),
        })
        await sleep(wait, s.signal)
        if (s.signal.aborted) return { text: '', calls: [], aborted: true }
      }
    }
  }

  /** One provider call, guarded by the stall watchdog. */
  async function streamStep(provider: LlmProvider, s: StreamArgs, onFirst: () => void): Promise<StepOutput> {
    const step = new AbortController()
    const onOuterAbort = () => step.abort(s.signal.reason)
    s.signal.addEventListener('abort', onOuterAbort, { once: true })
    let stalled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        step.abort(new KeithError('PROVIDER_ERROR', 'llm stream stalled'))
      }, deps.stallMs)
    }
    let text = ''
    const calls: LlmToolCall[] = []
    try {
      arm()
      const req = { model: s.model, system: s.system, messages: s.messages, tools: s.tools }
      for await (const ev of provider.stream(
        s.tools.length > 0 ? req : { ...req, tools: undefined },
        step.signal,
      )) {
        arm()
        if (ev.type === 'text.delta') {
          if (ev.text === '') continue
          onFirst()
          text += ev.text
          s.onText(ev.text)
        } else if (ev.type === 'tool.call') {
          onFirst()
          calls.push(ev.call)
        } else if (ev.type === 'reasoning.delta') {
          deps.log.debug('llm reasoning delta', { chars: ev.text.length })
        }
      }
      return { text, calls, aborted: false }
    } catch (error) {
      if (s.signal.aborted) return { text, calls: [], aborted: true }
      if (stalled) {
        deps.log.warn('llm step stalled', { step: s.step, stallMs: deps.stallMs })
        throw new KeithError('PROVIDER_ERROR', `the model sent nothing for ${deps.stallMs} ms`, {
          cause: error,
          details: { step: s.step, stallMs: deps.stallMs },
        })
      }
      if (isProviderError(error) && error.retryable && text === '' && calls.length === 0) throw error
      throw new KeithError('PROVIDER_ERROR', errorMessage(error), { cause: error })
    } finally {
      clearTimeout(timer)
      s.signal.removeEventListener('abort', onOuterAbort)
    }
  }
}

function toolSpecs(deps: RunLoopDeps, names: string[]): LlmToolSpec[] {
  const specs: LlmToolSpec[] = []
  for (const name of names) {
    const registered = deps.tools.get(name)
    if (!registered) {
      deps.log.warn('unknown tool left out of request', { tool: name })
      continue
    }
    const { tool } = registered
    specs.push({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) })
  }
  return specs
}

async function loadPerson(deps: RunLoopDeps, id: PersonId): Promise<PersonDto> {
  const p = await deps.repos.persons.get(id)
  if (!p) throw new KeithError('NOT_FOUND', 'person not found', { details: { personId: id } })
  return { id: p.id, name: p.name, tier: p.tier }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
