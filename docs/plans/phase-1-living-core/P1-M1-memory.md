---
id: P1-M1
title: Memory v1 (visibility, recall, core memories, awareness digest)
phase: 1
wave: 1
lane: M
status: todo
owner: null
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

- [ ] I-4 test matrix passes, including a group viewer where one participant lacks access (the memory is hidden).
- [ ] `recall` never returns an invisible memory even if storage returns it (defense-in-depth test with a fake repository).
- [ ] `memory.forget` by a non-owner, non-subject person returns a tool error.
- [ ] `digest` for person B never contains the goal text of person A's `subject`-visibility task.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
