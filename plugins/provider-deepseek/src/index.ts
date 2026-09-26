/** `@keith/provider-deepseek`: DeepSeek models behind the `LlmProvider` seam. */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { createDeepSeekLlm, DEEPSEEK_BASE_URL } from './provider.ts'

export {
  createDeepSeekLlm,
  DEEPSEEK_BASE_URL,
  type DeepSeekLlmOptions,
  deepSeekThinking,
} from './provider.ts'

export const deepSeekConfig = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.url().default(DEEPSEEK_BASE_URL),
})

export default definePlugin({
  id: '@keith/provider-deepseek',
  namespace: 'deepseek',
  version: '0.0.0',
  kind: 'provider',
  config: deepSeekConfig,
  setup(ctx) {
    ctx.providers.llm.register(createDeepSeekLlm({ apiKey: ctx.config.apiKey, baseUrl: ctx.config.baseUrl }))
  },
})
