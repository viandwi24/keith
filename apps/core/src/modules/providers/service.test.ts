import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, settingsRepo, sqliteProfileStore } from '@keith/db'
import { sealedProfileStore } from 'eharness/providers'
import { scriptedProvider } from 'eharness/testing'
import { createVault, generateSecretKey } from '../../platform/vault.ts'
import { searchModel } from '../cortex/index.ts'
import { createProviderService, type ProviderServiceOptions } from './service.ts'

// built at runtime: a key-shaped literal in the source would (rightly) trip gitleaks
const KEY = ['sk', 'test', crypto.randomUUID().replaceAll('-', '')].join('-')
const HINT = `…${KEY.slice(-4)}`

async function setup(extra: Partial<ProviderServiceOptions> = {}) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const { vault } = createVault(generateSecretKey(), '/unused')
  const service = createProviderService({
    store: sealedProfileStore({ inner: sqliteProfileStore(sqlite), vault }),
    settings: settingsRepo(sqlite),
    definitions: [
      scriptedProvider({ models: { a: [{ text: 'from a' }], b: [{ text: 'from b' }] } }),
    ],
    catalogs: { offline: true },
    ...extra,
  })
  await service.ready()
  return { sqlite, service }
}

describe('provider service', () => {
  test('OpenRouter is registered first, with a secret API key field', async () => {
    const { service } = await setup()
    const [first] = await service.describe()
    expect(first?.id).toBe('openrouter')
    expect(first?.fields.find((f) => f.path === 'apiKey')?.secret).toBe(true)
  })

  test('a connection never returns or stores the key in clear', async () => {
    const { sqlite, service } = await setup()
    const created = await service.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    expect(created.settings.apiKey).toEqual({ set: true, hint: HINT })
    expect(JSON.stringify(await service.list())).not.toContain(KEY)
    const row = sqlite
      .query<{ settings: string }, []>(
        "SELECT settings FROM config_profiles WHERE id = 'openrouter'",
      )
      .get()
    expect(row?.settings).not.toContain(KEY)
    expect(row?.settings).toContain('~sealed')
  })

  test('changing the base URL drops the stored key (it must be resent)', async () => {
    const { service } = await setup()
    await service.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    await expect(
      service.put({ id: 'openrouter', settings: { baseURL: 'https://evil.example/api/v1' } }),
    ).rejects.toThrow(/apiKey/)
    const edited = await service.put({ id: 'openrouter', label: 'Main' })
    expect(edited.settings.apiKey).toEqual({ set: true, hint: HINT })
  })

  test('roles default to OpenRouter models on the first connection', async () => {
    const { service } = await setup()
    expect(await service.roles()).toEqual({ front: null, cortex: null, guest: null })
    await expect(service.resolveRole('front')).rejects.toThrow('/connect')
    await service.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    expect(await service.roles()).toEqual({
      front: 'openrouter:anthropic/claude-haiku-5.5',
      cortex: 'openrouter:anthropic/claude-sonnet-5.5',
      guest: null,
    })
  })

  test('a picked model is resolved on every call; unknown refs are refused', async () => {
    const { service } = await setup()
    await service.put({ providerId: 'scripted' })
    await service.setRole('front', 'scripted:a')
    expect((await service.resolveRole('front')) as { modelId: string }).toMatchObject({
      modelId: 'a',
    })
    await service.setRole('front', 'scripted:b')
    expect((await service.resolveRole('front')) as { modelId: string }).toMatchObject({
      modelId: 'b',
    })
    await expect(service.setRole('front', 'missing:x')).rejects.toThrow()
  })

  test('removing a connection clears the roles that used it', async () => {
    const { service } = await setup()
    await service.put({ providerId: 'scripted' })
    await service.setRole('cortex', 'scripted:a')
    await service.remove('scripted')
    expect((await service.roles()).cortex).toBeNull()
  })

  test('describe lists OpenRouter, OpenAI and DeepSeek first, each with a secret API key', async () => {
    const { service } = await setup()
    const described = await service.describe()
    expect(described.slice(0, 3).map((p) => p.id)).toEqual(['openrouter', 'openai', 'deepseek'])
    for (const p of described.slice(0, 3)) {
      expect(p.fields.find((f) => f.path === 'apiKey')?.secret).toBe(true)
    }
  })

  test('a DeepSeek connection never returns or stores the key in clear', async () => {
    const { sqlite, service } = await setup()
    const created = await service.put({ providerId: 'deepseek', settings: { apiKey: KEY } })
    expect(created.settings.apiKey).toEqual({ set: true, hint: HINT })
    expect(JSON.stringify(await service.list())).not.toContain(KEY)
    const row = sqlite
      .query<{ settings: string }, []>("SELECT settings FROM config_profiles WHERE id = 'deepseek'")
      .get()
    expect(row?.settings).not.toContain(KEY)
    expect(row?.settings).toContain('~sealed')
  })

  test('DeepSeek lists models from GET /models with a Bearer key', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fake = (async (input: Request | string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return Response.json({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] })
    }) as typeof fetch
    const { service } = await setup({ fetch: fake })
    await service.put({ providerId: 'deepseek', settings: { apiKey: KEY } })
    const models = await service.models('deepseek', true)
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(seen[0]).toEqual({ url: 'https://api.deepseek.com/models', auth: `Bearer ${KEY}` })
    expect((await service.test('deepseek')).ok).toBe(true)
  })

  test('OPENAI_API_KEY and DEEPSEEK_API_KEY become read-only env connections', async () => {
    const { service } = await setup({ env: { OPENAI_API_KEY: KEY, DEEPSEEK_API_KEY: KEY } })
    const list = await service.list()
    expect(list.map((c) => [c.providerId, c.source]).sort()).toEqual([
      ['deepseek', 'env'],
      ['openai', 'env'],
    ])
    expect(JSON.stringify(list)).not.toContain(KEY)
  })

  test('role defaults follow the provider of the first enabled connection', async () => {
    const openai = await setup()
    await openai.service.put({ providerId: 'openai', settings: { apiKey: KEY } })
    expect(await openai.service.roles()).toEqual({
      front: 'openai:gpt-6-luna',
      cortex: 'openai:gpt-6.1-sol',
      guest: null,
    })
    const deepseek = await setup()
    await deepseek.service.put({ providerId: 'deepseek', settings: { apiKey: KEY } })
    expect(await deepseek.service.roles()).toEqual({
      front: 'deepseek:deepseek-v4-flash',
      cortex: 'deepseek:deepseek-v4-pro',
      guest: null,
    })
  })

  test('resolve("deepseek:<model>") returns a DeepSeek model', async () => {
    const { service } = await setup()
    await service.put({ providerId: 'deepseek', settings: { apiKey: KEY } })
    const model = service.manager.resolve('deepseek:deepseek-v4-flash') as {
      provider: string
      modelId: string
    }
    expect(model.modelId).toBe('deepseek-v4-flash')
    expect(model.provider).toContain('deepseek')
  })

  test('web search is offered only through OpenRouter', async () => {
    const other = await setup()
    await other.service.put({ providerId: 'openai', settings: { apiKey: KEY } })
    await other.service.put({ providerId: 'deepseek', settings: { apiKey: KEY } })
    expect(await searchModel(other.service)).toBeUndefined()
    const router = await setup()
    await router.service.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    expect(await searchModel(router.service)).toBeDefined()
  })
})

describe('role pricing', () => {
  test('a role with no pick is unpriced; the guest role has no default even with a connection', async () => {
    const { service } = await setup()
    expect(await service.rolePricing('guest')).toEqual({ ref: null, priced: false })
    await service.put({ providerId: 'openrouter', settings: { apiKey: KEY } })
    expect(await service.rolePricing('guest')).toEqual({ ref: null, priced: false })
  })

  test('a model without prices is unpriced, one with prices is priced', async () => {
    const { service } = await setup({
      definitions: [
        scriptedProvider({
          models: { cheap: [{ text: 'x' }], blind: [{ text: 'y' }] },
          info: { cheap: { pricing: { input: 0.1, output: 0.4 } } },
        }),
      ],
    })
    await service.put({ providerId: 'scripted' })
    await service.setRole('guest', 'scripted:blind')
    expect(await service.rolePricing('guest')).toEqual({ ref: 'scripted:blind', priced: false })
    await service.setRole('guest', 'scripted:cheap')
    expect(await service.rolePricing('guest')).toEqual({ ref: 'scripted:cheap', priced: true })
  })
})

describe('manual model prices (P24.4.4, ADR-0027 §23)', () => {
  const priceOf = (service: Awaited<ReturnType<typeof setup>>['service'], model: unknown) =>
    (
      service.catalog() as (
        m: unknown,
      ) => { pricing?: { input: number; output: number } } | undefined
    )(model)?.pricing

  test('a manual price makes an unpriced guest model priced, in the catalog too, until it is cleared', async () => {
    const { service } = await setup({
      definitions: [scriptedProvider({ models: { blind: [{ text: 'y' }] } })],
    })
    await service.put({ providerId: 'scripted' })
    await service.setRole('guest', 'scripted:blind')
    expect(await service.rolePricing('guest')).toEqual({ ref: 'scripted:blind', priced: false })

    await service.setPrice({ ref: 'scripted:blind', inputPerMTokUsd: 1, outputPerMTokUsd: 2 })
    expect(service.prices()).toEqual([
      { ref: 'scripted:blind', inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    ])
    expect(await service.rolePricing('guest')).toEqual({ ref: 'scripted:blind', priced: true })
    const model = await service.resolveRole('guest')
    expect(priceOf(service, model)).toEqual({ input: 1, output: 2 })

    expect(service.clearPrice('scripted:blind')).toBe(true)
    expect(service.clearPrice('scripted:blind')).toBe(false)
    expect(service.prices()).toEqual([])
    expect(await service.rolePricing('guest')).toEqual({ ref: 'scripted:blind', priced: false })
    expect(priceOf(service, await service.resolveRole('guest'))).toBeUndefined()
  })

  test('a price for a connection that does not exist is refused', async () => {
    const { service } = await setup()
    await expect(
      service.setPrice({ ref: 'nowhere:model', inputPerMTokUsd: 1, outputPerMTokUsd: 1 }),
    ).rejects.toThrow(/no connection nowhere/)
  })
})
