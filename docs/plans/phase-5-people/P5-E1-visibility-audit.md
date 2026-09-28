---
id: P5-E1
title: "Visibility everywhere: group viewers across recall, core, digest, reflection and tasks"
phase: 5
wave: 2
lane: E
status: todo
owner: null
depends: [P5-K1]
owns:
  - packages/core/src/memory/**
  - packages/core/src/scheduler/tasks.ts
  - packages/core/src/scheduler/tasks.test.ts
  - packages/core/src/scheduler/task-tools.test.ts
  - packages/core/src/scheduler/testing/**
  - packages/core/src/builtins/task.ts
  - packages/core/src/builtins/memory.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/decisions/0014-reflection-writes-conservative-inferred-memories.md
  - docs/concept/model.md
  - docs/architecture/memory.md
  - docs/architecture/core.md
updates:
  - docs/architecture/memory.md
  - docs/architecture/core.md
scenarios: [S-4, S-6]
---

# P5-E1: Visibility everywhere

## Goal

Every read path that feeds a context or a tool answer admits only what **every** current participant may see (I-3, I-4), for direct threads, groups with guests, and groups where someone just left. Tasks started in a group run for the group and report back to it. S-4's phase-5 promise holds by construction, and a table-driven audit proves it.

## Scope

**In:**
- **Audit test** (`memory/audit.test.ts`, a real migrated database from `createTestDb()`):
  - The fixture: Tony (owner), Pepper (member), Rhodey (member), Happy (guest); their direct threads; a group Mission (Tony, Pepper, Rhodey); a group with Happy; a group Rhodey left.
  - One memory of every visibility (`subject` about each person, `thread` in each thread, `household`, `owner`), and tasks of every visibility.
  - For every viewer, every read path returns exactly the rows `isVisible` admits:
    - `recall` and `core`;
    - `index`, which names no hidden subject or topic;
    - `digest`: details only where every viewer participant may see them, counts only with a guest;
    - the `memory.recall` and `memory.forget` tools (forgetting a hidden memory reads as not found);
    - `task.status` and `task.cancel`.
  - Test titles name the invariant ("I-4: Tony's subject memory is hidden in the Mission group").
- **Leaving:** after `removeParticipant`, the leaver's viewers no longer admit the group's `thread` memories, and the remaining participants still do (S-6 "Leaving").
- **Tasks in groups** (`scheduler/tasks.ts`, `builtins/task.ts`):
  - A task started in a group runs with `runCtx.participants` = the group's current participants when it starts (core.md's phase-5 note).
  - Its tool tier check uses the lowest of their tiers.
  - Its visibility is `thread`, and its result is delivered to the group thread through its commitment. `task.status` / `task.cancel` in the group see it.
  - Its context carries the cards of all those participants, not only the starter's.
- **Reflection in groups** (`memory/reflect/`): a group pass writes only `thread` memories (keeping `about` as the subject), never updates a card, and its input holds only memories visible to every participant (ADR-0014). Add the group cases to its tests where missing.
- **Awareness digest:** Tony's direct thread describes the busy Mission group in detail (he is a participant). Pepper's direct thread describes Tony's private task only as a count. A group with a guest gets counts only.
- **`memory.remember` in a group** writes `thread` by default, refuses `household` from a guest, and never writes `subject` about another participant (memory.md defaults). Confirm or fix.
- Fix every gap the audit finds inside `owns`. A gap outside `owns` is a blocker for P5-I1 (record it).
- memory.md and core.md: state the group rules where they are only implied, and remove the phase-5 notes this lane covers (tasks in groups).

**Out:** the context builder's sections (P5-C3), turn logic (P5-C2), file access (unchanged rule, checked in P5-I2).

## Acceptance criteria

- [ ] `memory/audit.test.ts` covers every viewer × read path × visibility above, and passes.
- [ ] `scheduler/tasks.test.ts`: a task started in a group has the group's participants in `runCtx`, the lowest tier applies to its tools, and its result delivery targets the group thread.
- [ ] Reflection tests: a group pass writes only `thread` memories and no card.
- [ ] `grep -rn "phase 5" docs/architecture/memory.md` finds only notes owned by other lanes (the person-deletion list).
- [ ] `bun run check` passes.

## Notes

- `thread` visibility counts current participants (`left_at` is null). The audit uses the real storage filter for that reason. The fakes don't model `left_at`.
- `ThreadsRepository.removeParticipant` is P5-S1's, built in parallel. Build the fixture's "left" state with P5-K1's test-only helper `markParticipantLeft` (`storage/testing.ts`) instead. P5-I1 reruns the audit on `main`.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
