import { generateText, type LanguageModel } from 'ai'
import type { WebSearchOptions } from 'eharness/web'
import { OPENROUTER_DEFAULTS, type ProviderService } from '../providers/index.ts'

export type SearchFn = WebSearchOptions['search']

/**
 * The model that runs one search: the `front` default of OpenRouter, a small and fast model
 * (ADR-0007). The OpenRouter `web` plugin does the searching; the model only phrases the findings.
 */
export const SEARCH_MODEL = OPENROUTER_DEFAULTS.front

const PROMPT = (query: string): string =>
  `Search the web for: ${query}\n\nAnswer with the facts the search found, concisely, and name the sources you used. Do not invent anything that the results do not say.`

/**
 * The model of the first enabled OpenRouter connection, or undefined when no connection can
 * search (then `web_search` is not offered at all, see `searchGate`).
 */
export async function searchModel(providers: ProviderService): Promise<LanguageModel | undefined> {
  const profiles = await providers.manager.listProfiles()
  const connection = profiles.find((p) => p.enabled && p.definitionId === 'openrouter')
  if (connection === undefined) return undefined
  return providers.manager.resolve(`${connection.id}:${SEARCH_MODEL}`)
}

/**
 * The person a search call is recorded under when the call has no principal (`aux:web-search:<person>`, ADR-0032 §1). A search run
 * for a person is recorded under that person: eharness 0.13.0 passes the session context to `search` (`options.ctx.principal`).
 */
export const WEB_SEARCH_AUX_PERSON = 'unknown'

/**
 * `web_search` over the OpenRouter `web` plugin: one `generateText` call, no extra key. `observe` wraps the search model so its call
 * is recorded (the activity logs, `observeAux`), under the person who asked (`ctx.principal`, the same person a worker's workspace
 * belongs to) or `WEB_SEARCH_AUX_PERSON` when the search has no principal. The usage and the model returned are the unwrapped ones, as before.
 */
export function createSearch(
  providers: ProviderService,
  observe?: (model: LanguageModel, personId: string) => LanguageModel,
): SearchFn {
  return async (query, { allowedDomains, blockedDomains, signal, ctx } = {}) => {
    const model = await searchModel(providers)
    if (model === undefined) throw new Error('no connection can search the web (add OpenRouter)')
    const asker = ctx?.principal?.id
    const personId = asker === undefined || asker === '' ? WEB_SEARCH_AUX_PERSON : asker
    const result = await generateText({
      model: observe === undefined ? model : observe(model, personId),
      prompt: PROMPT(query),
      ...(signal ? { abortSignal: signal } : {}),
      providerOptions: {
        openrouter: {
          plugins: [
            {
              id: 'web',
              max_results: 5,
              ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
              ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {}),
            },
          ],
        },
      },
    } as never)
    const sources = new Map<string, { url: string; title?: string }>()
    for (const s of result.sources ?? []) {
      const src = s as { sourceType?: string; url?: string; title?: string }
      if (
        (src.sourceType === undefined || src.sourceType === 'url') &&
        typeof src.url === 'string'
      ) {
        sources.set(src.url, { url: src.url, ...(src.title ? { title: src.title } : {}) })
      }
    }
    return { text: result.text, sources: [...sources.values()], usage: result.usage, model }
  }
}
