/**
 * Opt-in live smoke test (R-13 exception): `KEITH_LIVE=1 OPENROUTER_API_KEY=… KEITH_LIVE_OPENROUTER_MODEL=…
 * bun test live`. Skipped by default and in CI. The model id comes from the environment because
 * ids change often and never live in code.
 */
import { expect, test } from 'bun:test'
import type { LlmEvent } from '@keith/sdk'
import { createOpenRouterLlm } from '../src/index.ts'

const apiKey = process.env.OPENROUTER_API_KEY
const model = process.env.KEITH_LIVE_OPENROUTER_MODEL
const live = process.env.KEITH_LIVE === '1' && Boolean(apiKey) && Boolean(model)

test.skipIf(!live)(
  'live: OpenRouter streams a short reply',
  async () => {
    const llm = createOpenRouterLlm({ apiKey: apiKey ?? '', appTitle: 'Keith (live test)' })
    const events: LlmEvent[] = []
    const signal = AbortSignal.timeout(60_000)
    for await (const e of llm.stream(
      {
        model: model ?? '',
        system: 'Reply with one short sentence.',
        messages: [{ role: 'user', content: 'Say hello.' }],
      },
      signal,
    )) {
      events.push(e)
    }
    const text = events.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('finish')
  },
  90_000,
)
