import type { LanguageModel } from 'ai'

/**
 * OpenRouter's sticky routing (docs/specs/providers.md "Router session"): a request with a `session_id` keeps going to the
 * same upstream provider while the session is active, so a prompt cache written on one provider (Anthropic, Bedrock, Vertex)
 * is read on the next request instead of missing on another. Without it, stickiness starts only after a cache hit.
 * The id is a hash of the eharness session id: OpenRouter gets a stable, opaque value, never a person id.
 */
export function routerSessionOptions(
  sessionId: string,
  model: LanguageModel,
): { openrouter: { session_id: string } } | undefined {
  if (typeof model === 'string' || !model.provider.startsWith('openrouter')) return undefined
  const hash = new Bun.CryptoHasher('sha256')
    .update(`keith-router-session:${sessionId}`)
    .digest('hex')
  return { openrouter: { session_id: hash.slice(0, 32) } }
}
