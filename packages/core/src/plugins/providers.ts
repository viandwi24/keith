import {
  KeithError,
  type LlmProvider,
  type ProviderRegistries,
  type SttProvider,
  type TtsProvider,
  type VadProvider,
} from '@keith/sdk'
import type { ModelRef } from '../config/types.ts'
import type { ModelRole } from '../shared/types.ts'
import type { CoreProviderRegistries, PluginOwner, ResolvedLlm } from './types.ts'

export type ProviderRegistriesDeps = {
  /** `config.models`. */
  models: Record<ModelRole, ModelRef>
}

/** Splits `<providerId>:<modelId>` at the first `:`. */
export function parseModelRef(ref: string): { providerId: string; model: string } {
  const colon = ref.indexOf(':')
  if (colon <= 0 || colon === ref.length - 1) {
    throw new KeithError('CONFIG_INVALID', `invalid model ref '${ref}': expected '<providerId>:<modelId>'`, {
      details: { ref },
    })
  }
  return { providerId: ref.slice(0, colon), model: ref.slice(colon + 1) }
}

type Registered<P> = { provider: P; pluginId: string }

function createList<P extends { id: string }>(kind: string) {
  const items = new Map<string, Registered<P>>()
  return {
    items,
    register(provider: P, pluginId: string) {
      const existing = items.get(provider.id)
      if (existing) {
        throw new KeithError(
          'SERVICE_CONFLICT',
          `${kind} provider '${provider.id}' is already registered by ${existing.pluginId}`,
          { details: { providerId: provider.id, pluginId, existing: existing.pluginId } },
        )
      }
      items.set(provider.id, { provider, pluginId })
    },
    remove(pluginId: string) {
      for (const [id, entry] of items) if (entry.pluginId === pluginId) items.delete(id)
    },
    list(): P[] {
      return [...items.values()].map((e) => e.provider)
    },
  }
}

/**
 * Provider registries (LLM now, voice in phase 3). Two providers with the same id are a
 * `SERVICE_CONFLICT`. `llm.resolve(role)` maps a role to a provider through `config.models`.
 */
export function createProviderRegistries(deps: ProviderRegistriesDeps): CoreProviderRegistries {
  const llm = createList<LlmProvider>('llm')
  const stt = createList<SttProvider>('stt')
  const tts = createList<TtsProvider>('tts')
  const vad = createList<VadProvider>('vad')
  const all = [llm, stt, tts, vad]

  return {
    forPlugin(owner: PluginOwner): ProviderRegistries {
      return {
        llm: { register: (p) => llm.register(p, owner.pluginId) },
        stt: { register: (p) => stt.register(p, owner.pluginId) },
        tts: { register: (p) => tts.register(p, owner.pluginId) },
        vad: { register: (p) => vad.register(p, owner.pluginId) },
      }
    },
    removeByPlugin(pluginId) {
      for (const list of all) list.remove(pluginId)
    },
    llm: {
      resolve(role): ResolvedLlm {
        const ref = deps.models[role]
        const { providerId, model } = parseModelRef(ref)
        const entry = llm.items.get(providerId)
        if (!entry) {
          const known = [...llm.items.keys()]
          throw new KeithError(
            'CONFIG_INVALID',
            `models.${role} = '${ref}' names the unknown provider '${providerId}' (registered: ${known.length > 0 ? known.join(', ') : 'none'})`,
            { details: { role, ref, providerId } },
          )
        }
        return { provider: entry.provider, model, ref }
      },
      get: (id) => llm.items.get(id)?.provider,
      list: () => llm.list(),
    },
    stt: { list: () => stt.list() },
    tts: { list: () => tts.list() },
    vad: { list: () => vad.list() },
  }
}
