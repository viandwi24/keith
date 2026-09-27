import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AnyPluginDefinition,
  isKeithError,
  KeithError,
  KIND_REGISTRIES,
  type KindScopedRegistry,
  MODEL_ROLES,
  PLUGIN_KINDS,
  type PluginContext,
  type ServiceRegistry,
  type WsRegistry,
} from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import { assertInNamespace, assertPluginNamespace } from './namespace.ts'
import type { PluginHost, PluginHostDeps, PluginOwner, PluginState, PluginStatus } from './types.ts'

/** Imports a plugin package by name. Injected in tests; the default is dynamic `import()`. */
export type PluginImporter = (id: string) => Promise<unknown>

export type PluginHostOptions = { importModule?: PluginImporter | undefined }

type Phase = 'setup' | 'running'

type Entry = {
  def: AnyPluginDefinition
  owner: PluginOwner
  ctx: PluginContext<unknown> | null
  phase: Phase
  state: PluginState
  error: PluginStatus['error']
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isPluginDefinition(v: unknown): v is AnyPluginDefinition {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.namespace === 'string' &&
    typeof v.version === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.setup === 'function'
  )
}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  return Promise.race([work.then((value) => ({ timedOut: false as const, value })), timeout]).finally(() =>
    clearTimeout(timer),
  )
}

/**
 * The plugin host (docs/architecture/plugin-system.md). Loads plugins in config order, gives each
 * a `PluginContext` scoped to its id, namespace and kind, and runs `setup` → `start` → `stop`. A
 * failing plugin is rolled back, marked failed and reported as `plugin.failed`; a failing
 * `plugins.required` plugin makes `load` / `startAll` throw.
 */
export function createPluginHost(deps: PluginHostDeps, opts: PluginHostOptions = {}): PluginHost {
  const importModule: PluginImporter = opts.importModule ?? ((id) => import(id))
  const entries: Entry[] = []
  let required = new Set<string>()
  let stopTimeoutMs = 5_000
  let loaded = false

  const rollback = (pluginId: string) => {
    for (const registry of [
      deps.services,
      deps.tools,
      deps.skills,
      deps.agents,
      deps.providers,
      deps.http,
      deps.ws,
      deps.deliveries,
      deps.data,
      deps.events,
    ]) {
      registry.removeByPlugin(pluginId)
    }
  }

  /** Records a failure; rethrows (as a KeithError) when the plugin is required. */
  const fail = (entry: Entry, stage: 'setup' | 'start', error: unknown) => {
    const message = messageOf(error)
    rollback(entry.def.id)
    entry.state = 'failed'
    entry.error = { stage, message }
    deps.log.error('plugin failed', {
      pluginId: entry.def.id,
      stage,
      error: message,
      code: isKeithError(error) ? error.code : undefined,
    })
    deps.events.emit('plugin.failed', { pluginId: entry.def.id, stage, error: message })
    if (required.has(entry.def.id)) {
      throw new KeithError(
        isKeithError(error) ? error.code : 'INTERNAL',
        `required plugin ${entry.def.id} failed in ${stage}: ${message}`,
        { cause: error, details: { pluginId: entry.def.id, stage } },
      )
    }
  }

  const buildContext = (entry: Entry, config: unknown): PluginContext<unknown> => {
    const { owner, def } = entry
    const allowed = new Set<KindScopedRegistry>(KIND_REGISTRIES[def.kind])
    const deny = (registry: KindScopedRegistry) => (): never => {
      throw new KeithError(
        'PLUGIN_KIND_VIOLATION',
        `plugin ${def.id} of kind '${def.kind}' may not use ctx.${registry}`,
        { details: { pluginId: def.id, kind: def.kind, registry } },
      )
    }

    const coreServices = deps.services.forPlugin(owner)
    const notInSetup = (method: string, name: string): never => {
      throw new KeithError(
        'SERVICE_MISSING',
        `plugin ${def.id} called services.${method}('${name}') in setup: services are available from start on`,
        { details: { pluginId: def.id, service: name } },
      )
    }
    const services: ServiceRegistry = {
      provide: (name, impl) => coreServices.provide(name, impl),
      get: (name) => (entry.phase === 'setup' ? notInSetup('get', name) : coreServices.get(name)),
      find: (name) => (entry.phase === 'setup' ? notInSetup('find', name) : coreServices.find(name)),
    }

    let ws: WsRegistry = { handle: deny('ws') }
    if (allowed.has('ws')) {
      const view = deps.ws.forPlugin(owner)
      ws = {
        handle(type, schema, handler) {
          assertInNamespace(type, owner.namespace, 'ws frame type', def.id)
          view.handle(type, schema, handler)
        },
      }
    }

    const dataDir = join(deps.paths.pluginsDir, def.id)
    return {
      plugin: { id: def.id, namespace: def.namespace, version: def.version, kind: def.kind },
      config,
      log: deps.log.child({ pluginId: def.id }),
      events: deps.events.forPlugin(owner),
      services,
      tools: allowed.has('tools') ? deps.tools.forPlugin(owner) : { register: deny('tools') },
      skills: allowed.has('skills') ? deps.skills.forPlugin(owner) : { register: deny('skills') },
      agents: allowed.has('agents') ? deps.agents.forPlugin(owner) : { register: deny('agents') },
      providers: allowed.has('providers')
        ? deps.providers.forPlugin(owner)
        : {
            llm: { register: deny('providers') },
            stt: { register: deny('providers') },
            tts: { register: deny('providers') },
            vad: { register: deny('providers') },
          },
      http: allowed.has('http') ? deps.http.forPlugin(owner) : { route: deny('http'), static: deny('http') },
      ws,
      deliveries: allowed.has('deliveries')
        ? deps.deliveries.forPlugin(owner)
        : { enqueue: deny('deliveries') },
      data: deps.data.forPlugin(owner),
      paths: { data: dataDir },
      clock: deps.clock,
    }
  }

  /** Checks identity, kind, namespace and config; throws the reason the plugin can't be set up. */
  const validate = (def: AnyPluginDefinition, config: KeithConfig): unknown => {
    if (!PLUGIN_KINDS.includes(def.kind)) {
      throw new KeithError('CONFIG_INVALID', `plugin ${def.id} has an unknown kind '${String(def.kind)}'`)
    }
    assertPluginNamespace(def.namespace, def.id)
    const clash = entries.find((e) => e.def.namespace === def.namespace && e.def.id !== def.id)
    if (clash) {
      throw new KeithError(
        'PLUGIN_NAMESPACE_INVALID',
        `plugin ${def.id} uses namespace '${def.namespace}', already taken by ${clash.def.id}`,
        { details: { pluginId: def.id, namespace: def.namespace, other: clash.def.id } },
      )
    }
    if (!def.config) return {}
    const parsed = def.config.safeParse(config.plugins.sections[def.id] ?? {})
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')
      throw new KeithError('CONFIG_INVALID', `config for plugin ${def.id} is invalid: ${issues}`, {
        cause: parsed.error,
        details: { pluginId: def.id },
      })
    }
    return parsed.data
  }

  const setUp = async (def: AnyPluginDefinition, config: KeithConfig) => {
    const owner: PluginOwner = { pluginId: def.id, namespace: def.namespace, kind: def.kind }
    const entry: Entry = { def, owner, ctx: null, phase: 'setup', state: 'set_up', error: undefined }
    entries.push(entry)
    try {
      const pluginConfig = validate(def, config)
      const ctx = buildContext(entry, pluginConfig)
      entry.ctx = ctx
      await mkdir(ctx.paths.data, { recursive: true })
      await def.setup(ctx)
      deps.log.info('plugin set up', { pluginId: def.id, version: def.version })
    } catch (error) {
      fail(entry, 'setup', error)
    }
  }

  return {
    async load(config, extra = []) {
      if (loaded) throw new KeithError('INTERNAL', 'plugins are already loaded')
      loaded = true
      required = new Set(config.plugins.required)
      stopTimeoutMs = config.plugins.stopTimeoutMs

      const known = new Set([...config.plugins.enabled, ...extra.map((p) => p.id)])
      for (const id of required) {
        if (!known.has(id)) {
          throw new KeithError('CONFIG_INVALID', `plugins.required lists ${id}, which is not enabled`, {
            details: { pluginId: id },
          })
        }
      }

      const seen = new Set<string>()
      const once = (id: string): boolean => {
        if (seen.has(id)) {
          deps.log.warn('plugin listed twice', { pluginId: id })
          return false
        }
        seen.add(id)
        return true
      }

      for (const id of config.plugins.enabled) {
        if (!once(id)) continue
        let def: AnyPluginDefinition
        try {
          const mod = await importModule(id)
          const candidate = isRecord(mod) ? mod.default : undefined
          if (!isPluginDefinition(candidate)) {
            throw new KeithError('CONFIG_INVALID', `package ${id} has no plugin as its default export`)
          }
          if (candidate.id !== id) {
            throw new KeithError('CONFIG_INVALID', `package ${id} exports plugin id '${candidate.id}'`)
          }
          def = candidate
        } catch (error) {
          deps.log.error('plugin failed', { pluginId: id, stage: 'load', error: messageOf(error) })
          if (required.has(id)) {
            throw new KeithError(
              isKeithError(error) ? error.code : 'CONFIG_INVALID',
              `required plugin ${id} could not be loaded: ${messageOf(error)}`,
              { cause: error, details: { pluginId: id, stage: 'load' } },
            )
          }
          continue
        }
        await setUp(def, config)
      }
      for (const def of extra) {
        if (!once(def.id)) continue
        await setUp(def, config)
      }

      // Every model role must name a registered provider (CONFIG_INVALID otherwise).
      for (const role of MODEL_ROLES) deps.providers.llm.resolve(role)
    },

    async startAll() {
      for (const entry of entries) {
        if (entry.state !== 'set_up' || !entry.ctx) continue
        entry.phase = 'running'
        try {
          const missing = (entry.def.needs ?? []).filter(
            (name) => deps.services.find(name as Parameters<typeof deps.services.find>[0]) === undefined,
          )
          if (missing.length > 0) {
            throw new KeithError(
              'SERVICE_MISSING',
              `plugin ${entry.def.id} needs the service${missing.length > 1 ? 's' : ''} ${missing.map((n) => `'${n}'`).join(', ')}, which no plugin provides`,
              { details: { pluginId: entry.def.id, missing } },
            )
          }
          await entry.def.start?.(entry.ctx)
          entry.state = 'started'
          deps.log.info('plugin started', { pluginId: entry.def.id })
        } catch (error) {
          fail(entry, 'start', error)
        }
      }
    },

    async stopAll() {
      for (const entry of [...entries].reverse()) {
        if (entry.state !== 'started' || !entry.ctx) continue
        const ctx = entry.ctx
        try {
          const result = await withTimeout(
            Promise.resolve().then(() => entry.def.stop?.(ctx)),
            stopTimeoutMs,
          )
          if (result.timedOut) {
            deps.log.warn('plugin stop timed out', { pluginId: entry.def.id, timeoutMs: stopTimeoutMs })
          }
        } catch (error) {
          deps.log.error('plugin stop failed', { pluginId: entry.def.id, error: messageOf(error) })
        }
        entry.state = 'stopped'
      }
    },

    status() {
      return entries.map((e) => ({
        id: e.def.id,
        namespace: e.def.namespace,
        version: e.def.version,
        kind: e.def.kind,
        state: e.state,
        ...(e.error === undefined ? {} : { error: e.error }),
      }))
    },
  }
}
