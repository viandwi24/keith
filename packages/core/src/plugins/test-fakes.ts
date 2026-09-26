// In-memory fakes of other lanes' interfaces (server http/ws from P1-C1, the delivery sink from
// P1-G1, the plugin_data repository from P1-B1), built from their types.ts, plus a harness that
// wires the real A1 registries around them. Test support only.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AnyPluginDefinition,
  DeliverySink,
  HttpRegistry,
  PluginDelivery,
  PluginKind,
  WsRegistry,
} from '@keith/sdk'
import { createFakeClock, createMemoryLogger, type FakeClock, type MemoryLogger } from '@keith/sdk/testing'
import { keithPaths, parseConfig } from '../config/index.ts'
import type { KeithConfig } from '../config/types.ts'
import { createEventBus } from '../events/index.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { PluginDataRepository } from '../storage/types.ts'
import { createAgentRegistry } from './agents.ts'
import { createPluginDataStores } from './data.ts'
import { createPluginHost, type PluginImporter } from './host.ts'
import { createProviderRegistries } from './providers.ts'
import { createServiceRegistry } from './services.ts'
import { createSkillRegistry } from './skills.ts'
import { createToolRegistry } from './tools.ts'
import type { PluginHost, PluginHostDeps, PluginOwner, PluginScoped } from './types.ts'

export function createMemoryPluginDataRepository(): PluginDataRepository & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  const k = (pluginId: string, key: string) => `${pluginId}\u0000${key}`
  return {
    rows,
    async get(pluginId, key) {
      return rows.has(k(pluginId, key)) ? rows.get(k(pluginId, key)) : null
    },
    async set(pluginId, key, value) {
      rows.set(k(pluginId, key), value)
    },
    async delete(pluginId, key) {
      rows.delete(k(pluginId, key))
    },
    async list(pluginId, prefix = '') {
      const start = k(pluginId, prefix)
      return [...rows.keys()]
        .filter((r) => r.startsWith(start))
        .map((r) => r.slice(pluginId.length + 1))
        .sort()
    },
  }
}

type Owned<T> = { pluginId: string; value: T }

/** A scoped fake that records what each plugin registered and drops it on `removeByPlugin`. */
function recorder<TView, TItem>(make: (owner: PluginOwner, push: (item: TItem) => void) => TView) {
  const items: Owned<TItem>[] = []
  const scoped: PluginScoped<TView> & { items: Owned<TItem>[] } = {
    items,
    forPlugin: (owner) => make(owner, (value) => items.push({ pluginId: owner.pluginId, value })),
    removeByPlugin(pluginId) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i]?.pluginId === pluginId) items.splice(i, 1)
    },
  }
  return scoped
}

export function createFakeHttp() {
  return recorder<HttpRegistry, { method: string; path: string }>((_owner, push) => ({
    route(method, path) {
      push({ method, path })
    },
    static(mountPath) {
      push({ method: 'STATIC', path: mountPath })
    },
  }))
}

export function createFakeWs() {
  return recorder<WsRegistry, string>((_owner, push) => ({
    handle(type) {
      push(type)
    },
  }))
}

export function createFakeDeliveries() {
  return recorder<DeliverySink, PluginDelivery>((_owner, push) => ({
    enqueue(d) {
      push(d)
      return Promise.resolve({ deliveryId: 'dlv_01J8ZQ3K4M5N6P7Q8R9S0T1V31' })
    },
  }))
}

export type Harness = {
  host: PluginHost
  deps: PluginHostDeps
  config: KeithConfig
  log: MemoryLogger
  clock: FakeClock
  events: CoreEventBus
  http: ReturnType<typeof createFakeHttp>
  ws: ReturnType<typeof createFakeWs>
  deliveries: ReturnType<typeof createFakeDeliveries>
  repo: ReturnType<typeof createMemoryPluginDataRepository>
  home: string
  cleanup(): Promise<void>
}

export type HarnessOptions = {
  /** Raw config table (as parsed from TOML). Models default to the fake LLM provider. */
  config?: Record<string, unknown> | undefined
  importModule?: PluginImporter | undefined
}

/** Real A1 registries + fakes for other lanes, in a temp KEITH_HOME. */
export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'keith-host-'))
  const raw = opts.config ?? {}
  const models = { foreground: 'fake:fg-model', background: 'fake:bg-model', utility: 'fake:util' }
  const config = parseConfig(
    { ...raw, models: { ...models, ...(raw.models as Record<string, string> | undefined) } },
    { env: {} },
  )
  const log = createMemoryLogger()
  const clock = createFakeClock(1_000)
  const events = createEventBus({ log, clock })
  const services = createServiceRegistry({ winners: config.services, log })
  const tools = createToolRegistry({ log, clock, services, events })
  const repo = createMemoryPluginDataRepository()
  const http = createFakeHttp()
  const ws = createFakeWs()
  const deliveries = createFakeDeliveries()
  const deps: PluginHostDeps = {
    paths: keithPaths(home),
    log,
    clock,
    events,
    services,
    tools,
    skills: createSkillRegistry(),
    agents: createAgentRegistry({ tools }),
    providers: createProviderRegistries({ models: config.models }),
    http,
    ws,
    deliveries,
    data: createPluginDataStores({ repo, clock }),
  }
  const host = createPluginHost(deps, { importModule: opts.importModule })
  return {
    host,
    deps,
    config,
    log,
    clock,
    events,
    http,
    ws,
    deliveries,
    repo,
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  }
}

/** A minimal plugin definition for tests. */
export function testPlugin(
  namespace: string,
  kind: PluginKind,
  hooks: Partial<Pick<AnyPluginDefinition, 'setup' | 'start' | 'stop' | 'needs' | 'config'>> = {},
): AnyPluginDefinition {
  return {
    id: `@test/${namespace}`,
    namespace,
    version: '1.0.0',
    kind,
    setup: hooks.setup ?? (() => {}),
    ...(hooks.start ? { start: hooks.start } : {}),
    ...(hooks.stop ? { stop: hooks.stop } : {}),
    ...(hooks.needs ? { needs: hooks.needs } : {}),
    ...(hooks.config ? { config: hooks.config } : {}),
  }
}
