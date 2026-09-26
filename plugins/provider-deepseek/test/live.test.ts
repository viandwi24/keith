/**
 * Opt-in live smoke test (R-13 exception): `KEITH_LIVE=1 DEEPSEEK_API_KEY=… KEITH_LIVE_DEEPSEEK_MODEL=…
 * bun test live`. Skipped by default and in CI. The model id comes from the environment because
 * ids change often and never live in code.
 */
import { expect, test } from 'bun:test'
import type { LlmEvent } from '@keith/sdk'
import { createDeepSeekLlm } from '../src/index.ts'

const apiKey = process.env.DEEPSEEK_API_KEY
const model = process.env.KEITH_LIVE_DEEPSEEK_MODEL
const live = process.env.KEITH_LIVE === '1' && Boolean(apiKey) && Boolean(model)

test.skipIf(!live)(
  'live: DeepSeek streams a short reply',
  async () => {
    const llm = createDeepSeekLlm({ apiKey: apiKey ?? '' })
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
