import type { Connection, ModelPrice, ModelRoles, ProviderDescription } from '@keith/contracts'
import { G } from '@keith/ui'
import type { ActionSpec, ManageEnv, Row, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'

const MODEL_ROLES = ['front', 'cortex'] as const

interface Loaded {
  connections: Connection[]
  described: ProviderDescription[]
  roles: ModelRoles | undefined
  prices: ModelPrice[]
}

/** A price typed by the owner: a plain decimal of USD per million tokens, 0 to 10000. */
export function parsePrice(text: string): number {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$/.test(t))
    throw new Error('a price is a plain number of USD per million tokens')
  const n = Number(t)
  if (n > 10_000) throw new Error('a price is at most 10000 USD per million tokens')
  return n
}

/** `connection:model` of a bare model id, the way `keith-core model set` resolves it. */
export function modelRef(connection: string, model: string): string {
  return model.startsWith(`${connection}:`) ? model : `${connection}:${model}`
}

/** Providers and models: connections (with `settings.manage`) and the model of each role. */
export function useProviders(env: ManageEnv): SectionData {
  const { client, caps } = env
  const manage = caps.has('settings.manage')
  const load = useLoad<Loaded>(async () => {
    const [connections, described, roles, prices] = await Promise.all([
      manage ? client.rpc.providers.list() : Promise.resolve([]),
      client.rpc.providers.describe(),
      client.rpc.models.roles.get().catch(() => undefined),
      client.rpc.models.price.list().catch(() => []),
    ])
    return { connections, described, roles, prices }
  })
  const data = load.data ?? { connections: [], described: [], roles: undefined, prices: [] }
  const enabled = data.connections.filter((c) => c.enabled).map((c) => c.id)

  const setModel = (role?: (typeof MODEL_ROLES)[number]): ActionSpec => ({
    id: 'models.set',
    label: role === undefined ? 'Set a model role' : `Set the ${role} model`,
    hint: 'the model an agent uses',
    fields: [
      {
        id: 'role',
        label: 'Role',
        options: MODEL_ROLES,
        ...(role === undefined ? {} : { initial: role }),
      },
      { id: 'connection', label: 'Connection', options: enabled.length === 0 ? [''] : enabled },
      { id: 'model', label: 'Model', placeholder: 'model id' },
    ],
    run: async (v) => {
      const connection = v.connection ?? ''
      if (connection === '') throw new Error('add a connection first')
      const picked = v.role === 'cortex' ? 'cortex' : 'front'
      const ref = modelRef(connection, (v.model ?? '').trim())
      const roles = await client.rpc.models.roles.set({ role: picked, ref })
      return { message: `${picked}: ${roles[picked]}` }
    },
  })

  const priceSet = (ref: string): ActionSpec => ({
    id: 'models.price.set',
    label: 'Set a manual price',
    hint: 'USD per million tokens; the spend is then counted',
    fields: [
      { id: 'in', label: 'Input', placeholder: 'USD per million tokens, e.g. 1.5' },
      { id: 'out', label: 'Output', placeholder: 'USD per million tokens, e.g. 6' },
    ],
    run: async (v) => {
      const saved = await client.rpc.models.price.set({
        ref,
        inputPerMTokUsd: parsePrice(v.in ?? ''),
        outputPerMTokUsd: parsePrice(v.out ?? ''),
      })
      return { message: `${saved.ref}: price set by hand` }
    },
  })
  const priceClear = (ref: string): ActionSpec => ({
    id: 'models.price.clear',
    label: 'Clear the manual price',
    hint: 'the catalog price applies again',
    run: async () => {
      await client.rpc.models.price.clear({ ref })
      return { message: `${ref}: manual price removed` }
    },
  })
  const rows: Row[] = MODEL_ROLES.map((role) => {
    const ref = data.roles?.[role] ?? undefined
    const manual = ref === undefined ? undefined : data.prices.find((p) => p.ref === ref)
    const value = ref ?? `${G.warn} (not set)`
    return {
      id: `role:${role}`,
      cells: ['model', role, manual === undefined ? value : `${value} · price: manual`],
      ...(ref ? {} : { tone: 'warning' as const }),
      actions: manage
        ? [
            setModel(role),
            ...(ref === undefined ? [] : [priceSet(ref)]),
            ...(manual === undefined || ref === undefined ? [] : [priceClear(ref)]),
          ]
        : [],
    }
  })
  for (const c of data.connections) {
    rows.push({
      id: `conn:${c.id}`,
      cells: [
        'connection',
        c.id,
        `${c.enabled ? G.dot : G.idle} ${c.providerId} · ${c.source} · ${c.enabled ? 'enabled' : 'disabled'}`,
      ],
      ...(c.enabled ? {} : { tone: 'muted' as const }),
      actions: [
        {
          id: 'providers.test',
          label: 'Test',
          hint: 'ask the provider',
          run: async () => {
            const r = await client.rpc.providers.test({ id: c.id })
            return {
              message: `${c.id}: ${r.ok ? `ok${r.latencyMs === undefined ? '' : ` (${r.latencyMs} ms)`}` : `failed (${r.message ?? 'no answer'})`}`,
            }
          },
        },
        {
          id: 'providers.remove',
          label: 'Remove',
          confirm: { text: `Remove connection ${c.id}? Its API key is forgotten.` },
          run: async () => {
            await client.rpc.providers.remove({ id: c.id })
            return { message: `${c.id}: removed` }
          },
        },
      ],
    })
  }

  const addConnection: ActionSpec = {
    id: 'providers.add',
    label: 'Add a connection',
    hint: 'with its API key, then test it',
    fields: [
      { id: 'provider', label: 'Provider', options: data.described.map((d) => d.id) },
      { id: 'key', label: 'API key', secret: true, optional: true },
      {
        id: 'id',
        label: 'Connection id',
        optional: true,
        placeholder: 'defaults to the provider',
      },
      { id: 'label', label: 'Label', optional: true },
    ],
    run: async (v) => {
      const providerId = v.provider ?? ''
      const found = data.described.find((d) => d.id === providerId)
      if (found === undefined) throw new Error(`unknown provider ${providerId}`)
      const needsKey = found.fields.some((f) => f.path === 'apiKey' && f.secret)
      const key = v.key ?? ''
      if (needsKey && key === '') throw new Error(`${found.label} needs an API key`)
      const id = (v.id ?? '').trim()
      const label = (v.label ?? '').trim()
      const saved = await client.rpc.providers.put({
        providerId,
        ...(id === '' ? {} : { id }),
        ...(label === '' ? {} : { label }),
        ...(needsKey ? { settings: { apiKey: key } } : {}),
      })
      const test = await client.rpc.providers.test({ id: saved.id })
      return {
        message: `${saved.id}: saved; ${test.ok ? 'connection works' : `connection test failed (${test.message ?? 'no answer'})`}`,
      }
    },
  }
  return {
    lines: [],
    header: ['KIND', 'NAME', 'VALUE'],
    widths: [12, 18],
    rows,
    empty: 'Nothing here.',
    actions: manage && data.described.length > 0 ? [addConnection, setModel()] : [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
