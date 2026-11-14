import type { LanguageModel } from 'ai'

/**
 * Claude reached through OpenRouter (`openrouter.chat`, model id `anthropic/…`): eharness sends Anthropic cache markers
 * only to Anthropic's own provider unless `cache.include` accepts the model (eharness 0.14.0, spec 02 §6.1). The
 * OpenRouter provider forwards the per-message markers as `cache_control`, so the front agent's prefix is cached there
 * too (docs/specs/wernicke-broca.md "Prompt caching").
 */
export function isRoutedAnthropic(model: LanguageModel): boolean {
  if (typeof model === 'string') return false
  return model.provider.startsWith('openrouter') && model.modelId.startsWith('anthropic/')
}

/**
 * The front agent's cache: explicit breakpoints, not `'auto'`. With the turn reminder at the end, breakpoint (c) is the
 * last stable message, before the reminder, so turn N+1 reads turn N from the cache; `'auto'` would mark the reminder
 * itself, and OpenRouter ignores the call-level option anyway.
 */
export const FRONT_CACHE = { mode: 'breakpoints', include: isRoutedAnthropic } as const
