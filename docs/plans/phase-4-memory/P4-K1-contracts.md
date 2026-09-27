---
id: P4-K1
title: Phase-4 contract additions and core memory, summary and reminder interfaces
phase: 4
wave: 1
lane: K
status: done
owner: agent-P4-K1
depends: [P3-I3]
owns:
  - docs/contracts/**
  - packages/protocol/src/ids.ts
  - packages/protocol/src/ids.test.ts
  - packages/sdk/src/events.ts
  - packages/sdk/src/events.test.ts
  - packages/core/src/config/**
  - packages/core/src/shared/types.ts
  - packages/core/src/shared/ids.ts
  - packages/core/src/shared/ids.test.ts
  - packages/core/src/storage/**
  - packages/core/src/memory/**
  - packages/core/src/scheduler/**
  - packages/core/src/plugins/types.ts
  - packages/core/src/plugins/skills.ts
  - packages/core/src/builtins/**
  - packages/core/src/mind/testing/**
  - packages/core/src/server/test-fakes.ts
reads:
  - docs/plans/phase-4-memory/README.md
  - docs/decisions/0014-reflection-writes-conservative-inferred-memories.md
  - docs/architecture/memory.md
  - docs/architecture/core.md
  - docs/architecture/storage.md
  - docs/architecture/config.md
  - docs/contracts/events.md
  - docs/contracts/plugin-api.md
  - docs/plans/phase-3-voice/hardening-audit.md
updates:
  - docs/architecture/core.md
  - docs/architecture/config.md
  - docs/architecture/memory.md
  - docs/architecture/storage.md
  - docs/architecture/providers.md
  - docs/architecture/plugin-system.md
  - docs/rules/conventions.md
scenarios: [S-3]
---

# P4-K1: Phase-4 contract additions and core interfaces

## Goal

Every wave-2 lane builds against fixed types: the new events, the `reminder` id, the `[memory.reflect]`, `[memory.summary]` and `[mind.reminder]` config keys, the storage types for reminders and thread cursors, the core interfaces for reflection, summaries and reminders, the reminder tool specs, and the default-skill hook. Placeholders keep `bun run check` green. It runs before the parallel lanes, like P3-K1. The coordinator runs it after [ADR-0014](../../decisions/0014-reflection-writes-conservative-inferred-memories.md) is accepted.

The hardening audit's lesson applies: every interface a wave-2 lane needs is fixed **here**, and every implementer that a type change breaks gets a placeholder **here**. A lane that finds a missing member is blocked; it doesn't add the member itself.

## Scope

**In (all additive, contracts rule 3):**

- **Events** (`events.md`, `packages/sdk/src/events.ts`, `CORE_EVENT_NAMES`):
  - `memory.reflected`: `{ threadId, throughSeq: number, written: number, merged: number, cardsUpdated: number }`. A reflection pass finished (also when it wrote nothing).
  - `thread.summarized`: `{ threadId, throughSeq: number }`. `threads.summary` changed.
  - Both are phase 4. No `reminder.*` events: a fired reminder is a `delivery.enqueued` with `kind: 'reminder'`.
- **Ids:** `reminder: 'rem'` in `ID_PREFIXES` (`@keith/protocol`), `ReminderId`, and the prefix table in conventions.md. Check that `ids.newId('reminder')` (core `shared/ids.ts`) works.
- **plugin-api.md (Skills):** one additive sentence. The core may register **default** skills (phase 4: `morning_briefing`). A plugin that registers a skill with the same name replaces the default instead of failing with `TOOL_NAME_TAKEN`, and the default comes back if that plugin is removed.
- **Config** (types, zod schema, defaults, tests, config.md). Every key has a default, so `KEITH__` overrides work:
  ```toml
  [memory.reflect]
  enabled = true
  idleMinutes = 20        # fractional allowed (tests use small values)
  maxMessages = 200       # messages read per pass; more wait for the next pass
  cardMaxChars = 1000     # relationship notes cap

  [memory.summary]
  enabled = true
  minMessages = 20        # rows out of the window before the summary is updated
  maxChars = 2000

  [mind.reminder]
  maxPerPerson = 50       # pending reminders per person
  ```
- **Shared types** (`shared/types.ts`): `ReminderId`, `ReminderStatus = 'pending' | 'fired' | 'cancelled'`, and `Reminder { id; personId; threadId: ThreadId | null; text; dueAt; status; createdAt; firedAt: number | null; cancelledAt: number | null; deliveryId: DeliveryId | null }`.
- **Storage types** (`storage/types.ts`):
  - `ThreadRecord` gains `summaryThroughSeq?: number | null | undefined` and `reflectedThroughSeq?: number | null | undefined`. They are optional, so existing record literals still compile, like `seq`.
  - `ThreadsRepository`:
    - `setSummary(id, { summary, throughSeq })` and `setReflectedThrough(id, seq)`. Neither touches `updated_at`.
    - `listForReflection({ idleBefore, limit })`: threads with `updated_at ≤ idleBefore` and a message whose `seq` is past the cursor, oldest first, as `{ thread, lastSeq }`.
  - `MessagesRepository`:
    - `range({ threadId, afterSeq, limit, roles? })`: rows with `seq > afterSeq`, ascending.
    - `lastSeq(threadId)`: 0 when empty.
  - `RemindersRepository`: `create`, `get`, `listDue(now, limit?)` (pending, `dueAt ≤ now`, soonest first), `listPending(personId)`, `countPending(personId)`, `markFired(id, at, deliveryId)` and `cancel(id, at)`. The last two change only `pending` rows and return whether they did. `Repositories.reminders`.
  - Document every member in JSDoc; the wave-2 lanes build fakes from these comments.
- **Memory types** (`memory/types.ts`):
  ```ts
  export type ReflectionResult = { threadId: ThreadId; throughSeq: number; written: MemoryId[]; merged: MemoryId[]; cardsUpdated: PersonId[] }
  export interface Reflector { reflect(a: { threadId: ThreadId; signal: AbortSignal }): Promise<ReflectionResult | null> }   // null: nothing new
  export interface ThreadSummarizer { update(a: { threadId: ThreadId; signal: AbortSignal }): Promise<boolean> }            // false: below minMessages
  /** A background job with a lifecycle, started and stopped by bootstrap. */
  export interface MemoryJob { start(): void; stop(): Promise<void> }
  ```
  Also the factory signatures, as placeholders that do nothing:
  - `createReflection(deps): { reflector: Reflector; job: MemoryJob }` in `memory/reflect/index.ts`.
  - `createThreadSummaries(deps): { summarizer: ThreadSummarizer; job: MemoryJob }` in `memory/summary/index.ts`.

  Both are exported from `memory/index.ts`. Their deps are fixed here: `config`, `repos`, `memory` (reflection only), `runLoop`, `scheduler` (`run`), `events`, `clock`, `ids`, `log`.
- **Scheduler types** (`scheduler/types.ts`):
  ```ts
  export interface ReminderService {
    set(r: { personId: PersonId; threadId: ThreadId | null; text: string; dueAt: number }): Promise<Reminder>
    cancel(a: { id: ReminderId; personId: PersonId }): Promise<boolean>
    listFor(personId: PersonId): Promise<Reminder[]>
    /** Enqueues a `reminder` delivery for every due reminder, then marks it fired. Returns how many fired. */
    fireDue(now: number): Promise<number>
  }
  ```
  - `createScheduling` builds `reminders` (a placeholder in `scheduler/reminders.ts`: `fireDue` returns 0, the others throw `INTERNAL` "not implemented yet (P4-C1)").
  - `start()` subscribes `reminders.fireDue` to `scheduler.ticked`.
  - `Scheduling.reminders` is exposed.
- **Built-in tool specs** (`builtins/reminder.ts`; the bodies return a tool error "not implemented yet (P4-C1)"). All three have `minTier: 'member'`.
  - `reminder.set { text: string (1..500), at?: string, inMinutes?: number }`: exactly one of `at` or `inMinutes`. `at` is ISO 8601; without an offset it is read in `mind.timezone`. A due time in the past, or more than 366 days ahead, is a tool error.
  - `reminder.list {}`: the caller's pending reminders, one `id: when (timezone) — text` per line.
  - `reminder.cancel { id }`: only the caller's own pending reminder. Any other id reads as not found.

  `registerBuiltins` registers them only when `BuiltinDeps.reminders` is given. It is optional, so bootstrap compiles unchanged, and P4-I1 wires it. Why `reminder.list`, which the overview did not name: without it the model can't find an id to cancel.
- **Default skill hook:**
  - `CoreSkillRegistry.registerDefault(skill)` in `plugins/types.ts`. The placeholder in `plugins/skills.ts` registers the skill with owner `core`, and P4-D1 adds the replace semantics.
  - `builtins/skills/morning-briefing.ts`: a placeholder `morning_briefing` skill (the final name and description, a one-paragraph draft of the instructions).
  - `registerBuiltins` calls `registerDefault` with it.
- **Placeholders in implementers:**
  - `storage/threads.ts`, `storage/messages.ts` and `storage/db.ts` (a `reminders` repo) throw `INTERNAL` "not implemented yet (P4-S1)".
  - `storage/backup.ts` declares `backupDatabase(srcPath, destPath, signal)` (throws, P4-E1), exported from `storage/index.ts`.
  - Every fake that implements a changed interface gets the new members: `memory/testing/**`, `scheduler/testing/**`, `mind/testing/**` and `server/test-fakes.ts`. So do config literals in tests (`memory: { coreMaxChars }` gains the new keys).
- **Docs:**
  - core.md: config, storage, memory and scheduler blocks, the built-in tools table (with `reminder.list`), and the Scheduler and Context builder sections (summary section and window rule, marked `> Planned (phase 4, P4-B1)`).
  - memory.md: replace the Planned paragraph with the ADR-0014 rules, marked `> Planned (phase 4, P4-A1)` / `(P4-B1)`.
  - storage.md: `reminders` columns, the thread cursors and the new repository semantics, marked `(P4-S1)`.
  - providers.md: `utility` is used by reflection and summaries.
  - plugin-system.md: default skills.
  - `bun run core-docs` must pass.

**Out:** any behavior beyond placeholders, the Drizzle schema and migrations (P4-S1), and `bootstrap.ts` (P4-I1).

## Deliverables

- The events, id, config keys, types, factory signatures and tool specs above, with placeholders.
- Doc blocks in core.md that match every changed `types.ts` (`bun run core-docs`).

## Acceptance criteria

- [x] `events.test.ts` (sdk) checks the two new events against events.md. `CORE_EVENT_NAMES` includes them.
- [x] `ids.test.ts`: `rem` is unique and `ReminderId` parses `rem_<ULID>`.
- [x] Config: `config/memory.test.ts` (new). An empty file gives every default above. `KEITH__MEMORY__REFLECT__IDLEMINUTES=0.5` gives 0.5. `idleMinutes = 0` and `minMessages = 0` are `CONFIG_INVALID`.
- [x] `builtins/reminder.test.ts` (spec only): the three tools have the names, input schemas and `minTier` above. `reminder.set` rejects input with both `at` and `inMinutes`, and input with neither. `registerBuiltins` without `reminders` registers no `reminder.*` tool.
- [x] `registerBuiltins` registers the `morning_briefing` default skill.
- [x] `bun run core-docs` passes, and core.md blocks match the changed `types.ts` files.
- [x] `bun run plans --lint` is clean. Once this is `done`, `bun run plans --ready` lists P4-S1, P4-A1, P4-B1, P4-C1, P4-D1 and P4-E1.
- [x] `bun run check` passes.

## Notes

- **Placeholders must not change behavior.** Existing tests pass unchanged. Bootstrap doesn't call the new factories yet, `fireDue` returns 0, and no `reminder.*` tool is registered.
- Keep the new `ThreadRecord` fields optional (`seq` precedent), or every `ThreadRecord` literal in the repo breaks.
- If typecheck shows another implementer outside `owns`, widen `owns` for that one file and record it under Deviations (the P3-K1 precedent for `packages/client/src/state.ts`). Don't skip the placeholder.
- The reminder `at` parsing (offset-less time in `mind.timezone`) is P4-C1's job. Fix only the input schema and the error wording here.

## Outcome

Everything is additive (contracts rule 3): no frame, event, id prefix, config key, interface member or error code changed meaning or was removed. No new ADR: every open point was settled by the plan and ADR-0014, or is recorded under Decisions.

**Built**
- **Contracts.**
  - `events.md` + `@keith/sdk` `CoreEventMap` / `CORE_EVENT_NAMES`: `memory.reflected` `{ threadId, throughSeq, written, merged, cardsUpdated }` and `thread.summarized` `{ threadId, throughSeq }`, phase 4. A line in Conventions says there are no `reminder.*` events.
  - `events.test.ts` now reads every row of the table (any phase), not only phase-1 rows, and checks the phase-4 rows' `data` field names against the payload types.
  - `@keith/protocol`: `ID_PREFIXES.reminder = 'rem'`, `ReminderId`. The prefix table in conventions.md has `rem_`. Tests: `rem` is unique, `ReminderId` parses `rem_<ULID>`, and core `ids.next('rem')` yields a valid `ReminderId`.
  - `plugin-api.md#skills`: default skills. A plugin skill with a default's name replaces it, the default comes back when that plugin is removed, and a second plugin still fails.
- **Config** (`config/types.ts`, `schema.ts`, new `config/memory.test.ts`, config.md):
  - `[memory.reflect]`: `enabled` true, `idleMinutes` 20 (positive, fractional), `maxMessages` 200, `cardMaxChars` 1000.
  - `[memory.summary]`: `enabled` true, `minMessages` 20, `maxChars` 2000.
  - `[mind.reminder]`: `maxPerPerson` 50.
  - Every key has a default, so `KEITH__` overrides work (tested with `KEITH__MEMORY__REFLECT__IDLEMINUTES=0.5`). `idleMinutes = 0` and `minMessages = 0` are `CONFIG_INVALID`.
- **Shared types:** `ReminderId` (re-exported), `ReminderStatus`, `Reminder`.
- **Storage types** (`storage/types.ts`, every member with JSDoc):
  - `ThreadRecord.summaryThroughSeq?` and `reflectedThroughSeq?`.
  - `ThreadsRepository.setSummary`, `setReflectedThrough` and `listForReflection`.
  - `MessagesRepository.range` and `lastSeq`.
  - `RemindersRepository`, and `Repositories.reminders`.
- **Storage placeholders** (throw `INTERNAL` "… not implemented yet (P4-S1)"):
  - the new members in `threads.ts` and `messages.ts`;
  - a new `storage/reminders.ts` (`createRemindersRepository`), wired in `db.ts`.
  - `storage/backup.ts` declares `backupDatabase(srcPath, destPath, signal)` and throws (P4-E1). It is exported from `storage/index.ts`.
- **Memory:**
  - `memory/types.ts` has `ReflectionResult`, `Reflector`, `ThreadSummarizer` and `MemoryJob`.
  - `memory/reflect/index.ts` has `createReflection(deps: ReflectionDeps): Reflection`. The placeholder `reflect` returns null.
  - `memory/summary/index.ts` has `createThreadSummaries(deps: ThreadSummariesDeps): ThreadSummaries`. The placeholder `update` returns false.
  - Both placeholder jobs do nothing. Everything is exported from `memory/index.ts`.
- **Scheduler:**
  - `ReminderService` is in `scheduler/types.ts`.
  - `scheduler/reminders.ts` has `createReminderService(deps: ReminderServiceDeps)`. `fireDue` returns 0, and the others throw `INTERNAL` "… not implemented yet (P4-C1)".
  - `createScheduling` builds it and exposes `Scheduling.reminders`. `SchedulingDeps.repos` gains `reminders`.
  - `start()` calls `reminders.fireDue(event.at)` on every `scheduler.ticked`, in a `finally` after commitment expiry, so a failing expiry can't hold reminders back.
- **Built-ins:**
  - `builtins/reminder.ts` has the final specs of `reminder.set`, `reminder.list` and `reminder.cancel`, all with `minTier: 'member'`. It also exports the input schemas, `REMINDER_TOOL_NAMES`, `REMINDER_AT_PATTERN`, `REMINDER_TEXT_MAX_CHARS` (500), `REMINDER_MAX_AHEAD_DAYS` (366) and the tool answers (`REMINDER_MESSAGES`). The bodies return the tool error "… not implemented yet (P4-C1)."
  - `registerBuiltins` registers the reminder tools only when `BuiltinDeps.reminders` is given.
  - `builtins/skills/morning-briefing.ts` is the `morning_briefing` default skill: final name and description, draft instructions. `registerBuiltins` registers it through `skills.registerDefault`.
  - `CoreSkillRegistry.registerDefault` is in `plugins/types.ts`. The placeholder in `plugins/skills.ts` registers the skill as a core skill (`pluginId` null), with the name check and `TOOL_NAME_TAKEN` on a duplicate.
- **Tests:**
  - `builtins/reminder.test.ts`: names, schemas, `minTier`, both/neither `at` and `inMinutes`, JSON Schema conversion, and registration with and without `reminders`.
  - `builtins/index.test.ts`: `morning_briefing` is registered as a default.
- **Fakes:**
  - `memory/testing/fakes.ts`: threads cursors and `listForReflection` over a `lastSeqs` fixture map.
  - `mind/testing/fakes.ts`: threads cursors, `listForReflection`, and `messages.range` / `lastSeq` over its stored `seq`.
  - `scheduler/testing/fakes.ts`: a full in-memory `createFakeRemindersRepository` (`FakeRepos.reminders` / `reminderRows`) and the threads cursors.
  - `server/test-fakes.ts`: threads cursors, and `range` / `lastSeq` by position.
  - Every config literal gains the new keys.
- **Docs:**
  - core.md: the config, plugins, storage, scheduler, memory and shared blocks are generated from the `types.ts` files, and `core-docs` is ok. New prose: memory-job factories and deps; the lanes table; the tick users; a new "Reminders" subsection under Deliveries; the built-in tools row with `reminder.list` and tier `member`; default skills. The Context builder summary section and window rule are marked `> Planned (phase 4, P4-B1)`.
  - memory.md: new "Reflection" and "Thread summary" sections with the ADR-0014 rules, replacing the old Planned paragraph, marked `(P4-A1)` / `(P4-B1)`.
  - storage.md: the `threads` cursor columns, the full `reminders` row, and a "Reminders and thread cursors" section `(P4-S1)`. Backups are marked `(P4-E1)`.
  - config.md: the three sections, overrides and rough utility cost.
  - providers.md: `utility` is used by reflection and summaries.
  - plugin-system.md: default skills, with a `(P4-D1)` Planned note.

**Decisions**
- **Reminder tool deps.** `BuiltinDeps.reminders` is a `ReminderToolsDeps` `{ service: ReminderService; config: Pick<KeithConfig, 'mind'>; clock: Clock }`, not a bare `ReminderService`. `reminder.set` needs `mind.timezone` and "now", and `reminder.list` needs the time zone, and `BuiltinDeps` has neither. One optional group keeps "no reminders, no tools" type-safe. P4-I1 passes `reminders: { service: scheduling.reminders, config, clock }`.
- **`reminder.set` schema:**
  - `text` is trimmed, 1..500.
  - `at` must match `REMINDER_AT_PATTERN`: ISO 8601 date and time, minutes required, optional seconds, fraction and `Z` / `±HH:MM`. A date alone or natural language is invalid input.
  - `inMinutes` is a positive number with no upper bound in the schema. The 366-day rule is a tool error in the body, as the task says.
  - "Exactly one of" is a `.refine` whose message is `REMINDER_MESSAGES.bothOrNeither`. It still converts to JSON Schema, which is tested.
- **`reminder.cancel { id }`** uses the `ReminderId` schema, like `task.cancel` uses `TaskId`. A malformed id is invalid input. A well-formed id that isn't the caller's pending reminder is "No such reminder." (P4-C1).
- **Factory deps** (fixed here; lanes may not narrow the call site):
  - `ReflectionDeps` takes `config` (`memory`, `mind`) and `repos` (`threads`, `messages`, `memories`, `relationships`, `persons`). It also takes `memory`, `runLoop`, `scheduler` (`run`), `events`, `clock`, `ids` and `log`.
  - `ThreadSummariesDeps` is the same without `memory`, and its `repos` are `threads` and `messages`.
  - `ReminderServiceDeps` takes `config` (`mind`), `repos` (`reminders`), `deliveries` (`enqueue`), `ids`, `clock` and `log`.
- `fireDue` gets the tick's `at` (the event payload), not `clock.now()`, so a test controls it through the tick.
- The storage placeholder for reminders is a new file, `storage/reminders.ts`, not a stub inside `db.ts`. P4-S1 owns both files and replaces the body.

**Deviations**
- The task says to check `ids.newId('reminder')`. The core API is `ids.next('rem')` (`Ids.next(prefix)`), which is what the test checks. P4-C1's text says `ids.newId('reminder')` too. Read it as `ids.next('rem')`.
- No `owns` widening was needed. Every broken implementer was inside `owns`.
- Behavior change within scope: with the default skill registered, every context's skills index now lists `morning_briefing`. Until P4-D1, a plugin skill named `morning_briefing` gets `TOOL_NAME_TAKEN`. No first-party plugin registers one, and all existing tests pass unchanged.
- `events.test.ts` changed its row filter from "ends with `| 1 |`" to "any phase number", so phase-4 rows are checked too.

**Notes for the lanes**
- **P4-S1:**
  - Implement the JSDoc in `storage/types.ts` exactly.
  - `get`, `getBySlug` and `listForPerson` must return both cursors (null when unset). `create` stores them as given (absent = null).
  - `range` filters by `roles` before the limit.
  - Replace the bodies in `storage/reminders.ts`, `threads.ts` and `messages.ts`. Remove the `(P4-S1)` Planned note in storage.md.
- **P4-A1:**
  - `createReflection` and `ReflectionDeps` are in `memory/reflect/index.ts`. Keep the signature.
  - `FakeThreadsRepository` (`memory/testing/fakes.ts`) has cursors and `listForReflection` over its `lastSeqs` map, because it stores no messages. Reshape it as you need (you own `memory/testing`).
  - `memory.reflected` needs counts, so use `written.length` etc.
  - Remove the `(P4-A1)` Planned notes in memory.md and core.md (the memory-jobs note is shared with B1).
- **P4-B1:**
  - `createThreadSummaries` and `ThreadSummariesDeps` are in `memory/summary/index.ts`.
  - `mind/testing/fakes.ts` `createFakeRepos` has `range`, `lastSeq`, `setSummary`, `setReflectedThrough` and `listForReflection`, and `testConfig` has `mind.reminder`. `testConfig` returns only `mind`, so add `memory` where your `ContextBuilderDeps.config` needs it.
  - Remove the Context-builder Planned note in core.md.
- **P4-C1:**
  - Replace `createReminderService` in `scheduler/reminders.ts` (same deps).
  - `scheduling.start()` already calls `fireDue(at)` per tick. Don't wire it again.
  - `scheduler/testing/fakes.ts` has `createFakeRemindersRepository` (the full JSDoc contract), and `createFakeRepos()` includes it.
  - In `builtins/reminder.ts`, keep the names, schemas, `minTier` and `REMINDER_MESSAGES` wording. Use `deps.service`, `deps.config.mind.timezone` and `deps.clock`.
  - `ReminderService.set` throws a `KeithError` at the limit. Map it to `REMINDER_MESSAGES.limit(max)`.
  - Remove the Reminders Planned note in core.md.
- **P4-D1:**
  - Replace `registerDefault` in `plugins/skills.ts` with the replace and restore semantics. `RegisteredSkill.pluginId` is null for defaults, as for other core skills.
  - `morning-briefing.ts` has the final name and description ("How to brief a person on what they missed. Load at the start of a briefing or when someone asks what they missed."). Replace the draft instructions with the `.md` file.
  - Remove the Planned note in plugin-system.md.
- **P4-E1:** `backupDatabase(srcPath, destPath, signal): Promise<void>` is in `storage/backup.ts` and exported from `storage/index.ts`. Replace the body, and the Backups note in storage.md.
- **P4-I1:**
  - Build both memory jobs in step 7 and pass `reminders: { service: scheduling.reminders, config, clock }` to `registerBuiltins`.
  - `registerBuiltins` already registers `morning_briefing`.
  - Remove the memory-jobs Planned note in core.md and config.md's phase-4 Planned note.
