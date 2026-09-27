---
id: P4-S1
title: "Storage: reminders table, thread summary and reflection cursors"
phase: 4
wave: 2
lane: S
status: in-progress
owner: agent-P4-S1
depends: [P4-K1]
owns:
  - packages/core/src/storage/schema.ts
  - packages/core/src/storage/db.ts
  - packages/core/src/storage/db.test.ts
  - packages/core/src/storage/threads.ts
  - packages/core/src/storage/threads.test.ts
  - packages/core/src/storage/messages.ts
  - packages/core/src/storage/messages.test.ts
  - packages/core/src/storage/reminders.ts
  - packages/core/src/storage/reminders.test.ts
  - packages/core/drizzle/**
reads:
  - docs/architecture/storage.md
  - docs/architecture/core.md
  - docs/decisions/0006-sqlite-only-storage.md
updates:
  - docs/architecture/storage.md
scenarios: [S-3]
---

# P4-S1: Storage for phase 4

## Goal

The repository members that P4-K1 declared work against SQLite: the `reminders` table and repository, the two thread cursors, `listForReflection`, and `messages.range` / `lastSeq`. Lanes A, B and C test against fakes. This task makes the real thing match their contract.

## Scope

**In:**
- `schema.ts`:
  - `threads.summary_through_seq` and `threads.reflected_through_seq` (integer, nullable).
  - A `reminders` table: `id` (PK), `person_id` (FK persons, cascade), `thread_id` (FK threads, cascade, nullable), `text`, `due_at`, `status` (`pending` / `fired` / `cancelled`), `created_at`, `fired_at`, `cancelled_at`, and `delivery_id` (FK deliveries, set null).
  - An index on `(status, due_at)`.
- Migrations generated with `bunx drizzle-kit generate --name=<slug>` in `packages/core`, never hand-written (R-18). Read the current drizzle-kit docs first. Both new thread columns are nullable, so no backfill is needed.
- `threads.ts`: `setSummary`, `setReflectedThrough` (neither changes `updated_at`) and `listForReflection` (one query with the messages' `max(seq)` per thread).
- `get`, `getBySlug` and `listForPerson` return the two cursors (null when unset).
- `messages.ts`: `range` and `lastSeq`, with records built exactly like `page` (including `seq`).
- `reminders.ts`: the whole `RemindersRepository`. `markFired` and `cancel` are conditional updates (`WHERE status = 'pending'`) and return whether a row changed.
- `db.ts`: `repos.reminders` replaces the P4-K1 placeholder.
- storage.md: the tables row, the cursor semantics and the reminder repository semantics, with the `(P4-S1)` markers removed.

**Out:** services, tools and jobs (lanes A, B, C), backup (P4-E1, which owns `storage/backup.ts`).

## Acceptance criteria

- [ ] `db.test.ts`: a database migrated by phase-3 migrations opens and migrates to the new schema. Existing threads read back with both cursors `null`.
- [ ] `threads.test.ts`:
  - `setSummary` round-trips and leaves `updated_at` alone.
  - `listForReflection` returns only threads idle before the cut-off with messages past the cursor, oldest first, capped by `limit`.
  - A thread whose cursor equals its `lastSeq` is not returned.
- [ ] `messages.test.ts`: `range` returns rows after `afterSeq` in `seq` order, filtered by `roles`, capped by `limit`. `lastSeq` is 0 for an empty thread.
- [ ] `reminders.test.ts`:
  - `listDue` orders soonest first and excludes fired, cancelled and future reminders.
  - A second `markFired` or `cancel` returns false and changes nothing.
  - Deleting a person cascades to their reminders.
  - Deleting the delivery sets `delivery_id` to null.
- [ ] `bun run check` passes.

## Notes

- The migration folder is `packages/core/drizzle/<timestamp>_<name>/`. Keep the nested `biome.json` behavior as it is.
- If a query needs raw SQL that Drizzle can't express, keep it inside `storage/` (R-4).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
