# 0038. Extension points: a plugin opens a point, other plugins contribute (web window apps)

Status: Proposed (2026-11-15). Plan: `docs/plans/active/P40-workspace.md` (phase P40.5). Extends ADR-0016 (plugin layer: a third way
for plugins to meet, after services and the `tui` slot) and amends ADR-0016 §5 (a plugin may serve the static files of its web apps)
and ADR-0035 §1 and §7 (the plugin `web` owns the workspace; plugin code runs in the browser, sandboxed). Builds on ADR-0018 (plugin
views: their output is untrusted by the client), ADR-0023 (the core is the mind) and ADR-0037 (workspace).

## Context

The owner wants plugins that serve other plugins: a plugin should be able to define something that other plugins plug into. The case
that drives it is the web workspace (ADR-0037). A Maps plugin gives the agent tools (`maps_search`) and also wants a window in the web
client that shows a place, which Keith opens and moves ("where is Surabaya?", then "zoom to Tunjungan Plaza").

Plugins meet today in two ways. Services (`provides`, `requires`) are functions called at runtime with the provider's authority. The
`tui` slot is fixed in the host. Neither lets a plugin declare a new kind of contribution that others fill in with data. ADR-0035 §7 also
says no plugin JavaScript runs in the browser, so a plugin cannot draw a map in the web client.

## Decision

1. **Extension points.** A plugin manifest may declare `extensionPoints: { '<plugin>.<name>': <zod schema> }`, and any plugin may declare
   `contributes: { '<point>': [<entries>] }`. A point's id starts with the declaring plugin's id. Contributions are data: they are
   validated against the point's schema at boot, and the contributor's code is never run by the core to read them. The declaring plugin
   reads its contributions with `ctx.contributions(point)` (in `start`) and `k.contributions(point)` (in an operation), each entry tagged
   with its contributor's id.
2. **Boot rules follow services.** A contribution to a point that does not exist, whose declaring plugin is off or failed, or that fails
   the schema makes the contributor fail with a one-line reason, and the core keeps booting (`planBoot`: a declaring plugin before its
   contributors; a cycle fails both). A plugin may contribute to its own point. Contribution ids are unique per point and contributor.
   Services stay the way to share behaviour; extension points are the way to share declarations.
3. **The plugin `web` owns the workspace.** `plugins/web` holds the workspace store, its operations (`workspace.get`, `workspace.apply`,
   the agent's `workspace` tool) and two points: `web.window` (window apps) and `web.hud` (ambient panels, later). It contributes its own
   built-in apps through the same point. Sign-in, sessions, serving the SPA at `/app` and the SPA itself (`apps/web`) stay in the
   platform and the app, because ADR-0016 keeps platform modules from depending on plugins. When `web` is off, contributions to its points
   are ignored with a warning and the contributors' tools still work.
4. **A window app contribution.** `{ id, title, icon?, params: <zod>, entry, network?, calls?, permission?, singleton?, minSize? }`.
   `entry` is either `{ builtin: '<name>' }` (only the plugin `web` may use it: a Svelte app compiled into the SPA) or a path to a static
   bundle inside the plugin folder (`./web/map.html`). `network` lists the https origins the app may load images from or connect to.
   `calls` lists the contributor's own operations the app may call. `permission` is a capability the viewer must hold to open the app.
   The app id seen by the workspace and the agent is `<contributor>:<id>` (`maps:map`).
5. **The core serves bundles with a CSP per app.** A plugin may serve the files of its web app bundles under
   `/plugins/<id>/web/` (static files only, from the folder its manifest names, no handler code). Each response carries
   `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' <network>; connect-src <network>;
   frame-ancestors 'self'` and `X-Content-Type-Options: nosniff`. This is the one narrowing of ADR-0016 §5; free-form routes and sockets
   stay forbidden.
6. **Plugin web code always runs in a sandboxed iframe.** The SPA loads a plugin app in `<iframe sandbox="allow-scripts">` without
   `allow-same-origin`, so the frame has an opaque origin: it cannot read the session cookie, call the Keith API, or touch the SPA or other
   windows. The SPA's CSP adds `frame-src 'self'`. Built-in apps of `web` run natively in the SPA. There is no "trusted plugin" bypass:
   the owner's own plugins use the same path.
7. **One bridge between the SPA and an app.** `postMessage` with a fixed, versioned set of messages, each validated by zod in the host:
   host to app `init` (params, theme, language, size; never an identity or a token) and `params` (a `window.setParams` by Keith or the
   person); app to host `call` (an operation listed in `calls`, run by the host through `@keith/client` as the viewer, so the plugin
   guard applies: actor, capability, ACL, rate limit, audit), `setParams` (the app proposes new params, for example after the person pans
   the map; the host applies it as an operation so Keith knows where the map is), `setTitle` (clipped, cleaned), `ready` and `error`.
   The host rate-limits calls per window and drops messages from any source other than that window's frame.
8. **Keith learns the apps per turn.** The description of the `workspace` tool is built each turn from the `web.window` contributions
   the person may open (their `permission`) and the clients online that declare `render.workspace`, with each app's params schema. The
   core validates `window.open` and `window.setParams` against the contributed schema before it applies them.
9. **The built-in browser app.** `web:browser { url }` shows an https page in a sandboxed iframe (the SPA's CSP adds `frame-src https:`
   for this app only; the iframe gets `sandbox="allow-scripts allow-forms allow-popups"` and never `allow-same-origin` together with
   scripts from the SPA's origin). Many sites refuse to be framed (`X-Frame-Options`, `frame-ancestors`): the window then shows a card
   with the title, the domain and "Open in a new tab". The domain is always shown in the frame's title bar. A URL that Keith opens is
   marked like any window Keith opens, and it is outside content for consent (ADR-0036).

## Implementation note (P40.5, 2026-11-15)

Built as decided, with one difference the owner should confirm or reverse: the workspace store and its operations (§3) stay in the
core's parietal region, and `plugins/web` holds the two points, the built-in apps and a read operation `apps`. The store leans on
presence, the front session (the "On screen now" line, the undo log, consent metadata) and was built and tested there in P40.2 and
P40.3; moving it means offering those as core services to a plugin first. The core reads `web.window` for its catalog, so contributors
see no difference. A declaring plugin that is off makes contributions to its points ignored with a warning (§3), not a contributor
failure (§2).

Second difference (2026-11-15): §5 says a plugin web bundle is static files only. A window app may also load images from a host it
declared in `network` through the core (`GET /plugins/<id>/net/<host>/<path>`, docs/specs/thalamus.md "Plugin net route"): the core
fetches them with its net proxy (docs/specs/net-proxy.md: Keith's User-Agent, two requests per host, a disk cache). Still no plugin code
runs for these routes. Reason: OpenStreetMap refused tiles that a sandboxed page in Chrome loaded directly, while the same tiles loaded
from the core; a service with a usage policy wants one identified, caching client, not every browser.

## Alternatives rejected

- **Plugin web code in the SPA.** The SPA holds the owner's session; one careless plugin could read every answer on the screen or call any
  procedure. Sandboxing costs a bridge and is the same for every plugin.
- **A declarative-only window (JSON layout, no code).** It cannot draw a map, a chart or a custom editor, which is the point of the case.
- **Services for contributions.** A service needs the contributor's code running to answer and has no schema the declaring plugin owns;
  the web plugin needs to list apps (and send their schemas to the agent) without running any contributor code.
- **The whole web client as a plugin.** Sign-in and serving `/app` would make the platform depend on a plugin (ADR-0016) and a disabled
  plugin would lock the owner out of the browser.

## Consequences

- `@keith/host`: `extensionPoints`, `contributes`, `ctx.contributions`, `k.contributions`, boot planning and their tests; `plugins.md`
  gets a section; the plugin manifest snapshot and `check-exports` change.
- The core gets static serving with per-app CSP for plugin bundles, and the SPA's CSP gains `frame-src`.
- `apps/web` gets the iframe host and the bridge (`features/workspace/bridge`), tested as pure message validation.
- The `tui` slot could later become an extension point of a plugin `tui`; not part of this decision.
- A Maps plugin (search tool and the `maps:map` window with OpenStreetMap tiles) is the first contributor and the acceptance case.
- Revisit when a third-party plugin is wanted (tier T2, ADR-0016) or when a contribution needs code on the core side.
