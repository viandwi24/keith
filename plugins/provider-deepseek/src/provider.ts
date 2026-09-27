/** The DeepSeek `LlmProvider`: a configuration of the SDK's OpenAI-compatible helper. */
import { createOpenAICompatibleLlm, type LlmProvider, type LlmRequest } from '@keith/sdk'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

export type DeepSeekLlmOptions = {
  apiKey: string
  baseUrl?: string | undefined
  /** Injectable for tests. */
  fetch?: typeof fetch | undefined
}

/**
 * DeepSeek's thinking-mode fields for a request. Thinking is on by default at the vendor, so
 * only an explicit `reasoning` changes it: `off` disables it, `low` maps to effort `low`, and
 * `medium`/`high` to `high` (DeepSeek maps `medium` to `high` anyway).
 *
 * Requests that carry tools always disable thinking: in thinking mode DeepSeek requires every
 * earlier assistant message's `reasoning_content` to be sent back (400 otherwise), and
 * `LlmMessage` has no field for it (see docs/architecture/providers.md).
 */
export function deepSeekThinking(req: LlmRequest): Record<string, unknown> {
  if (req.tools && req.tools.length > 0) return { thinking: { type: 'disabled' } }
  switch (req.reasoning) {
    case undefined:
      return {}
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'low':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
    case 'medium':
    case 'high':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
  }
}

export function createDeepSeekLlm(opts: DeepSeekLlmOptions): LlmProvider {
  return createOpenAICompatibleLlm({
    id: 'deepseek',
    baseUrl: opts.baseUrl ?? DEEPSEEK_BASE_URL,
    apiKey: opts.apiKey,
    fetch: opts.fetch,
    mapRequest: (body, req) => ({ ...body, ...deepSeekThinking(req) }),
  })
}
