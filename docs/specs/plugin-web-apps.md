# Plugin web apps (the SPA side)

ADR-0038 §4, §6, §7 and §9; plan P40.5. A plugin contributes a window app to the point `web.window` (`plugins.md`); the web client
(`apps/web`, `features/workspace`) lists it, draws it in a window and talks to it over one versioned bridge. This spec is the client's
half: the listing, the sandbox and the bridge protocol. How the core serves the static files of a bundle under `/plugins/<id>/web/`,
with a CSP per app, is in `thalamus.md`; the contribution schema and boot rules are in `plugins.md`; the window params and their
validation by the core are in `workspace.md`.

Types: `@keith/contracts` `web-apps.ts` (`WebAppSchema`, `HostToAppSchema`, `AppToHostSchema`, `BRIDGE_VERSION`,
`BRIDGE_CALLS_PER_MINUTE`) and `workspace.ts` (`WindowParamsSchema`, `MAX_WINDOW_PARAMS_BYTES`).

## Listing

- `rpc.workspace.apps()` answers the apps this person may open (`WebApp[]`): the built-in apps of `web` (`web:*`, entry
  `{ builtin }`) and the apps of other plugins (`maps:map`, entry `{ url: '/plugins/maps/web/map.html' }`, a path on the core's
  origin). `calls` are full operation names (`maps.search`); `params` is the app's params as JSON Schema.
- The SPA reads it at `workspace.start()` and on every feed resync (`workspace.loadApps`). The core's list wins over the built-in
  fallback (`mergeApps`, `apps.ts`); a failed call keeps the last good list or the fallback. The launcher shows the merged list.

## Sandbox

- A plugin page always loads in `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`. `allow-same-origin` is never set,
  for any plugin (the owner's own included): the frame has an opaque origin, so it cannot read the session cookie, call `/rpc` or
  `/plugins/*` with the person's session, or reach the SPA's DOM, storage or other windows. No `allow-top-navigation`,
  `allow-popups` or `allow-forms` for plugin pages.
- The frame's `src` must be a path under `/plugins/<id>/web/` without `..` or `//` (`pluginFrameSrc`); any other entry (another
  origin, a `javascript:` URL, a plugin operation path) is not loaded and the window says so.
- The page's own CSP (served by the core) limits what it loads and connects to: its own files plus the origins in `network`.
- An app may ask for more in its contribution (ADR-0040): `gpu` (WebGL engines: WebAssembly, `blob:` workers and images, and XHR to its
  own `/plugins/<id>/` paths), `media` (https audio and video) and `live` (network origins whose images change every minute, kept 20 s by the
  net route). The sandbox stays the same: no `allow-same-origin`, whatever the flags.
- A page should load public images from a declared origin through the core (`../net/<host>/<path>`, `thalamus.md` "Plugin net route"):
  the core fetches them with Keith's User-Agent and caches them. A browser loading them directly may be refused by a service with a usage policy.

## Bridge

Every message is a plain object with `v: BRIDGE_VERSION` (1) and a `type`. The host validates each incoming message with
`AppToHostSchema` and drops, without an answer, a message whose `event.source` is not this window's frame (`contentWindow`), of
another version, or of an unknown shape (`parseAppMessage`, `bridge.ts`).

Host to app (posted to `contentWindow` with targetOrigin `'*'`, since the frame's origin is opaque; this is safe because no
host message carries a secret):

| Message | When | Body |
| --- | --- | --- |
| `init` | answer to each `ready` | `params` (the window's, `{}` for none; a plain deep copy, `plainParams`: Svelte state proxies cannot be posted), `theme` (`dark`; windows are always drawn dark), `language` (`navigator.language`, 16 characters), `size` (the frame's box in CSS pixels, rounded). Never an identity, a token, a session or a person id (`initMessage`). |
| `params` | the window's params changed (Keith's or the person's `window.setParams`) after `ready` | `params` (a plain deep copy, as in `init`). Not sent when the new params are the ones the app itself proposed last. |
| `result` | answer to a `call` | `id` (the call's), `ok`, `value` (the operation's JSON output) or `error` (one line, at most 200 characters, never a stack). |

App to host:

| Message | What the host does |
| --- | --- |
| `ready` | Sends `init`. A page that reloads sends `ready` again and gets `init` again. |
| `call { id, operation, input }` | Allowed only when `operation` is an operation name of the app's contributor and `<contributor>.<operation>` is in the app's `calls` (`callAllowed`); another plugin's operation is refused even if listed. Then at most `BRIDGE_CALLS_PER_MINUTE` (30) calls per window in any sliding minute (`bridgeLimiter`, keyed by window id, so a window drawn again keeps its count; a refused call is not counted). The SPA, not the frame, runs `POST /plugins/<contributor>/<operation>` with the JSON `input` (same origin, `credentials: 'same-origin'`), so the plugin guard applies as for any caller: actor, capability, ACL, rate limit, audit (`plugins.md` "HTTP"). Answers `result`: `not allowed`, `too many calls, wait a minute`, the route's `error.message`, or `the call did not reach Keith` (`runCall`). |
| `setParams { params }` | The app proposes new params (the person panned the map). Debounced 300 ms (the last proposal wins); applied as `workspace.apply({ op: 'window.setParams' })` only when the params are window params (an object of at most 4 KB as JSON, `WindowParamsSchema`) and differ from the window's (`proposedParams`). The core validates them against the app's schema and may refuse. |
| `setTitle { title }` | Cleaned (`cleanTitle`: control, C1 and bidi characters removed, one line, 80 characters) and shown in a slim bar inside the window. The workspace title of the window is not changed (there is no title operation). |
| `error { message }` | One cleaned line in that bar. |

## Built-in apps

The built-in apps of `web` are Svelte components compiled into the SPA, chosen by `entry.builtin`. Those that read params check them
again in the client (`builtin/params.ts`), although the core validated them first:

- `web:browser { url }`: only `https:` URLs with a host and no credentials; the page loads in
  `<iframe sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer">` (never `allow-same-origin`), the domain and
  `Open in a new tab` (`target=_blank`, `rel="noopener noreferrer"`) are always shown above it, and a frame that has not fired `load`
  in 8 s is replaced by a card (the domain, `Open in a new tab`), because a site that refuses framing is not reported to the page.
- `web:doc { title?, text }`: Markdown through the chat's renderer (it builds nodes, never HTML).
- `web:media { url, kind: 'image' | 'video' | 'audio', caption? }`: https only, native elements, no autoplay.
- `web:tui { view }`: a plugin terminal view (`<plugin>.<view>`, `plugin-views.md`) drawn by the Apps screen's terminal.

## Tests

`apps/web/src/lib/features/workspace/bridge.test.ts` (source and version checks, the call rule, the limiter, `runCall` with a fake
`fetch`, the fields of `init`, titles, errors, proposed params, the frame `src`), `apps.test.ts` (the merged list),
`builtin/params.test.ts`. There is no DOM test environment in the web app: `PluginFrame` and the built-in components are checked by
hand.
