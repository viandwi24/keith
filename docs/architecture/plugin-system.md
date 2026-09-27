# Plugin system

The exact API is in [contracts/plugin-api.md](../contracts/plugin-api.md). This doc explains the model.

## What is a plugin

**Something is a plugin if and only if it needs code running inside the core process.** Anything else is a Node that consumes the public protocol ([ADR-0002](../decisions/0002-plugins-run-in-core-nodes-do-not.md)).

| Thing | Plugin? | Why |
|---|---|---|
| TUI | No, it's a Node | Consumes public HTTP + WS only |
| Web UI | **Yes** (`client-app`) and its browser side is a Node | Needs the core to serve its assets (and maybe extra routes). The browser still talks the public protocol like the TUI |
| Telegram bridge | Yes (`client-app`) | Needs a webhook route and translates Telegram updates into Threads |
| Weather tool | Yes (`tool`) | Registers tools that run in the core |
| OpenRouter adapter | Yes (`provider`) | Registers an LLM provider |
| Headless file-access agent on another machine | No, it's a Node | Separate process with `fs@1` |
| Third-party tool server you don't trust | No, it's an MCP server | Bridged into the tool registry (phase 8) |

A client-app plugin that ships a browser UI (today only `@keith/web`) keeps two halves in one package ([ADR-0011](../decisions/0011-client-app-browser-side.md)): server code in `src/` and the browser app in `app/`, which builds to `dist/`. The server half never imports `app/`. The whole server side of `@keith/web` is one `ctx.http.static('/', dist, { spaFallback: 'index.html' })`, with no `/p/web/` routes. The config option `distDir` overrides the folder (a relative path resolves against the core's working directory). If the folder has no `index.html`, the plugin logs a warning and serves a small "web app isn't built" placeholder page at `/`, so the core keeps running without the build.

Like a Linux distro, Keith works as CLI only. The web plugin is a desktop environment you can install on top, and applications (tools) don't depend on which one is installed. They speak the shared protocol (UI blocks).

## Plugin kinds

| Kind | May use (in addition to services, events, data) | May NOT use |
|---|---|---|
| `infra` | http, ws | tools, skills, agents, providers, deliveries |
| `provider` | providers | http, ws, tools, skills, agents, deliveries |
| `tool` | tools, skills, agents, deliveries | http, ws, providers |
| `client-app` | http, ws, deliveries | tools, skills, agents, providers |

Every kind may provide and consume services, listen to and emit events (in its own namespace), and use `ctx.data` / `ctx.paths`. The plugin host enforces the rest of this table. Using a registry outside your kind throws `PLUGIN_KIND_VIOLATION`. A plugin that genuinely needs two kinds is two plugins.

A delivery may carry a UI block (`ctx.deliveries.enqueue({ ui })`). It is shown with the message that delivers the item ([ui.md](ui.md#rendering-rules-for-client-apps)), but its buttons reach no plugin code: a click becomes the input `(clicked: <label>)` in the Thread. A plugin that needs a working button should expose a tool whose result carries the block (tool blocks route clicks to the tool's `onAction`). Routing delivery clicks to the plugin would need a contract change.

## Namespace

Every plugin declares a `namespace` (`/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/`, unique across loaded plugins, e.g. `weather` for `@keith/tool-weather`). The same value scopes everything the plugin names:

| Thing | Rule | Example |
|---|---|---|
| Tools | Name starts with `<namespace>.` | `weather.current` |
| Events it emits | Name starts with `<namespace>.` | `weather.alert_raised` |
| HTTP routes | Mounted under `/p/<namespace>/` | `/p/weather/icon.svg` |
| WS frame types | Start with `<namespace>.` | `telegram.linked` |

Reserved namespaces (core and built-ins): `core`, `plugin`, `node`, `person`, `thread`, `turn`, `tool`, `task`, `commitment`, `delivery`, `memory`, `scheduler`, `skill`, `reminder`, `relay`, `workspace`, `p`, `v1`.

## Lifecycle

```
load (import from config)  →  setup(ctx)  →  start(ctx)  →  … running …  →  stop(ctx)
```

- **`setup`**: *register only*. Tools, skills, agents, providers, routes, event listeners, and services you provide. Don't call other plugins' services here, since they may not be registered yet.
- **`start`**: all plugins are set up, so you may `ctx.services.get(...)`. Open connections and start timers.
- **`stop`**: runs in reverse load order. Close everything within `plugins.stopTimeoutMs` (default 5 000).

A plugin that throws in `setup` or `start` is marked `failed`. Its registrations are rolled back, the core keeps running without it, and the failure is logged and emitted as `plugin.failed`. An owner node gets one `warn` notice per failed plugin right after `welcome` ([protocol.md](../contracts/protocol.md#notices)). Core plugins listed in `plugins.required` (config) make the core refuse to start if they fail.

## Talking to other plugins

Plugins never import each other (R-2). Two mechanisms, with different jobs ([ADR-0005](../decisions/0005-services-for-requests-events-for-facts.md)):

### Services: "I need something done or some data"

```ts
// plugins/tool-weather: provides
ctx.services.provide('weather', { forecast: (city) => ... })

// plugins/tool-briefing: consumes (in start or later)
const weather = ctx.services.get('weather')        // typed, throws SERVICE_MISSING if absent
const maybe   = ctx.services.find('weather')       // typed, undefined if absent
```

Services are typed by declaration merging, so consumers get types without importing the provider plugin:

```ts
// in the providing plugin's published types (e.g. src/service.ts, exported as a type-only entry)
declare module '@keith/sdk' {
  interface ServiceMap { weather: { forecast(city: string): Promise<Forecast> } }
}
```

A consumer that wants those types adds the provider plugin as a **type-only devDependency** (`import type`). The dependency-check script allows `import type` from another plugin's `/service` entry and nothing else.

A plugin may declare `needs: ['weather']`. The host then fails its `start` with a clear message if no plugin provides it. That is the entire dependency system: no graph, no topological sort.

### Events: "something happened"

```ts
ctx.events.emit('weather.alert_raised', { city, level })   // facts, past tense, namespaced
ctx.events.on('person.arrived', async (e) => { ... })
```

- Names: `<namespace>.<noun>_<past-tense-verb>`. Core namespaces are listed in [contracts/events.md](../contracts/events.md). Plugins emit only under their own declared `namespace`.
- Payloads are zod-validated at `emit` when the plugin registered a schema with `ctx.events.define(name, schema)`.
- Handlers run asynchronously and isolated from each other. A throwing handler is logged and does not affect the emitter.
- **Events are facts, not commands.** A name like `weather.fetch_requested` is a smell. Use a service.

Rule of thumb: if the emitter needs an answer, use a service. If the emitter doesn't care who listens, use an event.

## Plugin storage

- `ctx.data`: scoped key-value store (`get/set/delete/list`), namespaced by plugin id and backed by the core's SQLite. For settings, caches and small state.
- `ctx.paths.data`: a private directory `~/.keith/plugins/<plugin-id>/` for files.
- Plugins never get raw database access.

## Loading

- Plugins are listed by package name in `config.toml` under `plugins.enabled` and loaded with dynamic `import()` in list order. The package's default export must be a plugin whose `id` equals the package name. `bootstrap(opts)` and tests may also pass plugin objects directly; they load after the configured ones.
- Each plugin's config section is validated against its `config` zod schema before `setup` (defaults applied). An invalid section fails the plugin at the `setup` stage with `CONFIG_INVALID`.
- **Planned:** loading from a local path (`plugins.enabled = ["./my-plugin"]`) for personal plugins.

## Host rules

The plugin host (`core/src/plugins`) applies these rules. Each has a test.

| Situation | Result |
|---|---|
| Package can't be imported, has no plugin default export, or exports another id | Logged (`stage: 'load'`), skipped, not listed in `status()`. No `plugin.failed` event (its `stage` is `setup` or `start` only). Throws if the plugin is in `plugins.required` |
| `plugins.required` names a plugin that isn't enabled | `load` throws `CONFIG_INVALID` |
| Invalid, reserved or already-taken `namespace` | The plugin fails setup with `PLUGIN_NAMESPACE_INVALID` |
| Registry outside the plugin's kind | `PLUGIN_KIND_VIOLATION`, thrown synchronously at the call |
| `ctx.services.get` / `find` during `setup` | Throws `SERVICE_MISSING` saying services are available from `start` on |
| `needs` lists a service nobody provides | That plugin's `start` fails with `SERVICE_MISSING` naming the service(s). Checked right before each plugin's `start` |
| `setup` or `start` throws | Registrations rolled back (services, tools, skills, agents, providers, routes, ws handlers, event handlers and schemas), and its `ctx.deliveries` refuses new items (items it already queued stay). State `failed`, error logged, `plugin.failed` emitted. `ctx.data` is kept. The failed plugin keeps its `namespace`: a later plugin with the same namespace still fails with `PLUGIN_NAMESPACE_INVALID` |
| A `plugins.required` plugin fails | `load` (setup) or `startAll` (start) throws |
| After all setups, a `models` role names an unregistered provider | `load` throws `CONFIG_INVALID` naming the role and the ref |
| `stop` runs longer than `plugins.stopTimeoutMs` | Abandoned and logged. Only started plugins are stopped, in reverse load order |

Registry rules:

- **Services:** providing a taken name throws `SERVICE_CONFLICT`. When `[services]` names a winner for that service, only the winner's implementation is kept, whatever the load order, and the others are ignored (logged).
- **Tools:** the name must match `TOOL_NAME_PATTERN` and its first segment must be the plugin's namespace (`TOOL_NAME_INVALID`). Names are unique (`TOOL_NAME_TAKEN`). Built-ins use `registerBuiltin` and must be in a reserved namespace.
- **`tools.invoke`** never throws. In order: unknown tool (`NOT_FOUND`), `minTier` against the lowest tier among the participants (`TIER_INSUFFICIENT`), zod input validation (`TOOL_INPUT_INVALID`), a call whose signal is already aborted (`INTERNAL`, "was cancelled"), then `run` with `timeoutMs` (`TOOL_TIMEOUT`, the tool's signal is aborted). Refusals never call `run`. A throw becomes `INTERNAL` (or the thrown `KeithError`'s code). Each failure comes back as `{ error: true, content: '<CODE>: <message>' }`. It emits exactly one `tool.called` / `tool.completed` pair per invocation, refusals included (`ok: false`); nothing else emits them ([core.md](core.md#the-turn-loop)).
- **Skills and agents:** snake_case names, unique. There is no dedicated error code, so they reuse `TOOL_NAME_INVALID` and `TOOL_NAME_TAKEN`. No plugin agent may be called `general`.
- **Providers:** two providers with the same id throw `SERVICE_CONFLICT`. `providers.llm.resolve(role)` splits `config.models[role]` at the first `:` into provider id and model id.
- **Events:** a plugin may `emit` and `define` only names that match `EVENT_NAME_PATTERN` and start with `<namespace>.` (`PLUGIN_NAMESPACE_INVALID`). A payload that fails its defined schema makes `emit` throw `INTERNAL`.
- **WS frame types** registered by a plugin must start with `<namespace>.` (`PLUGIN_NAMESPACE_INVALID`).
