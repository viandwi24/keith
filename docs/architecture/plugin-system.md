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

Like a Linux distro, Keith works as CLI only. The web plugin is a desktop environment you can install on top, and applications (tools) don't depend on which one is installed. They speak the shared protocol (UI blocks).

## Plugin kinds

| Kind | May use (in addition to services, events, data) | May NOT use |
|---|---|---|
| `infra` | http, ws | tools, skills, agents, providers, deliveries |
| `provider` | providers | http, ws, tools, skills, agents, deliveries |
| `tool` | tools, skills, agents, deliveries | http, ws, providers |
| `client-app` | http, ws, deliveries | tools, skills, agents, providers |

Every kind may provide and consume services, listen to and emit events (in its own namespace), and use `ctx.data` / `ctx.paths`. The plugin host enforces the rest of this table. Using a registry outside your kind throws `PLUGIN_KIND_VIOLATION`. A plugin that genuinely needs two kinds is two plugins.

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

A plugin that throws in `setup` or `start` is marked `failed`. Its registrations are rolled back, the core keeps running without it, and the failure is logged and emitted as `plugin.failed`. Core plugins listed in `plugins.required` (config) make the core refuse to start if they fail.

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

- Plugins are listed by package name in `config.toml` under `plugins.enabled` and loaded with dynamic `import()` in list order.
- Each plugin's config section is validated against its `config` zod schema before `setup`.
- **Planned:** loading from a local path (`plugins.enabled = ["./my-plugin"]`) for personal plugins.
