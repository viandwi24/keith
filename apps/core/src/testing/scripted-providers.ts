/**
 * Scripted providers for gate tests: `scriptedProvider` models whose model calls can be held by
 * the test (a worker that "works" until the test releases it) and observed (how many calls
 * started, what prompts they got). Test-only; production code has no such hooks.
 */
import type { ModelInfo } from 'eharness'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod'

export interface Gate {
  /** Model calls that entered `doStream` so far. */
  readonly started: number
  /** Let every held and future call through. */
  release(): void
  /** Hold the next calls again (after a `release`). */
  close(): void
  /** Resolves when `started` reaches `n`. */
  whenStarted(n: number, ms?: number): Promise<void>
}

export interface HeldGate extends Gate {
  /** Called by the provider: count the call, then wait while the gate is closed. */
  pass(): Promise<void>
}

export function createGate(): HeldGate {
  let open = false
  let opened!: () => void
  let wait = new Promise<void>((resolve) => {
    opened = resolve
  })
  const gate = {
    started: 0,
    release() {
      open = true
      opened()
    },
    close() {
      if (!open) return
      open = false
      wait = new Promise<void>((resolve) => {
        opened = resolve
      })
    },
    async whenStarted(n: number, ms = 5000) {
      const end = Date.now() + ms
      while (gate.started < n) {
        if (Date.now() > end) throw new Error(`gate: ${n} calls not reached (got ${gate.started})`)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    },
    pass: async (): Promise<void> => {
      gate.started += 1
      if (!open) await wait
    },
  }
  return gate
}

export interface TestProviderOptions {
  id: string
  models: Record<string, ScriptedStepInput[]>
  /** Limits and prices per model id (`contextWindow`, `pricing`), as a real catalog reports them. */
  info?: Record<string, ModelInfo>
  /** Hold every call of every model of this provider until released. */
  gate?: HeldGate
  /** Runs before every call (with the prompt as JSON), e.g. to wait for a worker to start. */
  before?: (prompt: string) => Promise<void>
}

export interface TestProvider {
  id: string
  label: string
  settings: z.ZodObject
  create(): { languageModel(modelId: string): ScriptedModel }
  listModels(): Promise<Array<{ id: string; name: string; tools: boolean; info?: ModelInfo }>>
  /** The scripted models created so far (read `.prompts` and `.calls`). */
  models: Map<string, ScriptedModel>
}

/** Same shape as `scriptedProvider`, with the hold and the hook. */
export function testProvider(options: TestProviderOptions): TestProvider {
  const models = new Map<string, ScriptedModel>()
  const wrapped = new Map<string, ScriptedModel>()
  return {
    id: options.id,
    label: options.id,
    settings: z.object({}),
    models,
    create: () => ({
      languageModel(modelId) {
        const have = wrapped.get(modelId)
        if (have !== undefined) return have
        const inner = scriptedModel(options.models[modelId] ?? [], {
          provider: options.id,
          modelId,
        })
        models.set(modelId, inner)
        const proxy = new Proxy(inner, {
          get(target, prop, receiver) {
            if (prop !== 'doStream') return Reflect.get(target, prop, receiver)
            return async (call: Parameters<ScriptedModel['doStream']>[0]) => {
              await options.before?.(JSON.stringify(call.prompt))
              await options.gate?.pass()
              return target.doStream(call)
            }
          },
        })
        wrapped.set(modelId, proxy)
        return proxy
      },
    }),
    listModels: async () =>
      Object.keys(options.models).map((id) => ({
        id,
        name: id,
        tools: true,
        ...(options.info?.[id] === undefined ? {} : { info: options.info[id] }),
      })),
  }
}
