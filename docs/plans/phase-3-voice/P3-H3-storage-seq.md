---
id: P3-H3
title: "Hardening: storage message seq and deliveries.message_id"
phase: 3
wave: 6
lane: H
status: done
owner: agent-P3-H3
depends: [P3-K2]
owns:
  - packages/core/src/storage/**
  - packages/core/drizzle/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/architecture/storage.md
updates:
  - docs/architecture/storage.md
scenarios: []
---

# P3-H3: Hardening: storage message seq and deliveries.message_id

## Goal

D3 and D4 from [hardening-audit.md](hardening-audit.md): messages get a per-thread `seq` that defines their order, and a delivery records which message delivered it.

## Scope

**In:**
- `messages.seq` (integer, not null), unique per `(thread_id, seq)`, assigned by the repository on insert inside the same transaction (max+1). Migration generated with drizzle-kit, backfilling existing rows in `(created_at, id)` order.
- Every message query orders by `seq` (pages, `before` cursors, recent windows).
- `deliveries.message_id` (nullable, FK to messages, set null on delete). `markDelivered(ids, at, messageId?)` stores it.
- storage.md updated.
- Replace storage.md's `(created_at, id)` ordering text with `seq`. Reading back always sets `seq` (the type is optional only because of fakes outside storage, per P3-K2).

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] Migration test: an existing DB with messages gets a gap-free `seq` in the old order.
- [x] Two messages with the same `created_at` keep insert order.
- [x] `markDelivered` with a message id round-trips.
- [x] `bun run check` passes.

## Outcome

**Built**

- `messages.seq` (integer, not null) with a unique index `messages_thread_seq_idx (thread_id, seq)`; it replaces `messages_thread_created_idx`. `append` computes `seq` inside the insert statement (`(select coalesce(max(seq), 0) + 1 ... where thread_id = ?)`) within the existing transaction, and ignores a `seq` passed in. `get` and `page` always set `seq`.
- `page` orders by `seq` only; the `before` cursor is `seq < anchor.seq`.
- `deliveries.message_id` (nullable text, FK to `messages.id`, `on delete set null`). `markDelivered(ids, at, messageId?)` stores it (null without one); `get` returns it as `DeliveryRecord.messageId`; `pendingFor` strips it and returns plain `Delivery` values.
- Migrations, all from drizzle-kit: `message-seq-column` (add nullable), `message-seq-backfill` (custom; SQL written before it was ever applied: `row_number()` over `(created_at, id)` per thread), `message-seq-not-null` (table rebuild, copies `seq`), `delivery-message-id` (`ALTER TABLE ADD ... REFERENCES`). The delivery FK is its own migration after the rebuild, so dropping the old `messages` table never fires the set-null action.
- Tests: `db.test.ts` builds a DB with only the three pre-H3 migrations, inserts out-of-order messages in two threads plus a delivery, reopens with `openDb` and checks the gap-free backfill, that new appends continue at `max + 1`, and that deleting a message nulls `deliveries.message_id`. `messages.test.ts`: per-thread seq, same-`created_at` insert order (ids deliberately out of order), order follows `seq` when `created_at` goes backwards. `work.test.ts`: `markDelivered` with and without a message id, a delivered row keeps its first message id, unknown message id is refused by the FK.
- `docs/architecture/storage.md`: columns, `seq` semantics, ordering by `seq`, delivery `message_id`, set-null FK, and the three-step add-NOT-NULL-column recipe.

**Deviations / notes**

- The migration-count assertion in `db.test.ts` now counts the migration folders instead of a literal, so later migrations don't break it.
- The 1 ms restamp workaround in `packages/core/src/mind/thread-manager.ts` is untouched (not in `owns`; D3 lists H7 for it). With `seq`, it can be removed.
- `bun run check`: 1105 pass, 3 skip, 0 fail.
