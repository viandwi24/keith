import type { KeithClient } from '@keith/client'
import type { PluginInfo, PluginToggle } from '@keith/contracts'
import { detailNote, wantsOn } from './plugins-state.ts'
import type { ActionSpec } from './types.ts'

const message = (done: PluginToggle, verb: string): string =>
  `${done.plugin.id}: ${verb}${done.plugin.restartPending ? '; takes effect when the core restarts' : ''}`

/** Every action on one plugin; each is one `client.rpc.admin.plugins.*` call, as `keith-core plugin` makes. */
export function pluginActions(client: KeithClient, p: PluginInfo): ActionSpec[] {
  const api = client.rpc.admin.plugins
  const actions: ActionSpec[] = [
    {
      id: 'plugins.show',
      label: 'Show details',
      hint: 'capabilities, operations, timers',
      run: async () => ({ note: detailNote(await api.show({ id: p.id })) }),
    },
  ]
  if (p.state === 'failed') return actions
  actions.push(
    wantsOn(p)
      ? {
          id: 'plugins.disable',
          label: 'Disable',
          hint: 'applies at the next boot',
          confirm: {
            text: `Disable ${p.id}? Its tools and routes go away when the core restarts. Its data is kept.`,
          },
          run: async () => ({ message: message(await api.disable({ id: p.id }), 'disabled') }),
        }
      : {
          id: 'plugins.enable',
          label: 'Enable',
          hint: 'applies at the next boot',
          confirm: { text: `Enable ${p.id}? It loads when the core restarts.` },
          run: async () => ({ message: message(await api.enable({ id: p.id }), 'enabled') }),
        },
  )
  return actions
}
