---
id: P5-E1
title: "Visibility everywhere: group viewers across recall, core, digest, reflection and tasks"
phase: 5
wave: 2
lane: E
status: done
owner: agent-P5-E1
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

- [x] `memory/audit.test.ts` covers every viewer × read path × visibility above, and passes.
- [x] `scheduler/tasks.test.ts`: a task started in a group has the group's participants in `runCtx`, the lowest tier applies to its tools, and its result delivery targets the group thread.
- [x] Reflection tests: a group pass writes only `thread` memories and no card.
- [x] `grep -rn "phase 5" docs/architecture/memory.md` finds only notes owned by other lanes (the person-deletion list).
- [x] `bun run check` passes.

## Notes

- `thread` visibility counts current participants (`left_at` is null). The audit uses the real storage filter for that reason. The fakes don't model `left_at`.
- `ThreadsRepository.removeParticipant` is P5-S1's, built in parallel. Build the fixture's "left" state with P5-K1's test-only helper `markParticipantLeft` (`storage/testing.ts`) instead. P5-I1 reruns the audit on `main`.

## Outcome

**Built**
- **Audit** (`memory/audit.test.ts`, 73 tests, real migrated database from `createTestDb()`): Tony (owner), Pepper, Rhodey (members), Happy (guest); four direct threads; Mission (Tony, Pepper, Rhodey), Party (with Happy), Workshop (Rhodey left, built with `markParticipantLeft`). One memory of every visibility (subject about each person, `thread` in each of the 7 threads, `household`, `owner`) and a task of every visibility (a private task per person, a `thread` task per group). The expected rows are a hand-written table, itself checked against `isVisible` over hand-written facts, so the audit doesn't trust storage's own facts. For all 7 viewers: `recall`, `core`, `index` (exact set of names and topics, no hidden subject or topic), `memory.recall`, `memory.forget` (hidden = not found, even for the owner; visible = forgotten or forbidden by the owner/subject rule), `task.status` (list and by id), `task.cancel`. Digest matrices: each task alone, and each busy thread, seen from every viewer (detail only where admitted, the exact count line otherwise, counts only with a guest), plus the three S-4 cases the task names. Leaving: after `markParticipantLeft(Mission, Rhodey)`, Rhodey's viewer and a stale three-person viewer no longer admit Mission's `thread` memory (recall, core, index) or its task; Tony, Pepper and Tony+Pepper still do. `memory.remember` in a group: `thread` by default, `household` refused from a guest, `subject` about another participant refused, another participant named as subject → `thread` with that subject.
- **Gap fixed: `task.status` / `task.cancel` leaked private tasks into groups.** The old rule admitted "tasks of the calling person", so Tony in the Mission group saw (and could cancel) his private task, and the list showed it to everyone there. Now both tools admit exactly what I-4 admits for the call's viewer (all participants), through `TaskManager.visibleTo(tasks, viewer)` (`scheduler/tasks.ts`, `loadVisibilityFacts` + `isVisible` on `taskTarget(task)`). `TaskToolsDeps.tasks` is `TaskService & Pick<TaskManager, 'visibleTo'>`; bootstrap already passes `scheduling.tasks` (a `TaskManager`), so `builtins/index.ts` and `bootstrap.ts` needed no change. Consequence: in a direct thread a person also sees (and may cancel) the tasks of groups they are currently in.
- **Gap fixed: `memory.remember` in a group** accepted an explicit `subject` memory about another participant (hidden from everyone who heard it). It now refuses it; the speaker's own `subject` memory is still allowed.
- **Tasks in groups** (`scheduler/tasks.ts`): a task with `thread` visibility runs with `runCtx.participants` = the group's current participants when it starts running (a group nobody is in any more falls back to the task's person), so the registry's lowest-tier check and I-4 memory reads apply to the whole group. The context names the group and holds every participant's card. Its commitment is in the group thread, so `task_result` / `task_failed` go there. Tests (`scheduler/tasks.test.ts`): participants and cards (a leaver excluded), result and failure delivery to the group, the empty-group fallback, and the lowest tier with the real `RunLoop` and tool registry (a `member` tool answers `TIER_INSUFFICIENT` with a guest in the group, runs without). `scheduler/task-tools.test.ts`: in a group the tools see the group task and never a private one, anyone in the group may cancel it, a non-participant can't see it.
- **Digest:** a visible group task reads "Working on a background task for the group "<title>": …" instead of naming the starter. `taskTarget` (`memory/visibility.ts`, exported from `memory/index.ts`) replaces the inline target.
- **Reflection:** new test "a group pass writes only thread memories, keeps about as the subject, and updates no card". The existing tests already covered group cards, `household` in groups and the I-3 input filter; no code change was needed.
- **Helpers:** `seedGroup` in `scheduler/testing/fakes.ts`; `createHarness({ runLoop })` in `scheduler/testing/harness.ts`.
- **Docs:** memory.md: the read-path list names index and the four tools, a new "In group threads" block (private items never in groups, owner/household with guests, where group items show, leaving, digest, reflection, the audit), the `memory.remember` group rule, the digest wording; the "(phase 5)" note in Reflection is gone, so `grep "phase 5"` finds only P5-S1/P5-A1's deletion note. core.md Tasks: who a task runs for, its context, delivery to the group, and the new `task.status` / `task.cancel` rule (the "(the group's participants in phase 5)" note is gone).

**Decisions**
- "Exactly what `isVisible` admits" for the task tools (the task's words), not "own tasks ∩ I-4": the tools now admit group tasks from a participant's direct thread too.
- Group participants are read when the task starts running, not stored at `task.start` (`Task` has no participants field, and `shared/types.ts` isn't owned). A restart re-reads them.
- The memory tools still call a context with more than one distinct participant a group (`ToolRunContext` has no thread kind). A group with one current participant left gets direct-thread defaults (a fact about the speaker is `subject`), which is narrower, never wider.

**Deviations:** none. No file outside `owns` (plus this task file and memory.md / core.md) changed. No ADR.

**Notes for other lanes**
- **P5-I1:** nothing to wire; `registerBuiltins` gets `tasks: scheduling.tasks` as today. Rerun `memory/audit.test.ts` on `main` after P5-S1 (it uses `markParticipantLeft`; it could switch to `threads.removeParticipant`).
- **P5-C3:** the digest and `memory.core/index/recall` already take the full group viewer; pass every current participant.
- **P5-C1 / P5-C2:** core.md's Group threads section could point to [Tasks](../../architecture/core.md#tasks) and memory.md's "In group threads" for tasks and memory in groups.
