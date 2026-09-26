---
id: P1-M1
title: Memory v1 (visibility, recall, core memories, awareness digest)
phase: 1
wave: 1
lane: M
status: review
owner: agent-P1-M1
depends: [P0-04]
owns:
  - packages/core/src/memory/**
  - packages/core/src/builtins/memory.ts
reads:
  - docs/architecture/memory.md
  - docs/concept/model.md
  - docs/architecture/core.md
updates:
  - docs/architecture/memory.md
scenarios: [S-3, S-4]
---

# P1-M1: Memory v1

## Goal

The Mind can remember facts and recall them, and nothing is ever shown to a person who shouldn't see it.

## Scope

**In:**
- `visibility.ts`: the single pure function `isVisible(memory, viewer, persons)` implementing the table in memory.md, plus `toStorageFilter(viewer)` returning the `MemoryFilter` defined in storage.md. Exhaustive table-driven tests over tiers × visibilities × direct/group viewers.
- `MemoryService`: `write` (defaults per memory.md), `recall` (storage search + `isVisible` double-check), `core` (pinned + visible, capped by `memory.coreMaxChars`), and `digest` (active tasks and threads described in detail only when visible, otherwise generic; guests get counts only; at most 5 lines).
- `builtins/memory.ts`: `memory.remember` (content, subject, visibility, pinned), `memory.recall` (query), `memory.forget` (owner or subject only).
- `index(viewer)` on `MemoryService` (subjects and topics that exist but aren't in `core()`).
- `digest` builds its activity picture from `thread.state_changed` and `task.*` events plus repositories. It never calls the mind (core.md "Construction order").

**Out:**
- Reflection and summaries (phase 4). Vector search.

## Acceptance criteria

- [x] I-4 test matrix passes, including a group viewer where one participant lacks access (the memory is hidden).
- [x] `recall` never returns an invisible memory even if storage returns it (defense-in-depth test with a fake repository).
- [x] `memory.forget` by a non-owner, non-subject person returns a tool error.
- [x] `digest` for person B never contains the goal text of person A's `subject`-visibility task.
- [x] `bun run check` passes.

## Outcome

**Built** (all under `packages/core/src/memory/` plus `builtins/memory.ts`):
- `visibility.ts`: `isVisible(target, viewer, facts)`, `admits`, `toStorageFilter(viewer, facts)`, `loadVisibilityFacts(viewer, repos)`. `facts` is a map PersonId → `{ tier, threadIds }` (the "persons" argument of the scope, extended with thread membership because `thread` visibility needs it and the function must stay pure).
- `service.ts`: `MemoryStore implements MemoryService` (`write`, `recall`, `core`, `index`, `digest`) plus `forget(...)` for the built-in and `stop()` to unsubscribe from the bus. Deps: `repos` (memories, persons, threads, tasks), `events`, `config.memory`, `clock`, `ids`, `log`.
- `digest.ts`: `ActivityTracker` (subscribes to `thread.state_changed` and `task.*`) and `buildDigest`. Never calls the mind.
- `index.ts`: the folder's public surface (R-3).
- `builtins/memory.ts`: `createMemoryTools({ memory, persons })` returns `memory.remember`, `memory.recall`, `memory.forget` (defined with `defineTool`, zod input). Registration via `registerBuiltin` is left to bootstrap.
- `testing/fakes.ts`, `testing/fixture.ts`: in-memory fakes of the memories, persons, threads and tasks repositories, the core event bus and `Ids`, built from the frozen `types.ts` interfaces.
- Tests: `visibility.test.ts` (I-4 table for direct and group viewers, intersection property and filter/`isVisible` agreement over the full visibility × subject × thread × viewer matrix), `service.test.ts`, `builtins.test.ts` (the builtins test lives here because `builtins/` only owns `memory.ts`).

**Decisions** (documented in memory.md):
- Empty viewer, or a participant unknown to the persons table, sees nothing.
- `memory.remember` default when the subject is not the speaker in a direct thread: `thread` (stays in the speaker's thread). Guests can't write `household`, non-owners can't write `owner`.
- Inside a task, `memory.remember` writes `source: 'inferred'` with no author.
- `memory.forget` on a memory the caller can't see returns "not found" (even for the owner), so existence never leaks.
- `write` validation failures throw `KeithError('INTERNAL')`: the central list has no generic validation code for internal calls.
- Digest: detail for visible tasks and for busy threads that contain every viewer participant; hidden items become generic counts ("someone else", no tier or names); any guest in the viewer means counts only.
- Digest wording uses "someone else" instead of memory.md's earlier example "another household member", to avoid revealing a tier.

**Dependencies:** `zod@^4.6.5` added to `@keith/core` with `bun add` (same range as `@keith/sdk`).

**Deviations:** `isVisible`/`toStorageFilter` take a facts map that includes thread membership (not only persons). No contract or `types.ts` changes.

**Follow-ups:** bootstrap (integration task) must construct `MemoryStore` and register `createMemoryTools(...)` with `tools.registerBuiltin`, and call `stop()` on shutdown. P1-B1's real `MemoriesRepository.search/list` must match `matchesFilter` in `memory/testing/fakes.ts` (the SQL in storage.md).
