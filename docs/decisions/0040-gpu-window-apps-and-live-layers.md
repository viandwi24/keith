# 0040. GPU window apps, library mounts and live data layers (the maps globe)

Status: Proposed (2026-11-16). Amends ADR-0038 §4 and §5 (what a window app may declare and the CSP its page gets). Plan: P40.5
follow-up (maps globe). Specs: `docs/specs/plugins/maps.md`, `docs/specs/thalamus.md` ("Plugin web bundles", "Plugin net route"),
`docs/specs/plugin-web-apps.md`, `docs/specs/net-proxy.md`, `docs/specs/plugins.md` ("Manifest", "Config", "MCP").

## Context

The owner wants the maps window to become a world view in the spirit of public OSINT dashboards: a 3D globe that morphs to a flat map
without losing its state, with live layers (aircraft, ships, transit, satellites, quakes, weather, public cameras, radio, recent satellite
imagery), drawing tools for the agent and the person, and a way for outside agents to drive it. "Show me cameras near Tunjungan Plaza"
should work in chat and on the map.

ADR-0038 made a window app a static bundle in a sandboxed iframe with a strict CSP: own scripts and styles, images from declared
origins, no workers, no WebAssembly, no media. A WebGL globe engine needs more than that, and the engine is several megabytes that should
not be copied into the repository.

## Decision

1. **CesiumJS for the globe.** CesiumJS (Apache-2.0) draws the globe and the flat map in one scene and morphs between them
   (`morphTo2D`/`morphTo3D`), so a switch keeps every entity, the camera target and the data. Its imagery comes from the same raster tiles
   as before, through the core's net route. No Cesium ion token, no Google tiles: nothing needs a key or an account.
2. **Library mounts.** A plugin's `web` may name `mounts: { 'vendor/<name>': <absolute path> }`. The core serves that folder read-only at
   `/plugins/<id>/web/vendor/<name>/` with the same path rules as the bundle, never an HTML page from it, and `Cache-Control: public,
   max-age=86400` (a fixed release). The maps plugin mounts `node_modules/cesium/Build/Cesium` (version pinned in the catalog). The bundle
   folder still holds every page.
3. **`gpu` window apps.** A window app may declare `gpu: true`. Its page's CSP then also allows `'wasm-unsafe-eval'` in `script-src`
   (Cesium decodes meshes and imagery with WebAssembly), `blob:` and `data:` images, `worker-src 'self' <core> blob: data:` (a module
   worker's static imports are checked against `worker-src`), and `connect-src
   <core>/plugins/<id>/` (the page's own files and net route by XHR; nothing else on the core). Cesium starts module workers from its
   own URL, which a frame with an opaque origin may not do; the page wraps `Worker` so each worker starts from a small shim that imports
   the real file: a module worker from `data:` (Chrome never loads a module worker from a `blob:null` URL), a classic one from `blob:`.
   The engine's single-file build would also start classic workers from a bundled string (`importScripts(blob:)`, which `script-src`
   refuses); the page pins that global (`CESIUM_WORKERS`) to `undefined`. Every image the engine loads asks for CORS (the frame's
   origin is opaque, so the core's files are cross-origin to it and WebGL refuses a texture without CORS); the core answers its plugin
   files and net route with `Access-Control-Allow-Origin: *`. The engine also bundles knockout, which probes the global object with `(0, eval)("this")` at load; the page replaces
   `eval` with a function that answers only that and refuses any other string. Still no `unsafe-eval`, no inline script, no
   `allow-same-origin`.
4. **`media` window apps.** `media: true` adds `media-src https:` so a page can play an https audio stream (internet radio). Streams are
   not proxied: they are endless, and the core would hold one connection per listener.
5. **`live` origins.** A window app may list up to 16 of its `network` origins as `live`: images that change every minute (traffic camera
   snapshots). The net route keeps them 20 s instead of their max-age and answers `Cache-Control: no-cache`. `network` grows to at most 32
   origins (map styles, camera hosts, imagery).
6. **One `maps` plugin, layers as modules.** Every layer is a provider inside the maps plugin (`plugins/maps/layers/`), not a plugin of its
   own. The window may only call its own plugin's operations (ADR-0038 §7), so one `layers` operation answers all layers for the view
   in one bridge call; separate plugins would need a cross-plugin call path, a shared catalog and the same window anyway. A future
   `maps.layer` extension point can let other plugins contribute layers without changing this.
7. **Layers are read on the server, sanitized twice.** Providers fetch public, keyless sources with the plugin's own upstream (generic
   User-Agent, one request a second per host, short caches) and answer features: positions, labels, facts, an image path through the
   net route, an https stream. The page accepts an image only as a `../net/<host>/<path>` path and a stream only as https. `maps_explore`
   gives the agent the same features as text, marked `source: outside`.
8. **Plugin settings from the environment.** `KEITH_PLUGIN_CONFIG` (a JSON object by plugin id) fills `k.config`, each part parsed by the
   plugin's `config` schema; a bad part is dropped with a warning that names fields, never values. Maps uses it for the AISStream key
   (ships) and the owner's own ADS-B receivers. A settings form stays a later step (ADR-0007).
9. **An MCP endpoint.** `POST /plugins/mcp` speaks the Model Context Protocol (Streamable HTTP, stateless, JSON answers) with the usual
   bearer: `tools/list` is the caller's HTTP-visible operations, `tools/call` runs one through the same guard as `POST /plugins/<id>/<op>`.
   An outside agent sees exactly what the same token could call over REST, nothing more.

## Consequences

- The maps page is no longer dependency-free: it loads CesiumJS from the mount. A Cesium upgrade is a catalog bump and a check of the
  worker wrapper.
- A `gpu` page can run WebAssembly and workers. They stay inside the opaque-origin sandbox and the CSP: no network beyond its declared
  origins and its own plugin paths.
- Camera snapshots, satellite previews and weather rasters pass through the core and its disk cache; live ones expire in seconds.
- Public sources can fail or change shape: each layer fails alone (an `error` on that layer), and every reader drops what it cannot use.

## Alternatives rejected

- **A CDN for Cesium.** The page CSP would have to trust a third-party script origin, and the window would stop working offline.
- **MapLibre with a globe projection.** Lighter, but no real 3D scene (satellite orbits, aircraft altitude) and a weaker 2D/3D morph.
- **One plugin per layer.** See §6.
- **Proxying radio streams.** See §4.
