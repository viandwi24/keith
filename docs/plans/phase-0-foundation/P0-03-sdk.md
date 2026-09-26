---
id: P0-03
title: Implement @keith/sdk contracts and testing kit
phase: 0
wave: 3
lane: K
status: todo
owner: null
depends: [P0-02]
owns:
  - packages/sdk/**
reads:
  - docs/contracts/plugin-api.md
  - docs/contracts/providers.md
  - docs/contracts/events.md
  - docs/architecture/plugin-system.md
updates:
  - docs/contracts/plugin-api.md
  - docs/contracts/providers.md
  - docs/contracts/events.md
scenarios: []
---

# P0-03: Implement @keith/sdk contracts and testing kit

## Goal

Everything a plugin author and a core lane need to build against, without any core implementation: types, `define*` helpers, errors, and a testing kit with a scripted fake LLM.

## Scope

**In:**
- `plugin.ts`: `definePlugin` (including the required `namespace` field), `PluginKind`, `PluginContext`, registry interfaces, `ServiceMap` and `EventMap` augmentation points.
- `tools.ts`, `skills.ts`, `agents.ts`: `defineTool` (validates name format at definition time), `defineSkill`, `defineAgent`, and their types. `ToolRunContext`, `ToolResult`.
- `events.ts`: `CoreEventMap` typed from [events.md](../../contracts/events.md) (phase-1 events).
- `providers/types.ts`: `LlmProvider`, `LlmRequest`, `LlmMessage`, `LlmEvent`, `ProviderError`, and voice interfaces as types only.
- `errors.ts`: `KeithError` and the central error code union from [plugin-api.md](../../contracts/plugin-api.md#errors).
- `testing/fake-llm.ts`: `createFakeLlm(script)`. The script is a list of turns, and each turn is a list of `LlmEvent`s, or a function of the request that returns events. It supports delays (to test concurrency and cancellation) and records every request it receives for assertions.
- `testing/fake-context.ts`: `createFakePluginContext({ kind, config })` with in-memory registries, for plugin unit tests.
- Subpath export `@keith/sdk/testing`.

**Out:**
- `createOpenAICompatibleLlm` (task P1-D1).
- Any real registry or plugin host implementation (P1-A1).

## Deliverables

- Types compile and are exported. `definePlugin` infers `ctx.config` from the zod schema (type test).
- The fake LLM has tests covering text streaming, tool calls, delays, abort, and request recording.

## Acceptance criteria

- [ ] A sample plugin in `packages/sdk/test/fixtures/` using every registry type-checks.
- [ ] `defineTool` rejects invalid names (`TOOL_NAME_INVALID`).
- [ ] Fake LLM: aborting mid-stream throws `ProviderError('aborted')`.
- [ ] The package depends only on `@keith/protocol` and `zod`.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
