// Local on purpose: eharness (0.14.1) ships no DeepSeek built-in, so Keith defines it with the public
// `defineProvider` and the official `@ai-sdk/deepseek` (ADR-0007; gaps stay out of node_modules).
import { createDeepSeek } from '@ai-sdk/deepseek'
import type { LanguageModel } from 'ai'
import {
  defineProvider,
  ehMeta,
  type ListedModel,
  type ProviderContext,
  type ProviderDefinition,
} from 'eharness/providers'
import { z } from 'zod/v4'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const settings = z.object({
  apiKey: z
    .string()
    .min(1)
    .meta({
      title: 'API key',
      description: 'Stored encrypted by the app; never shown again after saving.',
      ...ehMeta({
        secret: true,
        group: 'auth',
        widget: 'password',
        envHint: 'DEEPSEEK_API_KEY',
        placeholder: 'sk-...',
      }),
    }),
  baseURL: z
    .url()
    .default(DEEPSEEK_BASE_URL)
    .meta({
      title: 'Base URL',
      description: 'Override the API endpoint (proxy, gateway, self-hosted).',
      ...ehMeta({
        group: 'endpoint',
        placeholder: DEEPSEEK_BASE_URL,
        envHint: 'DEEPSEEK_BASE_URL',
      }),
    }),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .meta({
      title: 'Extra headers',
      description: 'Sent with every request. Values are treated as secrets.',
      ...ehMeta({ group: 'advanced', widget: 'keyvalue', secretValues: true }),
    }),
})

type DeepSeekSettings = z.output<typeof settings>

/** `GET <baseURL>/models` with the injected fetch: `{ data: [{ id }] }`. */
async function listModels(s: DeepSeekSettings, ctx: ProviderContext): Promise<ListedModel[]> {
  const url = `${s.baseURL.replace(/\/+$/, '')}/models`
  const response = await ctx.fetch(url, {
    headers: { authorization: `Bearer ${s.apiKey}`, ...s.headers },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${new URL(url).origin}`)
  }
  const list = ((await response.json()) as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return []
  const out: ListedModel[] = []
  for (const item of list as Array<{ id?: unknown } | null>) {
    if (typeof item?.id === 'string' && item.id !== '') out.push({ id: item.id, name: item.id })
  }
  return out
}

/** DeepSeek (official AI SDK provider). */
export function deepSeekProvider(): ProviderDefinition {
  return defineProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    doc: 'https://api-docs.deepseek.com',
    settings,
    envMap: { apiKey: 'DEEPSEEK_API_KEY', baseURL: 'DEEPSEEK_BASE_URL' },
    catalog: { modelsDevKey: 'deepseek' },
    create: (s) => {
      const provider = createDeepSeek({
        apiKey: s.apiKey,
        baseURL: s.baseURL,
        ...(s.headers ? { headers: s.headers } : {}),
      })
      return { languageModel: (id) => provider(id) as LanguageModel }
    },
    listModels,
    test: async (s, ctx) => {
      const models = await listModels(s, ctx)
      return { ok: true, message: `Connected, ${models.length} models.` }
    },
  })
}
