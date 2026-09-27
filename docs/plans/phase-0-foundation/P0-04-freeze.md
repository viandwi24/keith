---
id: P0-04
title: Freeze contracts and write core internal interfaces
phase: 0
wave: 4
lane: I
status: done
owner: claude
depends: [P0-03]
owns:
  - docs/contracts/**
  - packages/protocol/**
  - packages/sdk/**
  - packages/core/src/shared/types.ts
  - packages/core/src/config/types.ts
  - packages/core/src/plugins/types.ts
  - packages/core/src/events/types.ts
  - packages/core/src/storage/types.ts
  - packages/core/src/server/types.ts
  - packages/core/src/mind/types.ts
  - packages/core/src/scheduler/types.ts
  - packages/core/src/memory/types.ts
reads:
  - docs/concept/model.md
  - docs/architecture/core.md
  - docs/architecture/storage.md
  - docs/architecture/memory.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
updates:
  - docs/architecture/core.md
  - docs/contracts/README.md
scenarios: []
---

# P0-04: Freeze contracts and write core internal interfaces

## Goal

Lock the v1 contracts and put the core's internal interfaces in code, so all eight phase-1 lanes can build against types instead of against each other.

## Scope

**In:**
- Review `packages/protocol` and `packages/sdk` against `docs/contracts/*`. Fix any disagreement (either side), then add a "**Frozen: v1 (date)**" line to each contract doc and to `contracts/README.md`.
- Create each `types.ts` in `owns` with the interfaces from [core.md](../../architecture/core.md#internal-interfaces), plus:
  - `shared/types.ts`: every type in core.md "Shared domain types": id types, `Tier`, `TurnState`, `Lane`, `ModelRole`, `Urgency`, `Visibility`, `Viewer`, `Task`, `TaskSpec`, `Commitment`, `NewCommitment`, `Delivery`, `NewDelivery`, `Memory`, `NewMemory`, and the `Logger`, `Clock`, `Ids` interfaces.
  - `config/types.ts`: the `KeithConfig` type (a zod schema lives in P1-A1; this is the inferred shape as an interface).
  - `storage/types.ts`: repository interfaces for every phase-1 table in [storage.md](../../architecture/storage.md), the `MemoryFilter` type, `memories.search(text, filter)` / `memories.list(filter)`, and a `Db` handle type used only by bootstrap.
  - `server/types.ts`: `AttachmentRegistry`, `NodeSink`, `Presence`.
  - `plugins/types.ts`: `PluginHost` (`load`, `startAll`, `stopAll`, `status`) and internal registry APIs the rest of the core needs (`tools.list()`, `tools.invoke()`, `tools.registerBuiltin()`, `agents.get()`, `skills.list()`, `providers.llm.resolve(role)`).
  - `mind/types.ts`: `ThreadManager`, `Arrival`, `OpenedThread`, `RunLoop` and `RunLoopEvent`, `ContextBuilder`.
  - `scheduler/types.ts` and `memory/types.ts` exactly as in core.md.
- Update `core.md` so its interface block exactly matches the code.

**Out:**
- Any implementation.

## Acceptance criteria

- [x] `bun run typecheck` passes with all interface files.
- [x] Every interface referenced by a phase-1 task's `reads` exists in code.
- [x] Contract docs carry the frozen marker.
- [x] `bun run plans --ready` lists all phase-1 wave-1 tasks.

## Outcome

**Contract review and freeze**

- Reviewed `packages/protocol` and `packages/sdk` against every doc in `docs/contracts/`. P0-02 and P0-03 had already brought the docs and code into line, and tests now keep them there: the doc-example and frame-table tests (protocol), and the error-code, provider-error-code and event-name tests (sdk). No further disagreement was found.
- Added **Frozen: v1 (2026-09-26)** to `protocol.md`, `events.md`, `plugin-api.md`, `providers.md`, `ui-blocks.md` and `contracts/README.md`. `README.md` now also says which tests enforce rule 4.

**Core internal interfaces** (types only, no implementation)

- `shared/types.ts`: `Lane`, `Viewer`, `Ids`, `Task`/`TaskStatus`/`TaskSpec`, `Commitment`/`CommitmentStatus`/`NewCommitment`, `Delivery`/`DeliveryStatus`/`NewDelivery`, `Memory`/`MemorySource`/`NewMemory`. Id types, `Tier`, `TurnState`, `PersonDto`, `UiBlock` are re-exported from `@keith/protocol`; `Logger`, `Clock`, `ModelRole`, `Urgency`, `Visibility`, `DeliveryKind`, `TurnKind` from `@keith/sdk`, so each has exactly one definition.
- `config/types.ts`: `KeithConfig` (every key in config.md), `ModelRef`, `BriefingMode`, `KeithPaths`, `ConfigFlags`.
- `events/types.ts`: `CoreEventBus` (the sdk `EventBus` plus `forPlugin`/`removeByPlugin` and `idle()`).
- `plugins/types.ts`: `PluginHost` (`load`, `startAll`, `stopAll`, `status`), `PluginHostDeps`, `PluginOwner`, `PluginScoped<T>`, and the core registries: `CoreToolRegistry` (`registerBuiltin`, `get`, `list(filter)`, `invoke`), `CoreSkillRegistry` (`list`), `CoreAgentRegistry` (`get`), `CoreServiceRegistry`, `CoreProviderRegistries` (`llm.resolve(role)`).
- `storage/types.ts`: a repository per phase-1 table (`persons`, `relationships`, `auth_tokens`, `nodes`, `threads` + `thread_participants`, `messages` with the per-role record union, `tasks`, `commitments`, `deliveries`, `memories` with `search(text, filter)` / `list(filter)`, `plugin_data`), `MemoryFilter`, `Repositories`, and the bootstrap-only `Db` handle.
- `server/types.ts`: `AttachmentRegistry`, `NodeSink`, `Presence` as in core.md, plus `CoreServer` (plugin-scoped `http`/`ws`, `listen`, `stop`).
- `mind/types.ts`: `ThreadManager`, `Arrival`, `OpenedThread`, `RunLoop` (+ `RunLoopArgs`, `RunLoopResult`), `RunLoopEvent`, `ContextBuilder` (+ `BuiltContext`).
- `scheduler/types.ts` and `memory/types.ts`: exactly as core.md had them.
- `core.md` "Internal interfaces" is now the code of each `types.ts` with imports left out.
- A scan of the phase-1 task files and the architecture docs they read finds no PascalCase interface name that is missing from code. `bun run plans --ready` lists the eight wave-1 tasks.

**Decisions and deviations**

- Interfaces added beyond core.md's list, because a lane needs to build against them: `PluginScoped<T>` (the host gets http, ws, deliveries and data from other lanes and must be able to roll a plugin back), `PluginHostDeps`, `CoreServer`, `ToolInvocation`/`ToolFilter` (what `tools.invoke`/`tools.list` take), `KeithPaths`, and `TaskStatus`/`CommitmentStatus`/`DeliveryStatus`/`MemorySource` aliases.
- `Ids.next` takes `P extends IdPrefix` instead of any string, so a typo in a prefix is a type error.
- `KeithConfig.plugins.sections` holds the `[plugins."<id>"]` tables. In TOML they sit next to `enabled`/`required`; the loader (P1-A1) moves them. P1-A1 should mention this in config.md.
- Repositories are all `async`, even though `bun:sqlite` is synchronous, so callers don't depend on the driver and fakes stay simple.
- `DeliveriesRepository.markDelivered(ids, deliveredAt)` takes no `messageId`, because storage.md's `deliveries` table has no column for it. `DeliveryQueue.markDelivered(ids, messageId)` uses the id for the `delivery.delivered` event. If the link should be persisted, that's a storage.md change (open question below).
- Optional parameters that callers may forward are typed `?: T | undefined` (e.g. `ThreadManager.open({ threadId })`), which is friendlier under `exactOptionalPropertyTypes`.
- `phase-1-living-core/README.md` says `core/src/*/types.ts` are frozen in wave 1, but P1-A1's `owns` (`packages/core/src/shared/**`, `config/**`, `plugins/**`, `events/**`) includes four of those files. Precedence doesn't settle this (both are plans). Lanes should treat those `types.ts` files as frozen and record a blocker for any change.

**Open questions for the coordinator**

1. Persist `deliveries.message_id`? (See above.)
2. Should `core.md`'s interface blocks be checked against the code automatically (a small script in `scripts/`, like the contract doc tests)? Today they are kept in sync by hand.

