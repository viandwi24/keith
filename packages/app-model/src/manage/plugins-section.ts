import { pluginActions } from './plugins-actions.ts'
import { PLUGINS_HEADER, PLUGINS_WIDTHS, pluginRow } from './plugins-state.ts'
import type { SectionEnv, SectionModel } from './types.ts'

/** Plugins: the built-in plugins and their status (`admin.plugins.list`); owner only. */
export function pluginsSection({ client }: SectionEnv) {
  return {
    load: () => client.rpc.admin.plugins.list(),
    build: (plugins) => ({
      lines: [],
      header: PLUGINS_HEADER,
      widths: PLUGINS_WIDTHS,
      rows: (plugins ?? []).map((p) => pluginRow(p, pluginActions(client, p))),
      empty: 'No plugins are built into this core.',
      actions: [],
    }),
  } satisfies SectionModel<Awaited<ReturnType<typeof client.rpc.admin.plugins.list>>>
}
