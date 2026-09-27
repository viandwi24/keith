---
id: P3-H3
title: "Hardening: storage message seq and deliveries.message_id"
phase: 3
wave: 6
lane: H
status: todo
owner: null
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

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] Migration test: an existing DB with messages gets a gap-free `seq` in the old order.
- [ ] Two messages with the same `created_at` keep insert order.
- [ ] `markDelivered` with a message id round-trips.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
