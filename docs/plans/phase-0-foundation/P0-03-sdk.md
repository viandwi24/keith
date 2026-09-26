---
id: P0-03
title: Implement @keith/sdk contracts and testing kit
phase: 0
wave: 3
lane: K
status: done
owner: claude
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

- [x] A sample plugin in `packages/sdk/test/fixtures/` using every registry type-checks.
- [x] `defineTool` rejects invalid names (`TOOL_NAME_INVALID`).
- [x] Fake LLM: aborting mid-stream throws `ProviderError('aborted')`.
- [x] The package depends only on `@keith/protocol` and `zod`.
- [x] `bun run check` passes.

## Outcome

**Built** (`@keith/sdk`, depends only on `@keith/protocol` and `zod@^4.6.5`)

- `src/plugin.ts`: `definePlugin` (identity, infers `ctx.config` from the schema's output type), `PluginDefinition`, `AnyPluginDefinition`, `PluginKind`, `PluginContext`, `ServiceMap` (augmentation point), `ServiceRegistry`, `ProviderRegistries`, `HttpRegistry`, `WsRegistry`, `DeliverySink`, `PluginDataStore`, plus the shared constants `PLUGIN_KINDS`, `KIND_REGISTRIES`, `PLUGIN_NAMESPACE_PATTERN`, `RESERVED_NAMESPACES`.
- `src/tools.ts`: `defineTool` (validates the name at definition time, `TOOL_NAME_INVALID`), `ToolDefinition`, `Tool`, `ToolRunContext`, `ToolResult`, `ToolAction`, `ToolRegistry`, `TOOL_NAME_PATTERN`, `DEFAULT_TOOL_TIMEOUT_MS`. `src/skills.ts` (`defineSkill`, `loadSkillInstructions`), `src/agents.ts` (`defineAgent`, `GENERAL_AGENT_ID`).
- `src/events.ts`: `CoreEventMap` for every phase-1 event, `EventMap` (augmentation point), `EventBus`, `KeithEvent`, `CORE_EVENT_NAMES` (with a compile-time completeness check), `CORE_EVENT_NAMESPACES`, `EVENT_NAME_PATTERN`.
- `src/providers/types.ts`: `LlmProvider`, `LlmRequest`, `LlmMessage`, `LlmEvent`, `LlmToolSpec`, `LlmToolCall`, `JsonSchema`, `ProviderError` (with default `retryable` per code) and the voice/realtime interfaces.
- `src/errors.ts`: `KeithError(code, message, { cause, details })`, `KEITH_ERROR_CODES`, `isKeithError`.
- `src/common.ts`: `Logger`, `Clock`, `ModelRole`, `Urgency`, `Visibility`, `DeliveryKind`, `TurnKind` (one definition that the core re-exports).
- `@keith/sdk/testing` (subpath export): `createFakeLlm` (scripted turns or request functions, delays, abort → `ProviderError('aborted')`, request recording, `fallback`, `push`), `fakeText` / `fakeToolCall` / `fakeDelay`, `createFakeLlmPlugin`, `createFakePluginContext` (in-memory registries that enforce kind, service, tool-name and namespace rules and record everything), `setupFakePlugin`, `createFakeClock`, `createMemoryLogger`.
- Tests (100): fake LLM (text, tool calls, finish handling, delays, concurrency, abort mid-stream and during a delay, recording, exhaustion), `defineTool` name table, `KeithError`/`ProviderError`, the fake context, and a sample plugin (`test/fixtures/sample-plugin.ts`) that uses every registry, augments `ServiceMap` and `EventMap`, and is loaded end to end. Type tests (`@ts-expect-error`) prove `ctx.config` inference. Doc-sync tests check `KEITH_ERROR_CODES` against plugin-api.md, provider error codes against providers.md, and `CORE_EVENT_NAMES` against events.md.

**Contract clarifications made in the docs**

- `plugin-api.md`: which `PluginDefinition` fields are optional; `ctx.config` is the zod output type; kind violations throw synchronously; `minTier` is required and `requires`/`timeoutMs` have defaults (`[]`, 30 000 ms); `onAction` signature and `ToolAction`; `ToolRunContext` ids are typed; `defineTool` validates the pattern and registration checks the prefix; `KeithError` takes optional `details`; a new "Testing kit" section.
- `providers.md`: the `ProviderError` constructor and default `retryable`; `JsonSchema`; the phase-3 placeholder types.
- `events.md`: typed ids in payloads, the meaning of `error`/`code`/`kind` fields, and the code names.

**Deviations and notes**

- Added `src/common.ts` (not in the task list) for `Logger`, `Clock` and the small domain enums, so `plugin.ts`, `events.ts` and the core share one definition.
- Added test helpers beyond the list (`createFakeLlmPlugin`, `setupFakePlugin`, `createFakeClock`, `createMemoryLogger`) because P1-D1, P1-I1 and P1-I2 name exactly these needs (loading a plugin against a fake context, booting the core with a fake LLM plugin, a fake clock).
- `Clock` stays `{ now(): number }` as the contract says. Timer-based behavior (stall watchdog, arrival hold, ticks) is tested with Bun's `jest.useFakeTimers()`, which Bun 1.3 supports.
- Bun 1.3 installs workspaces with the isolated linker, so a package cannot import itself by name. The sample plugin therefore augments `'../../src/index.ts'`; plugins that depend on `@keith/sdk` write `declare module '@keith/sdk'` (the same module).

