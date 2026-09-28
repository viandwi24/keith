---
id: P5-S1
title: "Storage: invite links, group invitations, participants and person removal"
phase: 5
wave: 2
lane: S
status: review
owner: agent-P5-S1
depends: [P5-K1]
owns:
  - packages/core/src/storage/schema.ts
  - packages/core/src/storage/db.ts
  - packages/core/src/storage/db.test.ts
  - packages/core/src/storage/persons.ts
  - packages/core/src/storage/persons.test.ts
  - packages/core/src/storage/threads.ts
  - packages/core/src/storage/threads.test.ts
  - packages/core/src/storage/invite-links.ts
  - packages/core/src/storage/invite-links.test.ts
  - packages/core/src/storage/thread-invitations.ts
  - packages/core/src/storage/thread-invitations.test.ts
  - packages/core/src/storage/remove-person.test.ts
  - packages/core/drizzle/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0018-deleting-a-person.md
  - docs/decisions/0006-sqlite-only-storage.md
  - docs/architecture/storage.md
  - docs/architecture/core.md
updates:
  - docs/architecture/storage.md
  - docs/architecture/memory.md
scenarios: [S-4, S-6]
---

# P5-S1: Storage for phase 5

## Goal

The repository members that P5-K1 declared work against SQLite: invite links, group invitations, joining and leaving, `threads.purpose`, name lookup, tier and credential updates, and the one-transaction person removal from ADR-0018. The other lanes test against fakes. This task makes the real thing match their contract.

## Scope

**In:**
- `schema.ts`:
  - `threads.purpose` (text, nullable).
  - `invite_links`: `code_hash` (PK), `person_id` (FK persons, cascade), `created_at`, `expires_at`, `used_at` (nullable). An index on `person_id`.
  - `thread_invitations`: `thread_id` (FK threads, cascade), `person_id` (FK persons, cascade), `invited_by` (FK persons, cascade), `status` (`pending` / `accepted` / `declined`), `delivery_id` (FK deliveries, set null), `created_at`, `resolved_at`. PK `(thread_id, person_id)`. An index on `(person_id, status)`.
  - A unique index on `lower(persons.name)` if drizzle-kit can express it. Otherwise `keith person add` enforces it (P5-A1), and the Outcome records which.
- Migrations generated with `bunx drizzle-kit generate --name=<slug>` in `packages/core`, never hand-written (R-18). Read the current drizzle-kit docs first. `threads.purpose` is nullable, so no backfill.
- `persons.ts`:
  - `findByName`, `setTier` and `setCredentials`.
  - `remove(id)`: ADR-0018 exactly, in one transaction. It returns the counts and the relative file paths. It throws `FORBIDDEN` for the owner and `NOT_FOUND` for an unknown id.
- `threads.ts`: `addParticipant`, `removeParticipant` and `formerParticipants`. `get`, `getBySlug`, `listForPerson` and `create` carry `purpose` (null when unset).
- `invite-links.ts` and `thread-invitations.ts`: the whole repositories, per the JSDoc in `storage/types.ts`. Conditional updates (`markUsed`, `resolve`) use `WHERE` on the old state and return whether a row changed.
- `db.ts`: `repos.inviteLinks` and `repos.threadInvitations` replace the P5-K1 placeholders.
- storage.md: the table rows, the semantics and the removal list, with the `(P5-S1)` markers removed. memory.md: remove the `(P5-S1)` half of the person-deletion marker.

**Out:** the CLI (P5-A1), the invite endpoint (P5-N1), group rules (P5-C1).

## Acceptance criteria

- [x] `db.test.ts`: a database migrated by the phase-4 migrations opens and migrates to the new schema. Existing threads read back with `purpose: null`.
- [x] `threads.test.ts`:
  - `addParticipant` then `removeParticipant` then `addParticipant` leaves one current row, with the new `joined_at`.
  - `listForPerson` drops a thread the person left.
  - `formerParticipants` lists only people who left.
- [x] `invite-links.test.ts`: a second `markUsed` returns false; `revokeFor` deletes only unused links; deleting a person cascades.
- [x] `thread-invitations.test.ts`: `create` refuses while `pending` or `accepted`, and re-invites after `declined`. `resolve` changes only `pending`.
- [x] `persons.test.ts`: `findByName` is case-insensitive, trims, and falls back to the username. `setTier` and `setCredentials` round-trip.
- [x] `remove-person.test.ts`, one fixture with a row in every table (direct thread with messages, deliveries, commitments, tasks, reminders and memories; a group thread they created and wrote in; memories about them and memories they authored about others; relays they sent, pending and delivered; a file; invite links; invitations; another person's block list naming them). After `remove`:
  - every row ADR-0018 deletes is gone;
  - every row it keeps has the reference cleared;
  - the other participants' group messages and the Mind's replies are untouched;
  - the returned counts and file paths match.
- [x] `remove` of the owner throws `FORBIDDEN`, and nothing changes.
- [x] `bun run check` passes.

## Notes

- `messages.author_person_id = null` means the Mind (I-2). Never null out a user message's author: delete it (ADR-0018).
- Foreign keys without an `on delete` action (`threads.owner_person_id`, `messages.author_person_id`, `tasks`, `commitments`, `deliveries`, `memories`, `files`) are why `remove` runs explicit statements in a fixed order. Don't change those FK actions in this task. Changing an applied table's FK in SQLite means a table rebuild.
- If a query needs raw SQL, keep it inside `storage/` (R-4).

## Outcome

No new ADR. Everything follows `storage/types.ts` (P5-K1) and [ADR-0018](../../decisions/0018-deleting-a-person.md).

**Built**
- `schema.ts`: `threads.purpose` (text, nullable); `invite_links` and `thread_invitations` exactly as scoped (FKs, cascade / set null, PK, indexes); a unique index `persons_name_lower_idx` on `lower(persons.name)`. drizzle-kit 1.0.0-rc.4 expresses the expression index (`uniqueIndex(...).on(sql` over `lower(name)`), so names are unique case-insensitively in the database, not only in `keith person add`.
- Migration `drizzle/20260928064730_people-invites`, generated with `bunx drizzle-kit generate --name=people-invites` (a second `generate` reports no changes). No backfill. Before phase 5 only `keith setup` created a person (the owner), so the unique name index can't fail on an existing database.
- `persons.ts`: `findByName` (trim, SQLite `lower()` on name then username, name wins, empty → null), `setTier`, `setCredentials`, and `remove(id)`: one `db.transaction`, explicit statements in the order written in storage.md (refuse unknown / owner first, so a throw changes nothing). Returns `PersonRemoval` with counts and file paths.
- `threads.ts`: `addParticipant` (one upsert whose update applies only when `left_at` is set), `removeParticipant` (update `WHERE left_at IS NULL`), `formerParticipants` (most recent `left_at` first, ties by person id). `create` stores `purpose` (absent = null); `get`, `getBySlug`, `listForPerson` return it.
- `invite-links.ts`, `thread-invitations.ts`: the full repositories. `markUsed` / `resolve` are conditional updates; `threadInvitations.create` is one upsert that only overwrites a `declined` row.
- `db.ts` needed no change: P5-K1 already wired `repos.inviteLinks` / `repos.threadInvitations` to these factories.
- Tests: `db.test.ts` (phase-4 database → phase-5 schema, `purpose: null`, new tables listed), `threads.test.ts`, `persons.test.ts`, `invite-links.test.ts`, `thread-invitations.test.ts`, `remove-person.test.ts` (one fixture with a row in every table ADR-0018 names; exact `PersonRemoval`; every deleted row gone, every kept row cleared, others' group messages and the Mind's replies byte-for-byte unchanged; owner → `FORBIDDEN` and unknown → `NOT_FOUND` with a full-database dump unchanged).
- Docs: storage.md (the `persons` index, FK list, semantics, the removal order; the `(P5-S1)` marker removed), memory.md (the marker now names only P5-A1).

**Decisions**
- **Counts via `select count(*)`**, not `changes`: `bun:sqlite`'s `changes` also counts rows touched by triggers (the memories FTS triggers) and FK cascades, which inflated `memories` and `directThreads`.
- **Memories tied to a direct thread are deleted whatever their visibility** (ADR-0018 says `thread` memories). Any memory with `thread_id` pointing at the thread would otherwise block the thread delete (no FK action).
- **Every remaining delivery the person authored gets `author_person_id = null`**, not only delivered relays (for example an `invitation` delivery they sent to someone else). Otherwise the person delete fails on the FK. `cleared.relays` counts only the `relay` ones, as its JSDoc says. The invitation row itself is deleted (invitations "from them"); the pending invitation delivery in the invitee's thread stays, with no author.
- **`groupMemberships`** counts current and former participant rows (a leaver's row is still theirs).
- **`meta.relayFrom`** on the Mind's delivery message keeps the removed person's id and name (ADR-0018 keeps the name the recipient saw); the test checks it is the only place the id remains.

**Deviations**
- None in scope. `db.ts` is untouched (already wired by P5-K1).

**Notes for other lanes**
- **P5-A1:** duplicate names (case-insensitive) now throw from `persons.create` (the unique index); check with `findByName` first for a friendly message. `remove` returns `filePaths` relative to `KEITH_HOME/files/`; delete them after it resolves. `revokeFor` returns the number deleted.
- **P5-N1 / P5-A1:** `setCredentials` throws on a username another person has; check `getByUsername` first as the JSDoc says.
- **P5-C1:** `addParticipant` returns false for a current participant, `removeParticipant` false for a non-participant; `threadInvitations.create` returns false while `pending`/`accepted`.
- **P5-I1:** `lower()` folds ASCII only, so `Élodie` / `élodie` are different names to the index and to `findByName`.
