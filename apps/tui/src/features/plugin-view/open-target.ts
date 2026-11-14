/**
 * Where an `open.view` delivery goes (docs/specs/parietal.md, "Client capability registry and route"; the name of the
 * delivery carries the view). `plugin:<id>:<view>` is the plugin view `<id>.<view>` of the menu (`GET /plugins/tui/menu`);
 * `tasks` is the Tasks screen. Anything else (a room, protocols, a view the person may not open) is `undefined`: the
 * app answers `unsupported`.
 */
export type OpenTarget = { kind: 'view'; viewId: string; label: string } | { kind: 'tasks' }

/** The plugin views of the menu, as the menu lists them. */
export interface OpenableView {
  viewId: string
  label: string
}

const PLUGIN_VIEW = /^plugin:([a-z0-9_-]+):([a-z0-9_-]+)$/

/** The target a delivery names, or `undefined` when this terminal cannot open it. */
export function openTargetOf(name: string, views: readonly OpenableView[]): OpenTarget | undefined {
  if (name === 'tasks') return { kind: 'tasks' }
  const match = PLUGIN_VIEW.exec(name)
  if (match === null) return undefined
  const viewId = `${match[1]}.${match[2]}`
  const view = views.find((v) => v.viewId === viewId)
  return view === undefined ? undefined : { kind: 'view', viewId, label: view.label }
}
