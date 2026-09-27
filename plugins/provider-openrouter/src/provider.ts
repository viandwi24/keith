/** The OpenRouter `LlmProvider`: a configuration of the SDK's OpenAI-compatible helper. */
import { createOpenAICompatibleLlm, type LlmProvider, type LlmReasoning } from '@keith/sdk'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type OpenRouterLlmOptions = {
  apiKey: string
  /** Sent as `X-OpenRouter-Title` (app attribution). */
  appTitle?: string | undefined
  /** Sent as `HTTP-Referer` (app attribution; required by OpenRouter to create an app page). */
  siteUrl?: string | undefined
  baseUrl?: string | undefined
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

/** OpenRouter's unified `reasoning` request object (`effort: 'none'` turns reasoning off). */
export function openRouterReasoning(reasoning: LlmReasoning): { effort: 'none' | 'low' | 'medium' | 'high' } {
  return { effort: reasoning === 'off' ? 'none' : reasoning }
}

export function createOpenRouterLlm(opts: OpenRouterLlmOptions): LlmProvider {
  const headers: Record<string, string> = {}
  if (opts.siteUrl) headers['HTTP-Referer'] = opts.siteUrl
  if (opts.appTitle) headers['X-OpenRouter-Title'] = opts.appTitle
  return createOpenAICompatibleLlm({
    id: 'openrouter',
    baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL,
    apiKey: opts.apiKey,
    headers,
    fetch: opts.fetch,
    mapRequest: (body, req) =>
      req.reasoning ? { ...body, reasoning: openRouterReasoning(req.reasoning) } : body,
  })
}
