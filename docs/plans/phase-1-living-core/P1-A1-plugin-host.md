---
id: P1-A1
title: Plugin host, registries, event bus, config
phase: 1
wave: 1
lane: A
status: review
owner: agent-P1-A1
depends: [P0-04]
owns:
  - packages/core/src/shared/**
  - packages/core/src/config/**
  - packages/core/src/plugins/**
  - packages/core/src/events/**
reads:
  - docs/architecture/plugin-system.md
  - docs/architecture/config.md
  - docs/contracts/plugin-api.md
  - docs/contracts/events.md
updates:
  - docs/architecture/plugin-system.md
  - docs/architecture/config.md
scenarios: []
---

# P1-A1: Plugin host, registries, event bus, config

## Goal

The core can load plugins from config, give each a correctly scoped `PluginContext`, enforce plugin kinds, and route services and events between them.

## Scope

**In:**
- `shared/`: JSON logger (levels, child loggers, secret redaction per config.md), `systemClock`, prefixed ULID `ids` generator.
- `config/`: the zod schema for `config.toml` (every key in config.md, with defaults), `env:` resolution, `KEITH__A__B` overrides, a `loadConfig({ home, flags })` function, and `persona.md` default template text (exported constant; writing it to disk is I1's job).
- `events/`: `EventBus` implementation per events.md delivery semantics (async, isolated handlers, namespace check on emit, optional schema validation).
- `plugins/`:
  - Registries: services (provide/get/find, conflict rule, `[services]` override), tools (register with name validation, the namespace-prefix rule and uniqueness; privileged `registerBuiltin` for reserved namespaces; `list(filter)`; `invoke(name, rawArgs, runCtx)`, which validates input with zod, enforces `minTier` against the **lowest tier in `runCtx.participants`**, applies `timeoutMs`, and converts throws into `{ error: true, content }`), skills, agents (with the built-in `general` agent defined in core.md), and provider registries with `llm.resolve(role)` that parses model refs from config.
  - Namespace checks: the `namespace` format, uniqueness and reserved names (`PLUGIN_NAMESPACE_INVALID`), applied to tools, emitted events and ws frame types.
  - `PluginHost`: `load(config, extra?: PluginDefinition[])`, i.e. dynamic `import()` in config order plus directly passed plugin objects (used by tests and by `bootstrap(opts)`), per-plugin config validation, `setup` → `start` → `stop` (reverse order, timeout), kind enforcement (`PLUGIN_KIND_VIOLATION`), `needs` check, rollback of a failed plugin's registrations, `plugins.required` handling, `plugin.failed` events.
  - The host receives the `http` and `ws` registries and the `deliveries` sink as constructor dependencies (implemented by other lanes). Tests use fakes.
  - `PluginDataStore` implementation built on the storage interface (`plugin_data` repository).

**Out:**
- HTTP/WS registries (C1), storage implementation (B1), turn logic (E1).

## Acceptance criteria

- [x] A `tool`-kind fixture plugin calling `ctx.http.route` fails setup with `PLUGIN_KIND_VIOLATION`, and the core continues.
- [x] `services.get` in `setup` throws a clear error. In `start`, it resolves another plugin's service.
- [x] A missing `needs` service fails that plugin's start with a message naming the service.
- [x] `tools.invoke` rejects bad input and insufficient tier without calling `run`, and times out a slow tool.
- [x] `llm.resolve('foreground')` returns the right provider and model id. An unknown provider prefix throws `CONFIG_INVALID` at load.
- [x] Event handler errors are isolated (test with two handlers, one throwing).
- [x] Config: unknown key → error, `env:` missing → error naming the key, overrides apply in precedence order.
- [x] `bun run check` passes.

## Outcome

**Built** (all under `packages/core/src/`, each folder exports its factories from `index.ts`):

- `shared/`: `createLogger({ level, clock, write?, fields? })` (JSON lines, levels, child loggers, `redactSecrets` for keys matching `/key|token|secret|password/i` at any depth), `systemClock`, `createIds({ clock, randomBytes? })` (monotonic prefixed ULIDs).
- `config/`: `configSchema` (zod, strict tables, every key defaulted, output checked at compile time against the frozen `KeithConfig`), `parseConfig(table, { env, flags })`, `loadConfig({ home, flags, env? })`, `keithPaths(home)`, `DEFAULT_PERSONA_TEMPLATE` / `defaultPersona(name)`. Order: `KEITH__` overrides, then `env:` resolution, then `[plugins."<id>"]` tables moved into `plugins.sections`, then CLI flags, then validation.
- `events/`: `createEventBus({ log, clock })` implementing `CoreEventBus` (microtask delivery, isolated handlers logged with the plugin id, `idle()`, plugin views with namespace checks on `emit`/`define`, schema validation at `emit`, `removeByPlugin`).
- `plugins/`: `createServiceRegistry`, `createToolRegistry`, `createSkillRegistry`, `createAgentRegistry` (built-in `general`, tool list computed live), `createProviderRegistries` (`llm.resolve`, `parseModelRef`), `createPluginDataStores` (on `PluginDataRepository`), `createPluginHost(deps, { importModule? })`. `test-fakes.ts` holds the in-memory fakes of C1 (http/ws), G1 (delivery sink) and B1 (`plugin_data` repo) plus a harness wiring the real A1 registries.
- 68 tests in core. `bun run check` is green (369 tests repo-wide).
- Dependency: `zod@^4.6.5` added to `@keith/core` with `bun add` (same version the SDK uses, resolves to 4.6.5).

**Decisions** (all documented in `plugin-system.md#host-rules` and `config.md`):

- The provider check runs at the end of `load`: every `models` role must resolve to a registered LLM provider, otherwise `load` throws `CONFIG_INVALID`. Host tests therefore always load the SDK's fake LLM plugin, and I1's bootstrap tests must too (with `models` set to `fake:<model>`).
- `tools.invoke` emits `tool.called` / `tool.completed`. **E1 should not emit them again.** Invoke also handles caller aborts: the call returns an error result and the tool's signal is aborted.
- `services.get`/`find` during `setup` throw `SERVICE_MISSING` with a message saying services are available from `start` on. `provide` after setup and `define` after setup are not blocked.
- `[services]` winner: only the named plugin's implementation is kept. Other providers are ignored and logged, even if the winner never loads.
- Import failures are logged and skipped. They are not in `status()`, because `PluginStatus.kind` can't be filled without a definition, and `plugin.failed` only allows the `setup` and `start` stages. A plugin config that fails validation counts as a `setup` failure.
- `loadConfig` throws `CONFIG_INVALID` when `config.toml` is missing. Tests and `bootstrap(opts)` can use `parseConfig` directly. The default model ref for every role is `deepseek:deepseek-flash`, as in the config.md example.
- `KEITH__` overrides can't target `[services]` or plugin sections. A `KEITH__` variable that matches no key is an error.

**Deviations and error-code choices** (no new codes were added, since that would be a contract change):

- Skills and agents reuse `TOOL_NAME_INVALID` / `TOOL_NAME_TAKEN`. Duplicate provider ids use `SERVICE_CONFLICT`. An event payload that fails its schema, and a `ctx.data.set` with a non-JSON value, throw `INTERNAL`. A contract task could add dedicated codes later.
- Docs disagree on tool names: the task file says a namespace mismatch on a tool is `PLUGIN_NAMESPACE_INVALID`, but the SDK fake context (and the "namespace prefix is checked at registration" line in plugin-api.md, next to `TOOL_NAME_INVALID`) use `TOOL_NAME_INVALID`. I followed the contract and the SDK fake. Events and ws frame types use `PLUGIN_NAMESPACE_INVALID`.
- `packages/core/package.json` and `bun.lock` changed only through `bun add` (agent-workflow parallelism rules 4 and 5).

**Follow-ups:**

- I1: wire `createLogger` / `createIds` / `loadConfig` / registries / `createPluginHost` in construction order. The logger writes to stdout. File rotation into `logs/` is not built.
- Integration: re-run `host.test.ts` against the real C1 http/ws registries and the B1 `plugin_data` repository.
