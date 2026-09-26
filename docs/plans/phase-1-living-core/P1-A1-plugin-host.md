---
id: P1-A1
title: Plugin host, registries, event bus, config
phase: 1
wave: 1
lane: A
status: in-progress
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

- [ ] A `tool`-kind fixture plugin calling `ctx.http.route` fails setup with `PLUGIN_KIND_VIOLATION`, and the core continues.
- [ ] `services.get` in `setup` throws a clear error. In `start`, it resolves another plugin's service.
- [ ] A missing `needs` service fails that plugin's start with a message naming the service.
- [ ] `tools.invoke` rejects bad input and insufficient tier without calling `run`, and times out a slow tool.
- [ ] `llm.resolve('foreground')` returns the right provider and model id. An unknown provider prefix throws `CONFIG_INVALID` at load.
- [ ] Event handler errors are isolated (test with two handlers, one throwing).
- [ ] Config: unknown key → error, `env:` missing → error naming the key, overrides apply in precedence order.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
