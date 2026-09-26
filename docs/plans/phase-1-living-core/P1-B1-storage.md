---
id: P1-B1
title: Storage (SQLite, Drizzle, repositories)
phase: 1
wave: 1
lane: B
status: in-progress
owner: agent-P1-B1
depends: [P0-04]
owns:
  - packages/core/src/storage/**
  - packages/core/drizzle.config.ts
  - packages/core/drizzle/**
reads:
  - docs/architecture/storage.md
  - docs/architecture/memory.md
  - docs/decisions/0006-sqlite-only-storage.md
updates:
  - docs/architecture/storage.md
scenarios: [S-3]
---

# P1-B1: Storage (SQLite, Drizzle, repositories)

## Goal

All phase-1 state persists in one SQLite file behind the repository interfaces from `storage/types.ts`.

## Scope

**In:**
- Add Drizzle ORM and drizzle-kit to `@keith/core` with `bun add` (read the current Drizzle docs for the bun-sqlite driver first).
- Drizzle schema for every phase-1 table in storage.md, including `thread_participants`, `messages.author_person_id` (group-ready, I-2), `threads.slug` with its unique index, `persons.last_seen_at`, and the message tool-call and `ui` columns laid out in storage.md "Messages and tool calls".
- Migrations generated with drizzle-kit (never hand-written), plus `openDb(path)` that applies pragmas and migrations.
- FTS5 virtual table `memories_fts`, kept in sync by triggers, created in a migration (use drizzle-kit's custom migration feature for raw SQL).
- Repository implementations for every interface in `storage/types.ts`, including zod validation of JSON columns on read and `memories.search(text, filter)` with BM25 ranking.
- A test helper `createTestDb()` (temp file, auto-cleanup), exported for other lanes' tests from `storage/testing.ts`.

**Out:**
- Visibility logic (M1 passes a filter; storage only applies it as SQL conditions).
- Backups (phase 4).

## Acceptance criteria

- [ ] Fresh DB → all migrations apply. Applying twice is a no-op.
- [ ] Round-trip tests for each repository.
- [ ] Messages page by `before` + `limit` in stable order.
- [ ] `memories.search` finds by keyword and applies the `MemoryFilter` SQL exactly as storage.md specifies (table-driven test per filter field).
- [ ] Assistant messages with `tool_calls` and tool messages round-trip into the shapes `LlmMessage` needs.
- [ ] Data survives closing and reopening the DB file (S-3 groundwork).
- [ ] No file outside `storage/` imports `bun:sqlite` or `drizzle-orm` (check-deps).
- [ ] `bun run check` passes.

## Outcome

_To be filled._
