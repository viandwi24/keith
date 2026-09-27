---
id: P4-K1
title: Phase-4 contract additions and core memory, summary and reminder interfaces
phase: 4
wave: 1
lane: K
status: todo
owner: null
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

- [ ] `events.test.ts` (sdk) checks the two new events against events.md. `CORE_EVENT_NAMES` includes them.
- [ ] `ids.test.ts`: `rem` is unique and `ReminderId` parses `rem_<ULID>`.
- [ ] Config: `config/memory.test.ts` (new). An empty file gives every default above. `KEITH__MEMORY__REFLECT__IDLEMINUTES=0.5` gives 0.5. `idleMinutes = 0` and `minMessages = 0` are `CONFIG_INVALID`.
- [ ] `builtins/reminder.test.ts` (spec only): the three tools have the names, input schemas and `minTier` above. `reminder.set` rejects input with both `at` and `inMinutes`, and input with neither. `registerBuiltins` without `reminders` registers no `reminder.*` tool.
- [ ] `registerBuiltins` registers the `morning_briefing` default skill.
- [ ] `bun run core-docs` passes, and core.md blocks match the changed `types.ts` files.
- [ ] `bun run plans --lint` is clean. Once this is `done`, `bun run plans --ready` lists P4-S1, P4-A1, P4-B1, P4-C1, P4-D1 and P4-E1.
- [ ] `bun run check` passes.

## Notes

- **Placeholders must not change behavior.** Existing tests pass unchanged. Bootstrap doesn't call the new factories yet, `fireDue` returns 0, and no `reminder.*` tool is registered.
- Keep the new `ThreadRecord` fields optional (`seq` precedent), or every `ThreadRecord` literal in the repo breaks.
- If typecheck shows another implementer outside `owns`, widen `owns` for that one file and record it under Deviations (the P3-K1 precedent for `packages/client/src/state.ts`). Don't skip the placeholder.
- The reminder `at` parsing (offset-less time in `mind.timezone`) is P4-C1's job. Fix only the input schema and the error wording here.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
