// The thinking policy of a DeepSeek call (docs/specs/providers.md, "Thinking"; docs/research/inference-cost-audit.md F7). DeepSeek V4
// thinks by default, and the reasoning tokens are billed as output. A call that needs no reasoning (the dream judge's classification,
// a summary, a memory flush) turns it off per call with `providerOptions.deepseek.thinking`. Front turns, workers and rooms keep the
// provider default. Only a DeepSeek model is touched: any other provider's model is returned as it is.
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai'

/** The calls that may run without thinking. Each name is a call kind the core passes to `roleModel` or `resolveRoleModel`. */
export const NO_THINKING_CALLS = ['dream-judge', 'compaction', 'consent'] as const
export type ThinkingCall = (typeof NO_THINKING_CALLS)[number]

/** `off`: DeepSeek thinking is disabled for the call. `auto`: the provider default (on for DeepSeek V4). */
export type ThinkingSetting = 'auto' | 'off'

/**
 * The setting for the calls in `NO_THINKING_CALLS`. A code constant for now: the owner setting `inference.thinking` is a follow-up
 * (docs/specs/providers.md). With `auto`, the judge runs with the provider default, which is how the quality with thinking on is compared.
 */
export const INFERENCE_THINKING: ThinkingSetting = 'off'

/** The thinking mode of one call kind: `INFERENCE_THINKING` for a call in `NO_THINKING_CALLS`, else the provider default. */
export function thinkingFor(call: ThinkingCall | undefined): ThinkingSetting {
  if (call === undefined) return 'auto'
  return (NO_THINKING_CALLS as readonly string[]).includes(call) ? INFERENCE_THINKING : 'auto'
}

/**
 * Returns `model` with DeepSeek thinking disabled per call when `mode` is `off` and the model is a DeepSeek model (its provider id
 * starts with `deepseek`). A caller's own `providerOptions.deepseek.thinking` is kept. Any other model comes back unchanged.
 */
export function withThinking(model: LanguageModel, mode: ThinkingSetting): LanguageModel {
  if (mode === 'auto' || typeof model !== 'object' || model === null) return model
  const provider = (model as { provider?: unknown }).provider
  if (typeof provider !== 'string' || !provider.startsWith('deepseek')) return model
  const middleware = {
    specificationVersion: 'v4',
    transformParams: async ({ params }: { params: Record<string, unknown> }) => {
      const options = (params.providerOptions ?? {}) as Record<string, Record<string, unknown>>
      if (options.deepseek?.thinking !== undefined) return params
      return {
        ...params,
        providerOptions: {
          ...options,
          deepseek: { ...options.deepseek, thinking: { type: 'disabled' } },
        },
      }
    },
  } as unknown as LanguageModelMiddleware
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware,
  }) as LanguageModel
}
