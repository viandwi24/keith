import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { scriptedModel } from 'eharness/testing'
import { resolveRoleModel, roleModel } from './role-model.ts'
import type { ProviderService } from './service.ts'
import { INFERENCE_THINKING, NO_THINKING_CALLS, thinkingFor, withThinking } from './thinking.ts'

// The DeepSeek thinking policy (thinking.ts): the per-call option is set for a DeepSeek model in a no-thinking call, and nowhere else.

const PROMPT = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'classify' }] }]

/** A scripted model whose provider id is `provider`; `calls` shows the options the provider received. */
function modelOf(provider: string) {
  return scriptedModel([{ text: 'ok' }], { provider, modelId: 'deepseek-v4-flash' })
}

/** Runs one generate call on a (possibly wrapped) model; the scripted model records its options. */
const generate = (model: LanguageModel, options: Record<string, unknown>) =>
  (model as unknown as { doGenerate(o: unknown): Promise<unknown> }).doGenerate(options)

const deepseekOf = (call: { providerOptions?: unknown }) =>
  (call.providerOptions as { deepseek?: { thinking?: unknown } } | undefined)?.deepseek?.thinking

describe('thinking: the call list and the setting', () => {
  test('the no-thinking calls are the judge and the compaction summary and flush; the setting is off', () => {
    expect([...NO_THINKING_CALLS]).toEqual(['dream-judge', 'compaction'])
    expect(INFERENCE_THINKING).toBe('off')
    expect(thinkingFor('dream-judge')).toBe('off')
    expect(thinkingFor('compaction')).toBe('off')
    expect(thinkingFor(undefined)).toBe('auto')
  })
})

describe('thinking: withThinking', () => {
  test('a DeepSeek model in a no-thinking call sends thinking disabled, per call', async () => {
    const model = modelOf('deepseek.chat')
    const wrapped = withThinking(model, 'off')
    expect(wrapped).not.toBe(model)
    await generate(wrapped, { prompt: PROMPT })
    expect(deepseekOf(model.calls[0] as never)).toEqual({ type: 'disabled' })
  })

  test('a caller that set its own thinking option keeps it', async () => {
    const model = modelOf('deepseek.chat')
    await generate(withThinking(model, 'off'), {
      prompt: PROMPT,
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
    })
    expect(deepseekOf(model.calls[0] as never)).toEqual({ type: 'enabled' })
  })

  test('the setting auto leaves a DeepSeek model alone', () => {
    const model = modelOf('deepseek.chat')
    expect(withThinking(model, 'auto')).toBe(model)
  })

  test('a non-DeepSeek model is returned unchanged, even in a no-thinking call', () => {
    const model = modelOf('openrouter.chat')
    expect(withThinking(model, 'off')).toBe(model)
    const anthropic = modelOf('anthropic.messages')
    expect(withThinking(anthropic, 'off')).toBe(anthropic)
  })

  test('a model string or a missing model passes through', () => {
    expect(withThinking('deepseek-flash' as LanguageModel, 'off')).toBe('deepseek-flash' as never)
  })
})

describe('thinking: where the policy is applied', () => {
  const providersWith = (model: LanguageModel) =>
    ({ resolveRole: async () => model }) as unknown as ProviderService

  test('the judge role (dream-judge) gets thinking off on DeepSeek', async () => {
    const model = modelOf('deepseek.chat')
    const resolved = await resolveRoleModel('cortex', providersWith(model), 'dream-judge')
    await generate(resolved, { prompt: PROMPT })
    expect(deepseekOf(model.calls[0] as never)).toEqual({ type: 'disabled' })
  })

  test('the compaction summary and flush (front role, call kind compaction) get thinking off on DeepSeek', async () => {
    const model = modelOf('deepseek.chat')
    const resolved = await resolveRoleModel('front', providersWith(model), 'compaction')
    await generate(resolved, { prompt: PROMPT })
    expect(deepseekOf(model.calls[0] as never)).toEqual({ type: 'disabled' })
  })

  test('the front role without a call kind is not touched, on DeepSeek too', async () => {
    const model = modelOf('deepseek.chat')
    const resolved = await resolveRoleModel('front', providersWith(model))
    expect(resolved).toBe(model)
    await generate(resolved, { prompt: PROMPT })
    expect(model.calls[0]?.providerOptions).toBeUndefined()
  })

  test('the judge role on a non-DeepSeek provider is not touched', async () => {
    const model = modelOf('openrouter.chat')
    expect(await resolveRoleModel('cortex', providersWith(model), 'dream-judge')).toBe(model)
  })

  test('the roleModel plugin is built with its call kind (the hook is a function of the plugin)', () => {
    const plugin = roleModel('cortex', providersWith(modelOf('deepseek.chat')), 'dream-judge')
    expect(plugin.name).toBe('role-model')
  })
})
