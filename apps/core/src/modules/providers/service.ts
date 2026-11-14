import { createOpenAI } from '@ai-sdk/openai'
import type {
  Connection,
  ConnectionInput,
  Model,
  ModelPrice,
  ModelRole,
  ModelRoles,
  PrimaryModelRole,
  ProviderDescription,
} from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { HarnessError, type ModelCatalog } from 'eharness'
import {
  type AnyProviderDefinition,
  type CatalogCache,
  createProviderManager,
  type ManagerCatalogOptions,
  type ModelEntry,
  openAIProvider,
  openRouterProvider,
  type ProfileStore,
  type ProviderManager,
  type PublicProfile,
  type TestResult,
} from 'eharness/providers'
import { deepSeekProvider } from './deepseek.ts'
import {
  type CatalogFn,
  type ManualPrices,
  manualPricesOf,
  withManualPrices,
} from './manual-prices.ts'
import { noModelMessage } from './unconfigured-model.ts'
import type { UnreadableKeys } from './unreadable.ts'

/**
 * Model of each role per provider, used when a role has no pick and the first enabled connection
 * is that provider. Checked on 26 Oct 2026: OpenRouter in its catalog, OpenAI and DeepSeek in
 * https://models.dev/api.json (`front` fast and cheap, `cortex` strong).
 */
export const PROVIDER_DEFAULTS: Record<string, Record<PrimaryModelRole, string>> = {
  openrouter: { front: 'anthropic/claude-haiku-5.5', cortex: 'anthropic/claude-sonnet-5.5' },
  openai: { front: 'gpt-6-luna', cortex: 'gpt-6.1-sol' },
  deepseek: { front: 'deepseek-v4-flash', cortex: 'deepseek-v4-pro' },
}

/** Model of each role on OpenRouter (the default provider). */
export const OPENROUTER_DEFAULTS = PROVIDER_DEFAULTS.openrouter as Record<PrimaryModelRole, string>

const ROLE_KEY = (role: ModelRole) => `model.${role}`

export interface ProviderServiceOptions {
  /** Sealed profile store (`sealedProfileStore` over `sqliteProfileStore`). */
  store: ProfileStore
  settings: SettingsRepo
  cache?: CatalogCache
  /** `OPENROUTER_API_KEY` and friends: read-only env connections. */
  env?: Record<string, string | undefined>
  /** Extra definitions (plugins, tests). OpenRouter is always registered first. */
  definitions?: AnyProviderDefinition[]
  catalogs?: ManagerCatalogOptions
  fetch?: typeof fetch
  warn?: (message: string) => void
  /** Tracker given to the sealed store: its ids are listed as `needsReentry`. */
  unreadable?: UnreadableKeys
}

export interface ProviderService {
  manager: ProviderManager
  ready(): Promise<void>
  describe(): Promise<ProviderDescription[]>
  list(): Promise<Connection[]>
  put(input: ConnectionInput): Promise<Connection>
  remove(id: string): Promise<void>
  test(id: string): Promise<TestResult>
  models(id: string, refresh?: boolean): Promise<Model[]>
  roles(): Promise<ModelRoles>
  setRole(role: ModelRole, ref: string): Promise<ModelRoles>
  /** The model of a role for the next turn. Throws a readable error when none is configured. */
  resolveRole(role: ModelRole): Promise<LanguageModel>
  /** Prices and context windows of the models this service made (agent `models` option). */
  catalog(): ModelCatalog
  /**
   * The model picked for `role` and whether the catalog prices it (`pricing` known, a free model counts). An
   * unpriced model costs 0 in the budget ledger, so guest mode refuses it (`guests.md`). Never throws.
   */
  rolePricing(role: ModelRole): Promise<{ ref: string | null; priced: boolean }>
  /** Manual prices the owner set, by model ref (ADR-0027 §23). */
  prices(): ModelPrice[]
  /** Set the manual price of a model of a known connection; it replaces the catalog price. */
  setPrice(price: ModelPrice): Promise<ModelPrice>
  /** Remove a manual price; false when there was none. */
  clearPrice(ref: string): boolean
}

export function toConnection(p: PublicProfile): Connection {
  return {
    id: p.id,
    providerId: p.definitionId,
    label: p.label,
    enabled: p.enabled,
    source: p.source ?? 'store',
    settings: p.settings,
    updatedAt: p.updatedAt,
  }
}

function toModel(m: ModelEntry): Model {
  return {
    id: m.id,
    name: m.name,
    ...(m.description === undefined ? {} : { description: m.description }),
    ...(m.info?.contextWindow === undefined ? {} : { contextWindow: m.info.contextWindow }),
    ...(m.tools === undefined ? {} : { tools: m.tools }),
    ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
    ...(m.info?.pricing === undefined
      ? {}
      : { inputPrice: m.info.pricing.input, outputPrice: m.info.pricing.output }),
  }
}

/** The provider registry of Keith (ADR-0007) on top of `eharness/providers`. */
export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const definitions: AnyProviderDefinition[] = [
    openRouterProvider({ createOpenRouter }),
    openAIProvider({ createOpenAI }),
    deepSeekProvider(),
    ...(options.definitions ?? []),
  ]
  const manager = createProviderManager({
    definitions,
    store: options.store,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.catalogs === undefined ? {} : { catalogs: options.catalogs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    env: options.env ?? {},
    onWarning: (message) => options.warn?.(message),
  })
  const defaultsOf = new Map(definitions.map((d) => [d.id, d.defaultModel]))
  const manual: ManualPrices = manualPricesOf(options.settings)
  /** The ref of each model object the service resolved (the catalog looks prices up by object). */
  const refs = new WeakMap<object, string>()
  const resolved = (ref: string): LanguageModel => {
    const model = manager.resolve(ref)
    refs.set(model as object, ref)
    return model
  }

  /** The stored pick, else a default on the first enabled connection. */
  async function roleRef(role: ModelRole): Promise<string | null> {
    const stored = options.settings.get<string>(ROLE_KEY(role))
    if (stored !== undefined) return stored
    // `guest` has no default: guests stay off until the owner picks a model (ADR-0017)
    if (role === 'guest') return null
    const first = (await manager.listProfiles()).find((p) => p.enabled)
    if (first === undefined) return null
    const model =
      PROVIDER_DEFAULTS[first.definitionId]?.[role] ?? defaultsOf.get(first.definitionId)
    return model === undefined ? null : `${first.id}:${model}`
  }

  async function roles(): Promise<ModelRoles> {
    return {
      front: await roleRef('front'),
      cortex: await roleRef('cortex'),
      guest: await roleRef('guest'),
    }
  }

  return {
    manager,
    async ready() {
      await manager.ready()
      // catalogs are best effort: a failed download only means fewer prices
      await manager.loadCatalogs().catch(() => undefined)
    },
    async describe() {
      const { providers } = await manager.describe()
      return providers.map((p) => ({
        id: p.id,
        label: p.label,
        ...(p.doc === undefined ? {} : { doc: p.doc }),
        ...(p.defaultModel === undefined ? {} : { defaultModel: p.defaultModel }),
        fields: p.form.fields,
        canListModels: p.canListModels,
        canTest: p.canTest,
      })) as ProviderDescription[]
    },
    async list() {
      const listed = (await manager.listProfiles()).map(toConnection)
      const known = new Set(listed.map((c) => c.id))
      // a stored connection the secret key cannot open: shown disabled, to be re-entered
      const lost = (options.unreadable?.ids() ?? [])
        .filter((id) => !known.has(id))
        .map<Connection>((id) => ({
          id,
          providerId: id,
          label: id,
          enabled: false,
          source: 'store',
          settings: {},
          updatedAt: 0,
          needsReentry: true,
        }))
      return [...listed, ...lost]
    },
    async put(input) {
      // the contract allows `undefined` values; the manager wants absent keys
      const profile = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ) as Parameters<ProviderManager['putProfile']>[0]
      const saved = toConnection(await manager.putProfile(profile))
      options.unreadable?.forget(saved.id)
      return saved
    },
    async remove(id) {
      await manager.deleteProfile(id)
      options.unreadable?.forget(id)
      for (const role of ['front', 'cortex', 'guest'] as const) {
        if (options.settings.get<string>(ROLE_KEY(role))?.startsWith(`${id}:`)) {
          options.settings.delete(ROLE_KEY(role))
        }
      }
    },
    test: (id) => manager.test(id),
    async models(id, refresh) {
      return (await manager.models(id, { refresh: refresh === true })).map(toModel)
    },
    roles,
    async setRole(role, ref) {
      manager.resolve(ref) // throws EH_CONFIG_INVALID for an unknown connection or model
      options.settings.set(ROLE_KEY(role), ref)
      return roles()
    },
    async resolveRole(role) {
      const ref = await roleRef(role)
      if (ref === null) {
        throw new HarnessError('EH_CONFIG_INVALID', noModelMessage(role))
      }
      return resolved(ref)
    },
    catalog: () => {
      const base = manager.catalog()
      const fn: CatalogFn = typeof base === 'function' ? base : () => undefined
      return withManualPrices(fn, manual, (model) => refs.get(model as object))
    },
    prices: () => manual.list(),
    async setPrice(price) {
      const id = price.ref.slice(0, price.ref.indexOf(':'))
      if (!(await manager.listProfiles()).some((p) => p.id === id))
        throw new HarnessError('EH_CONFIG_INVALID', `no connection ${id}: keith-core provider add`)
      manual.set(price)
      return price
    },
    clearPrice: (ref) => manual.clear(ref),
    async rolePricing(role) {
      const ref = await roleRef(role)
      if (ref === null) return { ref: null, priced: false }
      if (manual.get(ref) !== undefined) return { ref, priced: true }
      try {
        const split = ref.indexOf(':')
        const listed = (await manager.models(ref.slice(0, split))).find(
          (m) => m.id === ref.slice(split + 1),
        )
        if (listed?.info?.pricing !== undefined) return { ref, priced: true }
        const catalog = manager.catalog()
        const info = typeof catalog === 'function' ? catalog(manager.resolve(ref)) : undefined
        return { ref, priced: info?.pricing !== undefined }
      } catch {
        return { ref, priced: false }
      }
    },
  }
}
