---
id: P4-S1
title: "Storage: reminders table, thread summary and reflection cursors"
phase: 4
wave: 2
lane: S
status: done
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

- [x] `db.test.ts`: a database migrated by phase-3 migrations opens and migrates to the new schema. Existing threads read back with both cursors `null`.
- [x] `threads.test.ts`:
  - `setSummary` round-trips and leaves `updated_at` alone.
  - `listForReflection` returns only threads idle before the cut-off with messages past the cursor, oldest first, capped by `limit`.
  - A thread whose cursor equals its `lastSeq` is not returned.
- [x] `messages.test.ts`: `range` returns rows after `afterSeq` in `seq` order, filtered by `roles`, capped by `limit`. `lastSeq` is 0 for an empty thread.
- [x] `reminders.test.ts`:
  - `listDue` orders soonest first and excludes fired, cancelled and future reminders.
  - A second `markFired` or `cancel` returns false and changes nothing.
  - Deleting a person cascades to their reminders.
  - Deleting the delivery sets `delivery_id` to null.
- [x] `bun run check` passes.

## Notes

- The migration folder is `packages/core/drizzle/<timestamp>_<name>/`. Keep the nested `biome.json` behavior as it is.
- If a query needs raw SQL that Drizzle can't express, keep it inside `storage/` (R-4).

## Outcome

All placeholders from P4-K1 in `threads.ts`, `messages.ts` and `reminders.ts` are replaced. No ADR was needed; `storage/types.ts` is unchanged.

**Built**
- **Schema** (`schema.ts`): `threads.summary_through_seq` and `threads.reflected_through_seq` (nullable integers); a `reminders` table (FKs: persons cascade, threads cascade, deliveries set null) with index `reminders_status_due_idx` on `(status, due_at)`; `REMINDER_STATUSES`.
- **Migration** `drizzle/20260927130302_reminders-thread-cursors/`, generated with `bunx drizzle-kit generate --name=reminders-thread-cursors` (drizzle-kit 1.0.0-rc.4). It creates the table and index and adds both columns with `ALTER TABLE ... ADD`; no backfill.
- **threads.ts**: `toThread` returns both cursors (null when unset), so `get`, `getBySlug` and `listForPerson` carry them. `create` stores them as given (absent = null). `setSummary` / `setReflectedThrough` update only their columns (not `updated_at`; a missing thread is a no-op). `listForReflection` is one query: `updated_at ≤ idleBefore` and `lastSeq > coalesce(reflected_through_seq, 0)`, ordered by `(updated_at, id)`, `limit` applied (≤ 0 returns `[]`). `lastSeq` is a correlated `max(seq)` subquery (uses the `(thread_id, seq)` unique index).
- **messages.ts**: `range` filters by thread, `seq > afterSeq` and `roles` (empty `roles` or `limit ≤ 0` returns `[]`), ascending by `seq`, mapped with the same `toRecord` as `page`. `lastSeq` is `coalesce(max(seq), 0)`.
- **reminders.ts**: the whole `RemindersRepository`. `listDue` / `listPending` order by `(due_at, id)`; `markFired` and `cancel` are `UPDATE ... WHERE id = ? AND status = 'pending'` and return `changes > 0`.
- **db.ts** needed no change: P4-K1 already wired `repos.reminders` to `createRemindersRepository`.
- **Tests**: `db.test.ts` (a database migrated by the seven phase-3 migrations migrates forward; its thread reads back with null cursors and is due for reflection; `reminders` in the table list), `threads.test.ts` (cursor round-trips, `updated_at` untouched, `listForReflection` idle/cursor/order/tie/limit cases, cursor = `lastSeq` excluded), `messages.test.ts` (`range` order, limit, roles before limit, records equal to `page`'s, thread isolation; `lastSeq` 0 for empty and unknown threads), new `reminders.test.ts` (round-trip, `listDue` ordering and exclusions, `listPending` / `countPending`, second `markFired` / `cancel` returns false and changes nothing, person and thread cascade, delivery set null).
- **Docs**: storage.md drops the `(P4-S1)` Planned note, names the migration, and adds the tie order, the `listForReflection` query shape, the reminders FK behavior (also in the Foreign keys rule).

**Decisions**
- Drizzle prints columns in a select list unqualified (`"id"`), so a correlated subquery in the select list resolved `id` to `messages.id` and returned 0. `threads.ts` qualifies the subquery's columns by hand (`sql.identifier`), with a comment. Covered by the `lastSeq` assertions in `threads.test.ts`.
- Deleting a person in `reminders.test.ts` first deletes their `main` thread, because `threads.owner_person_id` has no cascade (unchanged, phase-1 rule).

**Deviations**
- None in scope. `db.ts` is in `owns` but was not edited (already correct).
- `threads.test.ts` "round-trips a thread" now expects the two null cursors on read (the fixture `thread()` in `fixtures.ts`, not owned, leaves them absent).

**Follow-ups**
- None for this lane. Lanes A, B and C can switch from fakes to `createTestDb()` where they want an integration test.
