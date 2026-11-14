import type { ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { pluginActions } from './plugins-actions.ts'
import { PLUGINS_HEADER, PLUGINS_WIDTHS, pluginRow } from './plugins-state.ts'

/** Plugins: the built-in plugins and their status (`admin.plugins.list`); owner only. */
export function usePlugins(env: ManageEnv): SectionData {
  const { client } = env
  const load = useLoad(() => client.rpc.admin.plugins.list())
  const plugins = load.data ?? []
  return {
    lines: [],
    header: PLUGINS_HEADER,
    widths: PLUGINS_WIDTHS,
    rows: plugins.map((p) => pluginRow(p, pluginActions(client, p))),
    empty: 'No plugins are built into this core.',
    actions: [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}
