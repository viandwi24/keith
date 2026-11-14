# People

Module: `apps/core/src/modules/people`. Storage: `packages/db/src/eh/person-store.ts`. Contracts:
`packages/contracts/src/people.ts`. Builds on `eharness/identity` (spec 30, Draft in 0.9.0).

## Purpose

The directory of who uses Keith. One row per person with a role and a status; platform accounts
(chat apps, voice, ...) hang off a person for later channels. Login credentials (`auth.md`) belong to
a person. P9 step 1 covers the directory, roles, status and the admin API; step 2 adds passwords, PINs and
step-up (below); permissions and isolation come in the next steps (`docs/plans/active/P9-people-and-login.md`).

**Layers (ADR-0020).** A person owns their **personal** layer (conversation, memory, workspace, agenda) and their **ecosystem**
layer (clients, devices, signals: `parietal.md`). Others see the ecosystem layer only through the disclosure rules of presence. Nodes and
capabilities are Keith's **self** layer (`nodes.md`): members with `nodes.read` see all of them (ADR-0027 §9). A feature names the
layer its data belongs to (ADR-0020).

## Model

- **Id:** a new person gets a UUIDv7 (`Bun.randomUUIDv7()`); the owner of a first install keeps the
  id `owner`. Session ids stay `front:<personId>`.
- **Principal (eharness 0.10, ADR-0069):** every open of a front session sets the session's principal
  `{ id: <personId> }` (`frontSessionOptions`: thalamus from the signed-in person; boot recovery,
  reconcile, dead letters and the attention routes from the session id). Hooks read `ctx.principal`
  (`memory.roots`, `budget.scopes`, the `whois` reminder, `tool.approve`); a worker inherits it, and a
  `respond()` continuation or a wake turn runs with the principal of the session or of the turn that
  asked, never of the person who answered. Each front session has exactly one person, so a queued
  wake can never serve two principals (`principal-hooks.test.ts`). A session stored before 0.10 gets
  its principal at its next open; a worker that was running across that upgrade has none (no memory
  root, global budget only). `personOfSession` stays for ids that arrive without a turn: the activity
  feed filter, brain event stamps and attention routes.
- **Username:** unique, changeable, lowercase `[a-z0-9][a-z0-9._-]{1,31}` with at least one letter (`USERNAME_RE` = `/^(?![0-9._-]+$)[a-z0-9][a-z0-9._-]{1,31}$/`, so it can never equal a phone alias; P23.1.16). `add` and `rename` also refuse (`CONFLICT`) a username equal to another person's id or to an alias value (`person_identifiers.value_norm`), inside the same transaction as the write (`person-store.ts`). Usernames made before this rule that hold digits only keep signing in; `keith-core doctor` lists them as a `!` note. It is the
  login name and the handle the CLI uses. A person is addressed by username or id (a UUIDv7 never
  looks like a username). Display `name` is separate (1-80 characters, default the username).
- **Role:** `owner` or `member` (`PersonRole`). Exactly one owner: a unique partial index allows at
  most one, and the service refuses everything that would leave none (see Rules). Guests are not
  people: anonymous guest mode exists and has no `people` row (`guests.md`, ADR-0017).
- **Status:** `active` or `suspended`. There is no `left`: a removed person has no row (see Rules, remove), and a stored `left` (never written) is read as `suspended` and rewritten by `backfillPeople` (ADR-0027 §26, F-051). Anything but `active` is denied: the principal
  resolver rejects their credentials (`auth.md`). `resolveRole` of eharness would answer `guest`;
  a person is never a guest, so the answer is "no access". Suspension **revokes every credential**
  of the person (since step 2): reactivating does not restore them, the person signs in again.
- **Accounts:** `PersonAccount(platform, nativeId)` as in eharness (unique among linked rows;
  `ACCOUNT_LINKED_ELSEWHERE`). Pairing codes (`issueCode`, `redeemCode`) follow spec 30: 8
  characters, stored as SHA-256, at most 3 pending per person, single use by compare-and-set.
  Nothing in P9 calls them yet.

## PersonStore adapter

`sqlitePersonStore(sqlite, { via? })` implements `PersonStore` from `eharness/identity` and passes
`personStoreConformance` from `eharness/testing`. Additions: `create` takes an optional `id` and
`username`; `update` takes `username`; `byUsername`, `owner()`, atomic
`transferOwner(from, to, actor, now)` (one `BEGIN IMMEDIATE` transaction: demote, then promote;
refuses a target who is the owner or not active) and `withVia(via)` (the same store writing events
with another `via`). `list` is newest updated first and searches display name, nickname, username,
field values and linked native ids. A role `null` means `member`. `delete(id)` removes the person,
accounts, pending codes **and the person's credential and legacy token rows** (so they stop working
at once); the delete event records how many live ones there were.

## Events

Every change writes an `audit_events` row `person.<event>` (`create`, `update`, `role`, `status`,
`link`, `unlink`, `pair`, `delete`): `actor` is the person id or `system`, `via` is `local` or `tcp`,
`detail` holds `personId` plus the change (`update`: the changed `fields`, and `from`/`to` for a
username; `role` and `status`: `from`, `to`; `delete`: `username`, `role`, `credentialsRevoked`).
No secrets. Events are kept after `delete`; `store.events(personId)` reads them back, newest first.

## Rules (service `createPeopleService`)

- `add`: the username must match the format and be free; role `owner` is refused (add a member,
  then `transfer-owner`); `createdBy` is the caller.
- `rename`: a new username (free) and/or a new display name.
- `setRole`: `owner` is refused (use `transferOwner`); the owner's role cannot change. With two roles
  this is a no-op for a member, so the revoke on a role change cannot fire today; it exists for the roles that come later. A real role change would revoke
  the person's sessions.
- `suspend` refuses the owner and revokes the person's sessions; `reactivate` sets `active` again. Both are idempotent.
- `remove` refuses the owner (transfer first), keeps the person's data (below), then deletes the person and their credentials. Their **ACL resources go to the owner**, their `user:` entries and group memberships are dropped, in the same transaction as the delete (`sqlitePersonStore` option `beforeDelete`, wired to `AclStore.removePerson`); a failure rolls the whole removal back and a move is audited as `person.resources.moved`. Nothing routes to a removed person: no reconcile, dead letter, feed or approval. Boot recovery and graceful stop still enumerate every person who exists (so a suspended person's front session is repaired, `resume.md`, `compose-sessions.ts`). One rule for "which people count" (ADR-0027 §15), written once in `platform/sessions.ts` as `countsFor(purpose, status)` and `peopleFor(purpose, people)`: `route` counts `active` only (reconcile, the dead-letter notice, the owner's attention roots, and the wake check of plugins); `recover` counts `active` and `suspended` (boot recovery, graceful stop). A suspended person's worker rows are repaired at boot and reconciled again when the person is reactivated (`tasks.md`). The reminders plugin reads `active` through the host `person()` fact (its own check), and a plain plugin wake checks the recipient before it injects (P24.3.3).
  `budget.get` lists no row for them.
- **Removal keeps the data (ADR-0027 §26, `modules/people/removed.ts`, `removal-registry.ts`).** Before the delete, every module registered with `registerRemoval` keeps its part of the person's data in `workspace/keith/removed/<personId>/`: `memory/` (moved from `memory/<personId>/`), `workspace/` (moved from `workspace/people/<personId>/`), `conversation.jsonl` (the stored messages of the person's front session and their workers' sessions, one per line; their `eh_messages` rows are deleted) and `manifest.json` (`{ personId, username, name, removedAt, purgeAt }`, `purgeAt` = `removedAt` + 30 days, `CoreTiming.removedKeepMs`). The folder is 0700, its files 0600. A part that throws refuses the removal, and the parts that ran are undone, so a refused removal changes nothing. The prune tick and boot purge the folders whose `purgeAt` has passed (each module's `purge`, then the folder); a folder without a valid manifest is never purged. `people.remove` answers `{ id, keptUntil }` and audits `person.removed.kept { person, until }`; a purge audits `person.removed.purged { person }`. The kept folder is never mounted into a worker (workers mount only `workspace/people/<id>`). The core's other per-person tables follow in P26.3.5. The context reset's part (`modules/wernicke-broca/removal.ts`, ADR-0030 §11) keeps the `front_generations` row with the person and deletes it at purge; the conversations part already holds every generation of the person (`front:<id>` covers `front:<id>:g<n>`).
- **Where a person's data lives (FD11-04, `modules/people/removal-core.ts`).** Found by session (`front:<id>`, and the workers `front:<id>:...`) or by id. Removal: a running worker is stopped first (`tasks` set `stopped`, error `person removed`); then `tasks` (`parent_session_id`), `owner_reviews` (`requester`, payload included), `eh_inbox`, `eh_inbox_keys`, `eh_state`, `eh_locks`, `eh_schedules`, `eh_stream_log`, `eh_stream_chunks`, `events` (their sessions) and `person_pair_codes` are deleted in one immediate transaction; the tasks and reviews go to `data.json` first. `pairing_codes.created_by` and `groups.created_by` move to the owner. Not touched: budget ledger rows (`eh_budget_*`), audit rows, ACL moves (`resource_acl`), `person_identifiers` and `person_accounts` (the store's delete). Their conversations (`eh_messages`) and memory and workspace are kept in the folder (above). The dream judge keeps no transcript (`dreaming.md`, "Judge"), so no `dream-judge:` session row exists to find, keep or purge; the prune tick clears such rows that older installs stored. A test scans the tables with a session, requester, parent-session or creator column and fails for one that is neither handled nor listed with its reason.
- **Shared rooms (P30.2.4, `modules/corpus-callosum/removal.ts`).** The room module is a removal part: its memberships end as `removed` (its `rooms.json` in the kept folder, undone when a later part fails), `export` copies that dump, and `purge` deletes the member rows; the transcript of a room stays with the room. A suspension ends the person's memberships as `suspended` through an identity listener. See `corpus-callosum.md` "Removal of a person".
- **Dreaming part (P35, ADR-0031 §8, `modules/hippocampus/dream/removal.ts`; the removal part of the list above, not a separate heading).** On removal the part moves the `dreams/<personId>/` folder (staged plans, preimages) into the kept folder as `dreams/`, so nothing is left in `dataDir`; the `dream_settings` and `dream_runs` rows stay in the database (no foreign key) until `purge` deletes both; the memory folder moves as before. `export` writes nothing.
- **Activity logs part (P36, ADR-0032 §7, `modules/audit/activity-logs/removal.ts`; the removal part of the list above).** On removal nothing moves: the person's `llm_sessions`, `llm_calls` and `llm_bodies` rows stay and expire by their periods (`db.md`, Retention). A room session stays with its room. `export` adds `activity-logs.json` (the figures, and the decoded bodies when stored; redacted at write time) to `admin.people.export`. `purge`, at `purgeAt` (30 days, with the kept folder), deletes the person's sessions, calls and bodies, clears the `speaker_id` of their room calls, and audits `data.pruned` with counts.
- **Export (ADR-0027 §26, `modules/people/export.ts`).** `admin.people.export` (`{ person }` or `{ removed: <personId> }`, exactly one) writes `<dataDir>/exports/<username>-<timestamp>.tar` (folder 0700, file 0600) with `memory/`, `workspace/`, `conversation.jsonl` and `manifest.json`, and answers `{ path, personId, files }`. A removed person is exported from their kept folder while it is kept. **Owner only**: a delegate with `people.manage` is refused (`FORBIDDEN`), even after a step-up. The write audits `person.exported { person, removed, files }` and an `acl.owner-access` row (`reason: export`), which the member sees as "the owner exported your memory, workspace and conversations". Every part comes from the removal registry's `export` hook. The archive is written by `platform/archive.ts` with `tar`, so every file keeps its mode (`backup.md`, the archive).
- `succeed(ref, proof, by)` (P29.3.1): the heir's claim path (`succession.md`, "The claim"). The `proof` is a `SuccessionProof`
  minted only by the succession module (`mintSuccessionProof`, re-exported from the people index; a test pins the importers),
  so no RPC or CLI call reaches it. The heir must be active, able to sign in and hold a secret (F-013). In one transaction
  (store `succeed`) the heir becomes the owner and the previous owner becomes `suspended` as a member; both persons' sessions
  are revoked, and `identity.changed` is raised for both (`transfer` for the heir, `suspend` for the previous owner).
- `transferOwner`: the hand-over path of ownership (ADR-0022 §2; the other path is the heir's claim, `succeed` above). Only the owner may call it; the target must exist, be active, be able to sign in (`can_login` on; otherwise refused with `cannot sign in: turn sign-in on first`, naming `keith-core people login <username> on`, FD13-02) and have a password or a PIN (F-013: a new owner must be able to sign in); the current owner becomes a member in the
  same transaction, and **both people's credentials are revoked** (the new owner steps up as owner,
  the former one signs in again as a member). The implicit owner of the local socket (opt-in local trust, `auth.md`) has no credential and always
  resolves to the **current** owner, so it follows the transfer.
- **Delegation guard (ADR-0022).** `people.manage` is for members: a caller who is not the owner is refused (`FORBIDDEN`) any
  password, PIN, clear, unlock, rename, alias or grant change whose target is the owner, `transferOwner`, and `grant` or
  `revokeGrant` on themselves. `PeopleService.authorize(ref, by, what, { notSelf })` holds the check, so RPC, socket and CLI
  paths share it; the caller is `by.actor` read from the store, and an actor that is no person (`system`, the offline CLI) acts
  as the owner. Proof: `modules/people/people-guard.test.ts`.
- Errors: `PeopleError` codes `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT` and `FORBIDDEN` become the same oRPC codes.

## Secrets (P9 step 2)

Password and PIN of a person live in `person_secrets` (argon2id; `auth.md` has the rules, the login
route, throttling and step-up). Service `createSecretsService` (`modules/people/secrets.ts`):
`setPassword` (rules checked against the person's username and name; revokes the person's sessions;
audit `person.secret.set`), `setPin` (6-12 digits; ends the sessions the PIN made, keeps the others), `clear(kind)` (a cleared password
revokes sessions; audit `person.secret.cleared`, only when it was set), `unlock` (clears the lock and
every failure counter; audit `person.secret.unlock`; returns whether the person was locked). A removed
person loses their secrets and counters with the rest. A member locked by 20 failures stays locked
until `unlock`; the owner is never locked.

## API (`admin.people.*`, capability `people.manage`)

| Procedure | Input | Output |
| --- | --- | --- |
| `list` | - | `Person[]` |
| `get` | `{ person }` | `Person` |
| `add` | `{ username, name?, role? }` | `Person` |
| `rename` | `{ person, username?, name? }` (at least one) | `Person` |
| `setRole` | `{ person, role }` | `Person` |
| `suspend`, `reactivate` | `{ person }` | `Person` |
| `remove` | `{ person }` | `{ ok: true, id, keptUntil }` (`keptUntil`: when the kept data is purged) |
| `export` | `{ person }` or `{ removed }` | `{ path, personId, files }` (owner only) |
| `setLogin` | `{ person, canLogin }` | the person (owner only; `canLogin` on the view) |
| `transferOwner` | `{ person }` | `{ owner, previousOwner }` |
| `setPassword` | `{ person, password }` | `{ ok: true }` |
| `setPin` | `{ person, pin }` | `{ ok: true }` |
| `clearSecret` | `{ person, kind: 'password' \| 'pin' }` | `{ ok: true }` |
| `unlock` | `{ person }` | `{ ok: true, wasLocked }` |
| `grants` | `{ person }` | capability ids (the person's grants that are registered now) |
| `grant`, `revokeGrant` | `{ person, capability }` | capability ids (the grants now) |

`Person` = `{ id, username | null, name, role, status, createdBy | null, createdAt, updatedAt }`.
Authority is the capability metadata on each procedure (`permissions.md`): every procedure needs
`people.manage` (the owner has it; a member gets `FORBIDDEN` unless granted), and every one that
changes something needs a step-up over TCP (`KEITH_STEP_UP_REQUIRED`, 403); `list`, `get` and `grants`
do not. `auth.whoami` also returns `username`, `elevated` and `capabilities` (role table plus grants).

**Grants.** Table `person_grants(person_id, capability, granted_by, created_at)`, primary key
(person, capability); the rows go with the person. A grant adds one capability of the closed set at runtime (the core ids and the ids of loaded plugins, `plugins.md`; an unknown id is `BAD_REQUEST`) to a
person on top of their role (`GrantsService`, `modules/people/grants.ts`; the store is `grantsRepo` in
`@keith/db`). Granting is idempotent and audited (`person.grant`, `person.grant.revoked`, detail
`{ personId, capability }`); the owner has everything, so granting to the owner is `BAD_REQUEST`, and so is granting an owner-only capability (`audit.read`, `groups.manage`, `reviews.decide`, `plugins.manage`, `guests.manage`, `permissions.md`; a stale stored `audit.read` grant of an older version is ignored and `keith-core doctor` lists it). A
grant never lowers a step-up requirement. Capabilities are read per request, so a grant or revoke
applies to the next call (an unknown id in the table is ignored).

## Identifiers and `can_login` (P14, ADR-0014; contracts in `auth-flow.ts`)

A person signs in by **identifier**: user id, username, email or phone, never the display name (not unique, guessable).
Email and phone are **admin-set aliases** in the table `person_identifiers(person_id, kind, value_norm unique, created_by,
created_at)`; there is no mail or SMS, no verification and no self-registration. Values are normalised (trim, lower-case,
phone digits with `+`) before they are stored and compared. `person_accounts` stays the channel directory (chat apps, voice).
`people.can_login` (integer, default 1) says whether a Person is a User that may sign in; a Person with `can_login = 0` is a
directory entry only and gets the uniform sign-in failure. Only the owner sets it: `admin.people.setLogin` (`{ person, canLogin }`, `people.manage` with a step-up over TCP, **owner only**: a delegate is refused with `FORBIDDEN`, ADR-0027 §27), CLI `keith-core people login <username> on|off`, and the TUI Manage people row (owner only). The owner and the owner's own account are refused (`BAD_REQUEST`). Turning it **off** ends the person's sessions (credentials and legacy tokens revoked, streams closed, `identity.changed` reason `can_login`) and keeps their password, PIN and credentials stored; turning it on changes nothing else. Audit `person.login.set { person, canLogin }`, once per change. The member's `Person` shows `canLogin`. The table and the column exist since migration 0008 (`db.md`); since P14 step 5 the identifier-first flow and `/auth/login` read them (`auth.md`). A password sign-in and a PIN sign-in of a person with 0 get the same refusal as an unknown person (`secret-login.ts`, reason `not_permitted`).
Aliases are managed by the owner: `admin.people.alias.list|add|remove` (`people.manage`; add and remove need a step-up
over TCP), CLI `keith-core people alias add <username> <email|phone>`, `alias remove <value>`, `alias list <username>`. An
alias must be a valid email (`a@b.c`) or phone (6 to 15 digits, optional `+`); it is refused when the value is already an
alias, a username or a user id. Audit `person.alias.add|remove` (kind and person, never the value). Removing a person deletes
their aliases.

## CLI

`keith-core people list|add|rename|role|suspend|reactivate|remove|transfer-owner|passwd|pin|unlock|clear-password|clear-pin|grant|revoke-grant|alias` over the local
socket (`core-cli.md`); output through `@keith/cli` `printTable`.

## Tests

`packages/db/src/eh/conformance.test.ts` and `person-store.test.ts` (store);
`modules/people/people.test.ts` (commands, API, status against credentials, remove, transfer, audit);
`modules/auth/flow.test.ts` (aliases: normalisation, conflicts, removal with the person); `modules/people/secrets.test.ts` (passwd, pin, unlock, clear over the CLI; step-up over TCP; revocation on password change and transfer).
