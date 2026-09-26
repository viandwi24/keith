---
id: P0-04
title: Freeze contracts and write core internal interfaces
phase: 0
wave: 4
lane: I
status: todo
owner: null
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

- [ ] `bun run typecheck` passes with all interface files.
- [ ] Every interface referenced by a phase-1 task's `reads` exists in code.
- [ ] Contract docs carry the frozen marker.
- [ ] `bun run plans --ready` lists all phase-1 wave-1 tasks.

## Outcome

_To be filled._
