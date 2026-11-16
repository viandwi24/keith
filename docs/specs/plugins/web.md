# Plugin `web`

The plugin of the web workspace (ADR-0038 §3, plan P40.5). Code: `plugins/web/plugin.ts`. Related: `workspace.md` (the document and
the catalog the core builds from this plugin's point), `plugin-web-apps.md` (the SPA side: listing, sandbox, bridge), `plugins.md`
("Extension points").

## Extension points

| Point | Entry schema | Read by |
| --- | --- | --- |
| `web.window` | `WindowAppContributionSchema` (`@keith/contracts`, `web-apps.ts`): `id`, `title`, `icon?`, `description?`, `params` (a zod schema), `entry` (`{ builtin }`, only `web` itself, or `{ path: './web/<name>.html' }` inside the contributor's `web.dir`), `network` (https origins), `calls` (the contributor's own operation names), `permission?`, `singleton`, `minSize?` | the core's workspace catalog (`workspace.md`, "Window apps"), this plugin's `apps` operation |
| `web.hud` | `HudPanelContributionSchema`: `id`, `title`, `entry: { builtin }` | nobody yet (the ambient panels come later; the point exists so a contribution is checked at boot) |

A contribution to either point is checked at boot by the plugin host: one that does not fit fails its contributor with a one-line
reason and the core keeps booting. When `web` is off, contributions to its points are ignored with a warning and the contributors
still boot (their tools work; their windows do not open) and the workspace falls back to the eight built-in screens.

## Built-in apps

`web` contributes to its own point (`BUILTIN_APPS`), entries `{ builtin: <id> }` drawn natively by the SPA:

- The old screens, one window each, no params: `chat`, `tasks`, `inbox`, `nodes`, `memory`, `rooms`, `budget`, `brain`.
- `browser { url }` (https only), `doc { title?, text ≤ 3500 }` (Markdown), `media { url (https), kind: image|video|audio,
  caption? }`, `tui { view: '<plugin>.<view>' }` (a plugin terminal view). These open a new window each time.

## Operation

`web.apps` (`POST /plugins/web/apps`, `k.call`; not offered to the model: `expose.ai: false`, the agent has the `workspace` tool):
lists the window apps of every contributor through `k.contributions('web.window')` as `{ id: '<contributor>:<id>', contributor,
title, description }`. Read, any signed-in person.

## Not here (yet)

ADR-0038 §3 puts the workspace store and its operations in this plugin. They stay in the core's parietal region for now: the store,
`workspace.get|apply|undoKeith|apps`, the `workspace` tool, the reminder line and the undo were built and tested there in P40.2 and
P40.3, and the platform's sign-in and presence they lean on may not depend on a plugin (ADR-0016). Moving them is a later step.

## Tests

`plugins/web/plugin.test.ts` (the points, the one operation, every built-in app fits the point, viewer params, the HUD schema).
