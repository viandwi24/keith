---
id: P4-I1
title: "Integration: wire reflection, summaries, reminders and briefing skills into bootstrap"
phase: 4
wave: 3
lane: I
status: in-progress
owner: agent-P4-I1
depends: [P4-S1, P4-A1, P4-B1, P4-C1, P4-D1, P4-E1]
owns:
  - packages/core/**
  - packages/sdk/**
  - packages/protocol/src/**
  - plugins/**
  - scripts/**
  - package.json
  - .github/**
reads:
  - docs/plans/phase-4-memory/README.md
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/config.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/config.md
  - docs/architecture/storage.md
  - docs/architecture/overview.md
  - docs/architecture/repository.md
  - docs/concept/scenarios.md
scenarios: [S-1, S-3]
---

# P4-I1: Phase-4 integration

## Goal

A real `keith start` reflects on idle threads, keeps summaries, fires reminders and offers the default briefing skill, with every phase-3 test unchanged. `keith backup` / `restore` work on a home the real core wrote.

## Scope

**In:**
- **`bootstrap.ts`**, following the core.md construction order (update it):
  - Step 7 builds `createReflection(...)` and `createThreadSummaries(...)` from memory, `runLoop`, `scheduling.scheduler`, repositories, events and config.
  - Step 10 passes `reminders: { service: scheduling.reminders, config, clock }` (`ReminderToolsDeps`, see the P4-K1 Outcome) to `registerBuiltins`.
  - Step 12 starts both memory jobs after `scheduling.start()`.
  - Shutdown stops them (aborting running passes) before scheduling stops. A start that fails tears them down.
- `createContextBuilder` gets the `threads` repo and `memory` config (P4-B1's new deps).
- `keith setup`: no new question. The written `config.toml` shows `[memory.reflect]`, `[memory.summary]` and `[mind.reminder]` with their defaults, as comments. `cli.test.ts` is updated.
- **Integration tests** in `packages/core/test/` (the real core, a scripted `fake` provider with separate `fake:chat` and `fake:utility` models, fake clock):
  - `memory-jobs.test.ts`:
    - A conversation, then idle past `idleMinutes` plus a tick → a `utility` request with the thread's messages, then an `inferred` memory in the database, and `memory.reflected`.
    - A thread longer than `recentMessages + minMessages` → `threads.summary` set, and the next turn's system prompt holds `# Earlier in this thread`.
  - `reminders.test.ts`:
    - The model calls `reminder.set({ inMinutes: 1 })`.
    - Advance the clock, tick → a proactive assistant message delivers it (`delivery.delivered`, kind `reminder`).
    - A restart between set and due still fires it.
  - `briefing-skill.test.ts`: with `briefing = "auto"`, the briefing turn's context lists `morning_briefing` with the load hint. A plugin skill with the same name replaces it.
  - `backup.test.ts`: backup a home that the real core wrote (with memories and a pending reminder), restore it into a new home, start → the same state is there.
- **Integration fixes** in any lane's code, recorded per lane in the Outcome (the P3-I1 table).
- **Docs:**
  - No `> Planned (phase 4…)` marker left in `docs/architecture`.
  - memory.md, core.md and config.md describe what is built.
  - overview.md: memory jobs and reminders in the component overview.
  - repository.md: `memory/reflect/`, `memory/summary/`, `scheduler/reminders.ts`, `builtins/skills/`, `cli/backup.ts`.
  - scenarios.md S-3: the phase-4 test description.

**Out:** the S-3 semantic e2e and the human run (P4-I2).

## Acceptance criteria

- [ ] Every phase 0–3 test passes unchanged, including e2e S-1, S-2, S-3 (restart), S-4, S-7 and S-8.
- [ ] The four integration tests above pass 5 runs in a row.
- [ ] Shutdown with a reflection pass running ends within `plugins.stopTimeoutMs`, and the pass writes nothing (`bootstrap.test.ts`).
- [ ] `grep -rn "Planned (phase 4" docs/architecture` finds nothing.
- [ ] `bun run check` passes.

## Notes

- The e2e harness maps `utility` to `fake:chat`. Tests that count `fake:chat` requests will see reflection and summary calls once the jobs run. Either give the utility role its own scripted model in the harness (P4-I2 owns `tests/e2e/**`), or make sure `idleMinutes` and the tick keep the jobs out of the old tests. Record which.
- Reflection and summaries are on by default. For a home where the utility model is a paid API, config.md must say what they cost roughly (one completion per idle thread per idle period, and one per `minMessages` rows).


## Wiring notes from wave 2 (coordinator)

- D1: `createSkillRegistry({ log })` in bootstrap, so "plugin replaces a default skill" / "default restored" are logged.
- B1: build `createThreadSummaries({ config, repos, runLoop, scheduler: scheduling.scheduler, events, clock, ids, log })` in step 7; `job.start()` after startup, `job.stop()` at shutdown. `ThreadSummariesDeps.repos` now also needs `persons` (full `repos` covers it).
- C1: remove the shared phase-4 `> Planned` note in config.md that names P4-B1/P4-C1 (and any other P4 lane) once wired.
- E1: add a reminder to `seed` in `cli/backup-testing.ts` and assert it survives in `restore.test.ts`; export `MIGRATIONS_FOLDER` from `storage/index.ts` and import it from there in `cli/backup.ts`.
- K1: `reminders: { service: scheduling.reminders, config, clock }` to `registerBuiltins`.
- A1: wire `createReflection` in bootstrap (start after startup, stop at shutdown); remove memory.md's `> Planned (phase 4, P4-I1)` line and core.md's shared P4-A1/P4-B1 Planned note ("`reflect` returns null"). Add an integration test with the real storage `listForReflection` / `range` / `setReflectedThrough` (A1 tested only against fakes).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
