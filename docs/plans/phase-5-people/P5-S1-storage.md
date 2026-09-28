---
id: P5-S1
title: "Storage: invite links, group invitations, participants and person removal"
phase: 5
wave: 2
lane: S
status: todo
owner: null
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

- [ ] `db.test.ts`: a database migrated by the phase-4 migrations opens and migrates to the new schema. Existing threads read back with `purpose: null`.
- [ ] `threads.test.ts`:
  - `addParticipant` then `removeParticipant` then `addParticipant` leaves one current row, with the new `joined_at`.
  - `listForPerson` drops a thread the person left.
  - `formerParticipants` lists only people who left.
- [ ] `invite-links.test.ts`: a second `markUsed` returns false; `revokeFor` deletes only unused links; deleting a person cascades.
- [ ] `thread-invitations.test.ts`: `create` refuses while `pending` or `accepted`, and re-invites after `declined`. `resolve` changes only `pending`.
- [ ] `persons.test.ts`: `findByName` is case-insensitive, trims, and falls back to the username. `setTier` and `setCredentials` round-trip.
- [ ] `remove-person.test.ts`, one fixture with a row in every table (direct thread with messages, deliveries, commitments, tasks, reminders and memories; a group thread they created and wrote in; memories about them and memories they authored about others; relays they sent, pending and delivered; a file; invite links; invitations; another person's block list naming them). After `remove`:
  - every row ADR-0018 deletes is gone;
  - every row it keeps has the reference cleared;
  - the other participants' group messages and the Mind's replies are untouched;
  - the returned counts and file paths match.
- [ ] `remove` of the owner throws `FORBIDDEN`, and nothing changes.
- [ ] `bun run check` passes.

## Notes

- `messages.author_person_id = null` means the Mind (I-2). Never null out a user message's author: delete it (ADR-0018).
- Foreign keys without an `on delete` action (`threads.owner_person_id`, `messages.author_person_id`, `tasks`, `commitments`, `deliveries`, `memories`, `files`) are why `remove` runs explicit statements in a fixed order. Don't change those FK actions in this task. Changing an applied table's FK in SQLite means a table rebuild.
- If a query needs raw SQL, keep it inside `storage/` (R-4).

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
