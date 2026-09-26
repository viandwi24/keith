/** `@keith/provider-openrouter`: any model on OpenRouter behind the `LlmProvider` seam. */
import { definePlugin } from '@keith/sdk'
import { z } from 'zod'
import { createOpenRouterLlm, OPENROUTER_BASE_URL } from './provider.ts'

export {
  createOpenRouterLlm,
  OPENROUTER_BASE_URL,
  type OpenRouterLlmOptions,
  openRouterReasoning,
} from './provider.ts'

export const openRouterConfig = z.object({
  apiKey: z.string().min(1),
  /** App name for OpenRouter attribution. */
  appTitle: z.string().min(1).default('Keith'),
  /** App URL for OpenRouter attribution (`HTTP-Referer`). */
  siteUrl: z.url().optional(),
  baseUrl: z.url().default(OPENROUTER_BASE_URL),
})

export default definePlugin({
  id: '@keith/provider-openrouter',
  namespace: 'openrouter',
  version: '0.0.0',
  kind: 'provider',
  config: openRouterConfig,
  setup(ctx) {
    ctx.providers.llm.register(
      createOpenRouterLlm({
        apiKey: ctx.config.apiKey,
        appTitle: ctx.config.appTitle,
        siteUrl: ctx.config.siteUrl,
        baseUrl: ctx.config.baseUrl,
      }),
    )
  },
})
