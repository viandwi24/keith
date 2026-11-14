import type { LanguageModel } from 'ai'
import type { ProviderService } from '../providers/index.ts'
import { resolveRoleModel } from '../providers/index.ts'

// The front agent's summarize trigger (audit F14, docs/specs/wernicke-broca.md "Compaction"): a ratio of the model's context
// window, but never above an absolute token budget, so a 1M-token window does not let a conversation grow to 650k tokens
// before the first summary.

/** The ratio of the window that the front agent summarizes at (the default before the cap). */
export const SUMMARIZE_RATIO = 0.65
/** The absolute cap: the summary starts before the context reaches this many tokens. */
export const SUMMARIZE_TOKENS_CAP = 200_000

/**
 * The trigger ratio for one model: `min(0.65, 200000 / contextWindow)`. An unknown or non-positive window keeps the plain ratio.
 * Pure: the window comes in as a number.
 */
export function summarizeRatioFor(contextWindow: number | undefined): number {
  if (contextWindow === undefined || !(contextWindow > 0)) return SUMMARIZE_RATIO
  return Math.min(SUMMARIZE_RATIO, SUMMARIZE_TOKENS_CAP / contextWindow)
}

/** The window of a resolved model in the provider catalog (an unknown model has none). */
export function windowOfModel(
  catalog: ReturnType<ProviderService['catalog']>,
  model: LanguageModel,
): number | undefined {
  const id = (model as { modelId?: unknown }).modelId
  const info =
    typeof catalog === 'function'
      ? catalog(model)
      : typeof id === 'string'
        ? catalog[id]
        : undefined
  return info?.contextWindow
}

/**
 * The `compaction.summarizeAt` function form of the front agent: read once per turn, on the front role's model of the moment.
 * Never throws: a failed lookup keeps the plain ratio (eharness would fall back to its own default otherwise).
 */
export function frontSummarizeAt(providers: ProviderService): () => Promise<number> {
  return async () => {
    try {
      const model = await resolveRoleModel('front', providers)
      return summarizeRatioFor(windowOfModel(providers.catalog(), model))
    } catch {
      return SUMMARIZE_RATIO
    }
  }
}
