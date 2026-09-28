---
id: P5-A1
title: "People: keith person add, invite links, tiers, cards, blocks and removal"
phase: 5
wave: 2
lane: A
status: todo
owner: null
depends: [P5-K1]
owns:
  - packages/core/src/cli/person.ts
  - packages/core/src/cli/person.test.ts
  - packages/core/src/cli/person-testing.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/decisions/0018-deleting-a-person.md
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/architecture/storage.md
updates:
  - docs/architecture/nodes.md
  - docs/architecture/config.md
  - docs/architecture/memory.md
scenarios: [S-4, S-5]
---

# P5-A1: People commands

## Goal

The owner can bring people into Keith from the host: add a member or a guest, hand them a single-use invite link, change their tier, edit their relationship card, manage relay blocks, and remove them. This is how Pepper and Rhodey get accounts before S-4, S-5 and S-6 can happen.

## Scope

**In:** `keith person …` in `cli/person.ts`, replacing the P5-K1 placeholder. Every subcommand works on `KEITH_HOME` through the repositories (`openDb` in the command; the logic takes `Repositories`, paths, config and a clock as arguments, so tests inject fakes), and prints plain text. Answers come from flags; there are no prompts except the `remove` confirmation (through the existing `Prompter`).
- `add <name> [--tier member|guest]` (default `member`):
  - Refuses an empty name, a name longer than 80 characters, and a name or username already used by someone (case-insensitive, D13).
  - Creates the person (no username and no password yet), an empty relationship card, and their `main` direct thread (so deliveries and relays can reach them before they ever sign in).
  - Creates an invite link and prints it: `<publicUrl>/#invite=<code>`, the expiry, and `keith-tui --url <publicUrl> --invite <code>`.
  - `publicUrl` is `server.publicUrl`, or `http://<server.host>:<server.port>`.
- **Invite codes:** 32 random bytes, base64url (43 characters). Only the SHA-256 hex is stored (`inviteLinks.create`). The code is printed once and never logged. The expiry is `auth.inviteTtlHours`.
- `invite <name>`: revokes the person's unused links (`inviteLinks.revokeFor`), then creates and prints a new one. It also works for a person who already signed in (a password reset). It refuses the owner, whose password `keith setup` resets.
- `list`: name, tier, username (or `-`), whether they can sign in, last seen (in `mind.timezone`).
- `tier <name> <member|guest>`: refuses `owner` and refuses to change the owner (ADR-0017).
- `card <name> [--tone <text>] [--notes <text>]`: prints the card, or upserts the given fields and keeps the others (`blockedRelayFrom` too).
- `block <name> --from <other>` / `unblock <name> --from <other>`: edits `<name>`'s `blockedRelayFrom`. Blocking yourself is refused.
- `remove <name> [--yes]`:
  - Holds the home lock (`withHomeLock`), so it refuses while Keith runs.
  - Refuses the owner.
  - Prints a summary of what will go and suggests `keith backup`, then asks for confirmation unless `--yes`.
  - Runs `persons.remove`, deletes the returned files from `files/` (a missing file is only a warning), and prints the counts.
- Every other subcommand runs without the lock, so it works while Keith runs (D9).
- `person-testing.ts`: the in-memory repositories the tests use, and helpers the integration tests use to add a person and get their invite code without printing.
- Docs: nodes.md's "Adding people" section and config.md's `keith person` section describe the built commands (remove the `(P5-A1)` markers). memory.md: remove the `(P5-A1)` half of the person-deletion marker.

**Out:** the HTTP endpoint that accepts an invite (P5-N1), the TUI and web sign-up screens (P5-F1, P5-F2, P5-F3), the SQL of `remove` (P5-S1).

## Acceptance criteria

- [ ] `person.test.ts` (temp `KEITH_HOME`, fake clock, in-memory repositories built from the `storage/types.ts` JSDoc; P5-S1 builds the real ones in parallel, and P5-I1 runs the commands on a real database):
  - `add Pepper` creates the person, the card and the main thread, and prints a link whose code's hash is stored with the right expiry.
  - A second `add pepper` is refused.
  - `invite` revokes the older unused link.
  - `tier` refuses `owner`, and refuses to change the owner.
  - `card` edits keep `blockedRelayFrom`.
  - `block` / `unblock` round-trip.
- [ ] `remove` while the lock is held by another process is refused. Without the lock and with `--yes`, it removes the person and deletes their uploaded file from disk.
- [ ] The printed output never contains the code's hash, and the code appears only in the link and the TUI command.
- [ ] `bun run check` passes.

## Notes

- The code hash must match what P5-N1 computes: SHA-256 of the code's UTF-8 bytes, hex, like `auth_tokens.token_hash`. If `server/` already exports the hash helper through `server/index.ts`, use it. Otherwise hash here, and note it for P5-I1.
- `keith person` doesn't start the core, so it can't emit events. The running core reads tiers and cards from the database on every turn. P5-I1 checks that a tier change reaches the next turn without a restart.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
