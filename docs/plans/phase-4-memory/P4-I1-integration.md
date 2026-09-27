---
id: P4-I1
title: "Integration: wire reflection, summaries, reminders and briefing skills into bootstrap"
phase: 4
wave: 3
lane: I
status: review
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

- [x] Every phase 0–3 test passes unchanged, including e2e S-1, S-2, S-3 (restart), S-4, S-7 and S-8.
- [x] The four integration tests above pass 5 runs in a row.
- [x] Shutdown with a reflection pass running ends within `plugins.stopTimeoutMs`, and the pass writes nothing (`bootstrap.test.ts`).
- [x] `grep -rn "Planned (phase 4" docs/architecture` finds nothing.
- [x] `bun run check` passes.

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

A real `keith start` now runs reflection on idle threads, keeps thread summaries, fires reminders and offers the default `morning_briefing` skill. Every phase 0–3 test passes unchanged, e2e included.

**Built**
- **`bootstrap.ts`**, in the core.md construction order:
  - Step 3: `createSkillRegistry({ log: log.child({ component: 'skills' }) })`.
  - Step 7: `createReflection(...)` and `createThreadSummaries(...)`, each with the full `config` and `repos`, `memory` (reflection only), `runLoop`, `scheduling.scheduler`, `events`, `clock`, `ids` and a child logger.
  - Step 10: `registerBuiltins` gets `reminders: { service: scheduling.reminders, config, clock }`.
  - Step 12: both jobs `start()` right after `scheduling.start()`. Each start pushes a closer, so a failed start (e.g. `server.listen()`) stops them before scheduling.
  - Shutdown: `reflection.job.stop()` and `summaries.job.stop()` (unsubscribe, abort, await) after presence and before scheduling.
  - `createContextBuilder` already got the full `config` and `repos`, so B1's new deps needed no change.
- **`keith setup`** (`cli/setup.ts`): no new question. `PHASE4_DEFAULTS`, a commented block with `[memory.reflect]`, `[memory.summary]` and `[mind.reminder]` at their defaults and a pointer to the utility cost, is written after `[models]`. `cli.test.ts` checks the block is in the file, and that uncommenting it parses to exactly the defaults.
- **Test helpers** (`test/helpers.ts`): `splitModelConfig(extra)` (`fake:chat` for foreground and background, `fake:utility` for utility, tick 1 h so tests drive ticks), `createSplitFake(chat, utility)` (one `fake` provider routed by model id), `nextEvent(events, name, match)` and `tick(events, clock)`.
- **Integration tests** (real core, real storage, fake clock). All passed 5 runs in a row, together with `bootstrap.test.ts`.
  - `memory-jobs.test.ts`:
    - Before `idleMinutes`, a tick calls no model. After it, one utility extract call with the thread's messages and no tools, an `inferred` `subject` memory in the database, `memory.reflected` `{ throughSeq: 2, written: 1 }`, and `reflected_through_seq` = 2. The next tick calls nothing.
    - With `recentMessages = 4` and `minMessages = 2`, the third turn triggers `thread.summarized { throughSeq: 2 }`. The next turn's system prompt holds `# Earlier in this thread`, and its window starts after the cursor.
  - `reminders.test.ts`:
    - The model calls `reminder.set({ inMinutes: 1 })`, and the tool answer names the id. A tick at +30 s does nothing. A tick at +61 s gives `delivery.enqueued` (`reminder`, `high`), a delivery turn with `(reminder) Call Pepper` in context, a `proactive: true` `message.started`, `delivery.delivered` with that message id, and the reminder `fired`.
    - Stop, advance 5 min, start a new core on the same home and tick: the reminder fires.
  - `briefing-skill.test.ts`: with `briefing = "auto"`, the briefing turn's context lists `morning_briefing` with the load hint, and `skill.load` returns the `.md` instructions. With a plugin skill of the same name, the index shows the plugin's description, `skill.load` returns the plugin's text, and the registry logs "plugin skill replaces the default".
  - `backup.test.ts`: the real core writes a stated memory (`memory.remember`), a pending reminder (`reminder.set`) and, through reflection with a merge call, an inferred memory and cursor. Then `keith backup` runs on the live home, the core stops, and `keith restore` runs into a new home. A core started there has the same memories, reminder, messages and cursor. The reminder still fires from the restored home, and reflection makes no call.
  - `bootstrap.test.ts`: shutdown while a reflection pass waits on the utility model ends within `plugins.stopTimeoutMs` (500 ms), and the database has no memory and no reflection cursor afterwards.

### Integration fixes (by lane)

| # | Lane | Fix |
|---|---|---|
| 1 | I (bootstrap) | Build, start and stop both memory jobs. Pass `reminders` to `registerBuiltins`. Give the skill registry a logger (D1's follow-up). |
| 2 | E1 (backup) | `storage/index.ts` exports `MIGRATIONS_FOLDER`, and `cli/backup.ts` imports it from the barrel instead of `storage/db.ts`. |
| 3 | E1 (restore test) | `cli/backup-testing.ts` `seed` adds a pending reminder (`Seeded.reminderId`), and `restore.test.ts` asserts it survives. This was dropped while P4-S1 was unmerged. |
| 4 | I (setup) | The phase-4 sections are written as comments (see above). |

No lane's runtime code needed a behavior fix. The real `listForReflection`, `range`, `setReflectedThrough`, `setSummary`, `listDue` and `markFired` behaved as the lanes' fakes assumed.

### Decisions
- **Old tests and the memory jobs:** the jobs are kept out of old tests by config, not by a separate utility model. In `packages/core/test` (`FAKE_CONFIG`) and in the e2e harness (`tickMs = 3600000`, `utility = "fake:chat"`), no test runs long enough for a real tick, so reflection never runs. No old test reaches `recentMessages + minMessages` (60) rows, so the summary job returns without a model call. The new tests use `splitModelConfig`, with a separate `fake:utility`. P4-I2 owns `tests/e2e/**` and can give the harness its own utility model when S-3 semantic needs reflection.
- Tests emit `scheduler.ticked` themselves (`tick(events, clock)` with the fake clock's time), the same payload the real timer emits. The real timer is set to 1 h in these configs.
- The shutdown acceptance test lives in `bootstrap.test.ts`, as the criterion says, not in `memory-jobs.test.ts`.

### Docs
- core.md:
  - Removed the memory-jobs Planned note.
  - Construction order: step 3 (skills logger), step 7 (the jobs are built), step 10 (`reminder.*` and `morning_briefing`), step 12 (the jobs start).
  - Shutdown order includes the jobs.
- memory.md: the P4-I1 Planned line is replaced by the wiring and a pointer to `memory-jobs.test.ts`.
- config.md:
  - The phase-4 Planned note is replaced by the cost advice.
  - The `utility` comment now says what uses it.
  - `keith setup` mentions the commented phase-4 block.
- overview.md:
  - The diagram and the parts table show reminders and the memory jobs.
  - The commands table has `keith backup` / `keith restore`.
  - The shutdown steps include the jobs.
- repository.md: `cli/backup.ts` / `restore.ts`, `storage/backup.ts`, `scheduler/reminders.ts`, `memory/reflect/`, `memory/summary/`, `reminder.*` and `builtins/skills/`.
- scenarios.md S-3: the phase-4 integration test description, and the P4-I2 e2e.
- storage.md: nothing was stale. Its Backups section already describes the built behavior.
- `grep -rn "Planned (phase 4" docs/architecture` finds nothing.

### Follow-ups
- P4-I2: the e2e harness maps `utility` to `fake:chat`. S-3 semantic needs reflection, so it needs either a split utility model (as `createSplitFake` here) or a chat script that accounts for the utility calls.
- P4-I2 human run: check the reflection and summary prompts against a real model.

`bun run check`: 1374 pass, 3 skip, 0 fail.
