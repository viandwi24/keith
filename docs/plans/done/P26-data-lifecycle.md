# P26 — Data lifecycle: safe migrations, backup and restore, removed people, sign-in switch, node tokens

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku and Sonnet implementers, orchestrated; `bun run check` 2903 pass and `bun run smoke` 59 steps pass) · depends on: P23; ships right after P23 and before P24 and P25 (P22 order), because every later migration relies on phase 1 (backup, lock); migration numbers are the next free one, generated · ADR: 0027 §3, §25, §26, §27, §28 · closes: F-011, F-026, F-027, F-051, C-13, doc gaps 4, 6, 9, 13, FD11-01, FD11-02, FD11-03, FD11-04, FD11-07, FD11-10, FD11-11 (second review round, `docs/flow-review/2026-11-10-folded/`; FD11-09 was fixed in the docs on Nov 10, step P26.5.2 finishes the comment)

## Goal

The owner can upgrade Keith without fear (a backup is taken before any migration, and one command restores it), can remove a person without
losing or leaking their data by accident (it is kept for 30 days, exportable, then purged), can switch a person's sign-in off and on, and the
node connection no longer lives forever on one token or accepts unlimited traffic. Every one of these now has one written contract.

## Why

- **F-011 / C-13** `runCore` (`apps/core/src/run-core.ts:55-67`) and setup (`apps/core/src/modules/admin/offline.ts:71-73`) migrate silently and take
  no backup, while db.md:104, `packages/db/AGENTS.md:7`, `packages/db/src/connection.ts:28` and ADR-0014/0016 say "never at boot" and
  core-cli.md:47 and `docs/deploy/README.md:44` say the opposite. ADR-0027 §3 decides: migrate at start and setup, only after a `VACUUM INTO`
  backup, and print what ran.
- **F-027** `db migrate` (`apps/core/src/cli/ops-commands.ts:115-121`) checks only the socket, not `core.lock`.
- **F-026** `acquireLock` (`apps/core/src/modules/admin/lockfile.ts:50-56`) reads the pid, removes the file and creates it again: two starters can
  both take a stale lock.
- **F-051** the `left` status (`packages/contracts/src/people.ts:8`) and "or deletes it" on removal are documented but unimplemented.
- **Doc gap 4** no contract for export, purge or retention of a removed person's data (people.md:74-75, SECURITY.md:102-103). ADR-0027 §26.
- **Doc gap 6** `people.can_login` has no writer (people.md:138-139). ADR-0027 §27.
- **Doc gap 9** node tokens never expire and node messages have no rate limit (SECURITY.md:136-137). ADR-0027 §28.
- **Doc gap 13** backup, restore and upgrade order are spread over deploy/README and db.md. ADR-0027 §25.

## Scope

In:
- Backup before migration (`VACUUM INTO`), migrate at `start` and setup, `db migrate` under `core.lock`, atomic stale-lock takeover.
- `keith-core backup` and `keith-core restore`, one spec, the upgrade order in core-cli.md and the deploy guide.
- Removal keeps conversations, memory and workspace in `workspace/keith/removed/<personId>/` for 30 days, then purges; `keith-core people export`.
- Drop `left` from the status enum (and its remaining readers).
- `admin.people.setLogin`, `keith-core people login <username> on|off`, a key in the TUI People section.
- Node token rotation after 30 days and a per-node message rate limit.

Out (with where it goes):
- Scheduled automatic backups and off-machine copies: not planned; the owner runs `backup` from cron (documented). Encryption of the archive: not planned (the archive holds `secret.key`; the spec says to treat it as the data folder).
- TLS, web UI, mail or SMS recovery, TOTP, per-reminder time zones: ADR-0027 §29, recorded as not planned.
- The audit-visibility and credential items of ADR-0027 §5 and §6: other plans.
- Node drivers and node approval changes (P31). P31 builds protocol v3 on top of the v2 of this plan.

## Design

### Migrations with a backup (ADR-0027 §3)

New `migrateWithBackup(config, plugins, log)` in `apps/core/src/platform/db.ts`, the only function that migrates an existing database:

1. No database file: create it (no backup, nothing to lose).
2. Behind (`isMigrated` false): write `<dataDir>/backups/keith-<yyyymmdd-hhmmss>.db` with `VACUUM INTO` (mode 0600, folder 0700), run
   `PRAGMA integrity_check` on the copy; if either fails, **refuse to migrate** (`StartError`: "could not back up the database: <reason>; nothing was changed").
3. Migrate core then plugin journals, print one block (`database <file> was behind: applying N migration(s): <tags>; backup <path>`), record audit
   `db.migrated { from, to, backup, pluginMigrations }` with `via: 'offline'` (setup, `db migrate`) or `'local'` (start).
4. Keep the newest 5 `keith-*.db` snapshots; older ones are deleted by the same function (the owner's `backup` archives are never touched).

Callers: `runCore` (after taking the lock; a missing data folder is created with `secureDataDir` first, so no migration runs before the lock), `openOfflineAdmin`
(`migrate: true`), `keith-core db migrate`. `assertMigrated` still refuses a behind database anywhere else (unchanged: `keith-core status`, tests).
`db migrate` calls `requireOffline`, then `acquireLock`, then `migrateWithBackup`, then releases (F-027).

### Atomic stale-lock takeover (F-026)

`acquireLock` keeps `wx` creation. A stale lock is taken over under a **takeover guard**: `core.lock.takeover` created with `wx`. The holder re-reads
the pid under the guard (still stale?), removes the lock, creates it with `wx`, removes the guard. A process that finds the guard present waits up to 2 s
(20 ms steps) and starts again from the top, where it now sees a live pid and throws `LockHeldError`. A guard older than 10 s is stale and removed.
Test: five child processes (`Bun.spawn` of a small script) race for one stale lock; exactly one wins.

### Backup and restore (ADR-0027 §25, spec `docs/specs/backup.md`)

`keith-core backup [--out <dir>]` (works with the core running or stopped; no lock): writes `<out or dataDir/backups>/keith-backup-<timestamp>.tar` (0600) containing
`manifest.json` (`{ version, migrations: {core, plugins}, createdAt, includes }`), `keith.db` (a `VACUUM INTO` snapshot, so it is consistent), `secret.key` when the file
exists, `workspace/` and `memory/`. Not included: `core.sock`, `core.lock`, `backups/`, logs. When the secret key comes from `KEITH_SECRET_KEY` the command says that the key is **not** in the archive.
Audit `backup.created { bytes, includes }` (`via: 'local'`).

`keith-core restore <archive> [--force]` (core stopped; takes `core.lock`): checks the manifest, refuses an archive whose migration count is higher than this
Keith ships ("this backup is from a newer Keith"), runs `integrity_check` on the database inside, refuses when the data folder already holds a database unless
`--force`, moves what is there into `<dataDir>/restore-previous-<timestamp>/` (never deletes it), extracts, fixes modes (0600/0700), and prints `run keith-core doctor, then keith-core start`.
Archive format: `Bun.Archive` (`typeof Bun.Archive` is `function` in the installed Bun; step P26.2.1 confirms modes and symlink handling); only if it lacks a needed feature, `tar` through `Bun.$` with the reason written in ADR-0006 (AGENTS.md rule 11).

Upgrade order (the text added to core-cli.md, "Upgrading and rolling back", and mirrored in `docs/deploy/README.md`):

1. `keith-core backup` (the core may keep running). Copy the archive off the machine if it matters.
2. Stop the core service. Nodes may stay up: they reconnect.
3. `git pull && bun install` (and `bun run link` if commands changed).
4. `keith-core doctor --offline`: a pending migration shows as `!` with the count.
5. `keith-core start` (or `keith-core db migrate` to migrate without serving). Before the first migration Keith writes `backups/keith-<timestamp>.db`
   and prints the list of migrations it applies; if the backup fails, nothing is migrated.
6. `keith-core doctor`, then open `keith`. Update nodes afterwards (`git pull` on each machine, restart `keith-node run`): the core accepts every node at or above `MIN_PROTOCOL`.
7. Roll back: stop the core, `git checkout <previous tag>`, `keith-core restore <archive from step 1 or backups/...>`: an older Keith cannot read a database that a newer one migrated, so restore the copy made before the upgrade. For a `.db` snapshot alone, stop the core and copy it over `keith.db`.

### Removed people (ADR-0027 §26)

`people.remove` (service in `apps/core/src/modules/people/people.ts`) runs the **removal hook registry** before the store delete; if a part throws, the removal is refused and nothing changes. The registry (`apps/core/src/modules/people/removal-registry.ts`) is `registerRemoval({ module, onPersonRemoved: { keep(personId), export(personId): Promise<Entry[]>, purge(personId) } })`: `keep` runs at removal, `export` is called by `people export`, `purge` by `purgeRemoved` after the keep time. This plan registers the first parts (memory, workspace, conversations); P25 (pending deliveries), P27 (clients, signals, status, disclosure), P28 (protocols, runs, agenda) and P30 (rooms) register their own data in their own steps, so no module edits `people.ts` again (AGENTS.md rule 3).
New `apps/core/src/modules/people/removed.ts`:

- `keepRemoved(dataDir, person, deps)`: creates `workspace/keith/removed/<personId>/` (mode 0700; `keith` is already part of the workspace layout, `cortex/workspace.ts` `LAYOUT`), moves `memory/<id>/` to `.../memory/` and `workspace/people/<id>/` to `.../workspace/`,
  writes `conversation.jsonl` (the person's front session and their workers' sessions, read from the message store, one stored message per line) and `manifest.json` (`{ personId, username, name, removedAt, purgeAt }`), then deletes those session rows. An id that cannot name a folder (`SAFE_ID`) is refused.
- `purgeRemoved(dataDir, now)`: deletes every folder whose `purgeAt <= now`, writes `person.removed.purged { person }`. It runs at boot and in the prune tick (`apps/core/src/compose.ts`). `CoreTiming.removedKeepMs` default 30 days (tests set it small).
- `keith-core people export <username> [--out <file>]`, RPC `admin.people.export` (**owner only**, step-up over TCP, audited `person.exported`, plus `acl.owner-access`): writes `<dataDir>/exports/<username>-<timestamp>.tar` (0600) with the memory folder, workspace folder and `conversation.jsonl` of an existing person, and prints the path. A person already removed can still be exported while their folder exists (`--removed <personId>`).
- `keith-core people remove` prints: `removed; data kept in workspace/keith/removed/<id> until <date>; run people export first for an archive`. Audit `person.removed.kept { person, until }`.
- `doctor` lists kept folders with their purge dates (a `!` note, never `✗`).
- Budget ledger rows, audit rows and ACL moves stay as people.md already says; reminders of or for the person end as `creator-gone` / `recipient-gone`.

Drop `left` (F-051): `PersonStatusSchema` = `active | suspended`; the readers are fixed (`apps/core/src/compose-sessions.ts:30` takes everyone listed, `modules/budget/procedures.ts:18` filters nothing, `packages/host/src/guard.ts:27` and `testing/memory-host.ts` use the two values, with `remove` deleting the person from the fake directory).
`modules/acl/groups.ts:53` shows an orphan group member as `removed`: the group view schema (`packages/contracts/src/acl-admin.ts`) gets `GroupMemberStatusSchema = PersonStatusSchema | 'removed'`. `backfillPeople` (idempotent) rewrites an old `people.status = 'left'` row to `suspended`.

### Sign-in switch (ADR-0027 §27)

Contract `PeopleSetLoginInputSchema = { person: string, canLogin: boolean }` in `packages/contracts/src/people.ts`; procedure `admin.people.setLogin` (**owner only**, as ADR-0027 §27 says; step-up over TCP; the target must be a member: the owner and the caller themselves are refused by the people service). A `people.manage` delegate cannot call it; they keep suspend and the other delegable actions of ADR-0022.
Service `people.setLogin(ref, canLogin, by)` writes `people.can_login`; turning it off revokes the person's sessions and credentials stay stored. Audit `person.login.set { person, canLogin }`. Sign-in already reads `can_login` (`packages/db/src/repos/secrets.ts:65`, `identifiers.ts:57`) and answers the uniform failure. CLI `keith-core people login <username> on\|off` (offline owner, or the running core with a step-up).
TUI `People` section (`apps/tui/src/features/manage/people/`): a row of a person with sign-in off shows `no sign-in`; key `l` toggles (step-up prompt already exists for people actions).

### Node tokens and rate limit (ADR-0027 §28)

- **Rotation.** `nodes` gets `token_issued_at` (set at join, default `created_at` for old rows) and `token_next_hash` (nullable). Protocol v2 (this plan owns v2 = token rotation and rate limit; P31 adds v3 for drivers; `packages/contracts/src/node-protocol.ts`, `PROTOCOL_VERSION = 2`, `MIN_PROTOCOL` stays 1): core to node `rotate { token }`, node to core `rotated`. After a successful `welcome`, if the node's hello is v2 and `now - token_issued_at > 30 days`, the core creates a token, stores only its hash in `token_next_hash`, and sends `rotate`. The node writes `node.json` atomically (temp file, mode 0600, rename), reconnect uses the new token, and replies `rotated`; the core then moves `token_next_hash` into `token_hash`, sets `token_issued_at`, audits `node.token.rotated`. `findByTokenHash` accepts the current **or** the next hash (a lost `rotated` ack is completed by the first connection with the new token), `revoke` scrambles both. A v1 node is never rotated (a doctor `!` note says `node <name> uses an old protocol`).
- **Rate limit.** `gateway.ts` counts messages per node socket in a sliding window (200 per 10 s, `GatewayOptions.rate`): over the limit a message is dropped and `node.rate_limited { node }` is audited at most once per 5 minutes; 30 s of continuous overload closes the socket with code 4008, and the node daemon reconnects with backoff (it is not one of the permanent codes).

### Retention (FD11-03, FD11-11)

One table in `docs/specs/db.md` ("Retention", P26.1.5 holds the inventory test, P26.5.1 the code). Everything below is deleted by the prune tick and audited as `data.pruned { table, count }`.

| Table | Rows deleted | After |
| --- | --- | --- |
| `credentials`, `client_tokens` | revoked, rotated, evicted or expired (never a live one) | 90 days |
| `tasks` | finished (`done`, `failed`, `stopped`, `timed_out`, `interrupted`) | 90 days |
| `eh_inbox`, `eh_inbox_keys` | dead letters | 30 days |
| `eh_budget_reservation` | closed (committed or released) | 7 days |
| `pairing_codes` | expired: pruned by P24.2.3 (`purgeExpired` in the prune tick); this table holds the number | 1 day |
| `owner_reviews` | decided | 30 days (P24.6.2) |
| `eh_stream_log`, `eh_stream_chunks` | expired logs | at the next tick (10 minute log life) |
| kept on purpose | `eh_budget_record` (the spend record), `audit_events` (`audit.retentionDays`, default 180) | not by this tick |

### Contracts, audit kinds, errors

Audit kinds new: `data.pruned`, `db.migrated`, `backup.created`, `backup.restored`, `person.removed.kept`, `person.removed.purged`, `person.exported`, `person.login.set`, `node.token.rotated`, `node.rate_limited`. No secret and no text is ever written.
Errors: `BAD_REQUEST` for a bad archive or `--removed` id, `FORBIDDEN` for the delegation guard, `CONFLICT` for restore over a live database without `--force`.
The migration (next free number, generated by drizzle-kit, never chosen by hand) adds `nodes.token_issued_at` and `nodes.token_next_hash`; additive, covered by the backup of this plan.

## Phases

### Phase 1 — Migrations and the lock

Goal: nothing migrates without a backup, `db migrate` is safe, and a stale lock has one winner.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P26.1.1 | Atomic takeover | `apps/core/src/modules/admin/lockfile.ts`, `lockfile.test.ts` | thalamus.md (lock paragraph), core-cli.md | five racing child processes, one wins; stale guard removed after 10 s; own-lock-only release unchanged | race test passes 20 times in a loop of the test file |
| P26.1.2 | `migrateWithBackup` and snapshot retention | `apps/core/src/platform/db.ts`, `apps/core/src/platform/db.test.ts`; `packages/db/src/connection.ts` (fix the stale comment on `migrateDatabase`), `packages/host/src/storage/migrate.ts` and `packages/host/src/types.ts` (the "never at boot" comments about plugin journals: `migrateKeithDatabase` applies them at start, `platform/db.ts:56`) | db.md "Migrations" (and the plugin-journal line that says "never at boot", fixed in the doc-pointer pass), thalamus.md (boot order), `packages/db/AGENTS.md`, `docs/deploy/README.md` | behind database gets a snapshot with the same rows and an `integrity_check` ok; a failing backup (read-only folder) leaves the schema untouched and refuses; 6th snapshot deletes the oldest; new database makes no backup; audit `db.migrated` | tests pass; four docs agree |
| P26.1.3 | Use it in start, setup and `db migrate` | `apps/core/src/run-core.ts`, `apps/core/src/modules/admin/offline.ts`, `apps/core/src/cli/ops-commands.ts`, `apps/core/src/cli/cli.test.ts`, `apps/core/src/e2e.test.ts` | core-cli.md (`start`, `db migrate` rows), thalamus.md | start on a behind file prints the block and writes the snapshot; `db migrate` with the lock held by another pid fails with `LockHeldError` text; first run with no data folder migrates only after the lock | refusal test of an unmigrated database elsewhere still passes |
| P26.1.4 | Upgrade drill on a seeded database: seed people, notes, reminders, a running worker row and a pending approval at the previous commit's schema, then `migrateWithBackup`; assert counts, snapshot content and boot recovery (worker repaired, approval still pending). Keep plugin journal order (core, then plugins). | `apps/core/src/platform/upgrade-drill.test.ts`, `packages/db/src/migration-*.test.ts` helpers | db.md "Migrations" | counts equal before and after; the snapshot opens and holds the old rows; boot recovery runs on the migrated copy | the drill passes on a database that is not empty |
| P26.1.5 | Retention inventory: a table in db.md (table, retention, pruned by) and a test that lists every table in `schema/` and fails when one has no row. Later plans add their tables to it in their own migration step. | `docs/specs/db.md`, `apps/core/src/platform/retention-inventory.test.ts` | db.md "Retention" | the test lists the tables of `schema/*.ts` and compares with the table rows | every table has a retention row |
| P26.1.6 | **FD11-01 and FD11-10: a database newer than the code is refused, and startup failures are told apart.** Execution order: P26.1.1, P26.1.2, P26.1.6, P26.1.3 (the ahead check sits inside `migrateWithBackup`, before any backup or migration). `dbState(config)` returns `missing`, `ready`, `behind`, `ahead`, `diverged` or `unreadable(reason)`: it compares the rows of `__drizzle_migrations` (hash and `created_at`) with the shipped journal, so more applied than shipped is `ahead`, and the same count with a different hash is `diverged`. `assertMigrated`, `openKeithDatabase`, `runCore`, `keith-core status`, `db migrate` and the plugin check refuse `ahead` and `diverged` with "this database was migrated by a newer Keith (<n> applied, this build ships <m>): update Keith, or `keith-core restore` a backup made before the upgrade" (there is no downgrade). `unreadable` (corrupt file, EACCES, `SQLITE_BUSY`) keeps the SQLite reason and points at `backups/`; `configured()` and `main.ts` no longer say "run setup" or "run migrate" for it. `doctor` prints one line per state (`ahead`, `diverged` and `unreadable` are `✗`, `behind` is the existing note). | `packages/db/src/connection.ts:50-62` (`dbState`, `assertMigrated`), `apps/core/src/platform/db.ts:63-77` (`isMigrated` becomes `dbState`), `packages/host/src/storage/migrate.ts:68` (plugin journals the same), `apps/core/src/run-core.ts`, `apps/core/src/cli/start.ts:20-31`, `apps/core/src/main.ts:13-18`, `apps/core/src/cli/ops-commands.ts`, `apps/core/src/cli/doctor.ts:70-78` (after P23.1.0: `cli/doctor/checks/database.ts`) | db.md "Migrations" (the refusal table: behind, ahead, diverged, unreadable), core-cli.md (`start`, `db migrate`, `doctor`), thalamus.md (boot order) | `db.test.ts` and `connection.test.ts`: an extra row in `__drizzle_migrations` is refused by `openKeithDatabase` and `runCore` (a `StartError` with the text above, no backup written, nothing changed); same count with another hash is `diverged`; a database held by `BEGIN EXCLUSIVE` in another connection is `unreadable`, not `behind`; a file without read permission is `unreadable`; `cli.test.ts` doctor lines | rolling back the code without the restore step stops with a clear message instead of failing later at an insert |
| P26.1.7 | **FD11-02: `secureDataDir` owns only Keith's own top-level files.** It sets modes on `<dataDir>` itself (0700) and on `keith.db`, `keith.db-wal`, `keith.db-shm`, `secret.key`, `instance-id`, `core.lock` (0600), and on `logs/`, `backups/`, `exports/` (0700, their files 0600, one level); it never walks `workspace/` or `memory/` (they keep the modes their owners created under umask 077, so an executable a worker built stays executable) and never recurses into anything else. One unreadable entry is a warning, not a throw, and `start` is never blocked by it. The list is one exported constant (`OWNED_ENTRIES`) shared by `doctor` (`looseModes`, same list, no second walk) and by the restore step P26.2.3 ("modes are fixed" means this list). The client's own files (`client.json`, `client-state.json`, `~/.keith` 0700) stay as they are in `packages/client/src/config.ts`. | `apps/core/src/platform/db.ts:12-27` (`secureDataDir`, the four call sites in `openKeithDatabase` and `migrateKeithDatabase`), `apps/core/src/cli/doctor/checks/loose-modes.ts` (`looseModes`, the `OWNED_ENTRIES` consumer after P23.1.0), `apps/core/src/platform/db.test.ts` | db.md:16-17 ("every file in it 0600" becomes "every file Keith owns at the top level"), people.md and cortex.md (workspace files keep the mode the worker gave them), core-cli.md (doctor) | `db.test.ts`: a 0644 `keith.db`, `secret.key` and `logs/x.log` become 0600; `workspace/people/<id>/run.sh` 0755 and a `.git/hooks/pre-commit` stay executable; a workspace tree of 5 000 files is not visited (count of `lstat` calls through an injected fs stays under 50); an unreadable `workspace/x` does not throw | no start, setup or offline command touches a worker's files |

Phase gate: `bun run check` and `bun run smoke`.

### Phase 2 — Backup and restore

Goal: one command saves everything that matters and one command brings it back.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P26.2.1 | Archive helper and the spec | `apps/core/src/platform/archive.ts`, `apps/core/src/platform/archive.test.ts`, `docs/specs/backup.md` (new), `docs/decisions/0006-*.md` only if `tar` is needed (check `typeof Bun.Archive` first) | backup.md | round trip of a tree with modes; a path traversal entry is refused on extract; symlinks are not followed | helper green |
| P26.2.2 | `keith-core backup` | `apps/core/src/cli/backup-commands.ts`, `apps/core/src/cli/program.ts`, `apps/core/src/cli/backup-commands.test.ts` | backup.md, core-cli.md (command table) | archive has manifest, a consistent database that opens, `secret.key` when present, no `core.sock`; works while a core is running (e2e) ; env key warning printed | e2e passes |
| P26.2.3 | `keith-core restore` | same files, `apps/core/src/cli/restore.test.ts` | backup.md, core-cli.md | refuses a newer archive, a live database without `--force`, a corrupt db; `--force` moves the old files to `restore-previous-*`; modes are 0600/0700; round trip `backup -> wipe -> restore -> doctor` | round trip passes |
| P26.2.4 | Upgrade-order section and doctor | `docs/specs/core-cli.md` ("Upgrading and rolling back"), `docs/deploy/README.md` (Updating), `SECURITY.md` (backup holds the key), `apps/core/src/cli/doctor/checks/backup.ts` (new, listed in the table of `cli/doctor.ts`; `backup` check: `!` when the newest archive or snapshot is older than 30 days or none) | core-cli.md doctor row | `cli.test.ts` doctor cases | the seven-step text above is in both docs |

Phase gate: `bun run check` and `bun run smoke` (smoke gains: backup, wipe, restore, start; the block lives in `scripts/smoke/node-limits.ts`).

### Phase 3 — Removed people and the sign-in switch

Goal: removal is reversible for 30 days by an operator, exportable, then purged; `can_login` has a writer.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P26.3.1 | Drop `left` | `packages/contracts/src/people.ts`, `packages/contracts/src/acl-admin.ts`, `packages/db/src/schema/identity.ts` (the file that holds `people`; comment), `packages/db/src/repos/people-backfill.ts`, `apps/core/src/compose-sessions.ts` (+ test), `apps/core/src/modules/acl/groups.ts`, `apps/core/src/modules/budget/procedures.ts`, `packages/host/src/guard.ts`, `packages/host/src/testing/memory-host.ts`, `docs/specs/people.md`, `docs/specs/plugins/reminders.md` ("suspended or left"), `docs/specs/plugins.md` | people.md "Status" | backfill turns `left` into `suspended`; group view shows `removed` for an orphan; sessions test (`compose-sessions.test.ts`) updated | `grep "'left'"` finds only the tui key names |
| P26.3.2 | The removal hook registry and `keepRemoved` / `purgeRemoved`: `registerRemoval({ module, onPersonRemoved: { keep, export, purge } })`, called by `people.remove`, `people export` and the purge tick; this step registers memory, workspace and conversations | `apps/core/src/modules/people/removal-registry.ts`, `removed.ts`, `removed.test.ts`, `people.ts` (calls the registry), `apps/core/src/cli/people-commands.ts` (the `people remove` prompt and success line take the 30 day wording: "remove <username> and keep their data for 30 days? [y/N]"), `apps/core/src/compose.ts` (wiring, prune tick, `CoreTiming.removedKeepMs`) | people.md "Rules" (remove), core-cli.md (people rows), hippocampus.md and cortex.md (folder lists), `SECURITY.md` removed-data line | remove moves memory and workspace, writes manifest and conversation file, deletes session rows; a failing move refuses the removal and changes nothing; purge after the time; purge ignores folders without manifest; two persons never share a folder; leak check: the removed folder is not mounted into any worker, and a worker of any person cannot read `keith/removed` (cortex workspace layout test, `apps/core/src/modules/cortex/workspace.ts:8`, ADR-0021 §1: workers never mount `keith/`); a second module registered in the test is kept, exported and purged by the same calls | tests pass |
| P26.3.3 | `people export`; register the audit kinds `person.removed.kept`, `person.removed.purged`, `person.exported` in `AUDIT_SUBJECT_FIELDS` and `registerMySummary` (P23.2.3) | `packages/contracts/src/contract.ts` + `admin.ts` (export procedure), `packages/contracts/src/audit.ts`, `apps/core/src/modules/audit/mine.ts`, `scripts/exports.snapshot.json`, `apps/core/src/modules/people/procedures.ts`, `apps/core/src/cli/people-commands.ts`, tests in `people.test.ts` and `cli.test.ts` | people.md, core-cli.md, permissions.md (owner only note) | owner exports a member (tar has the three parts, mode 0600, audit rows `person.exported` and `acl.owner-access`); a delegate with `people.manage` gets `FORBIDDEN`; export of a removed person by id | tests pass |
| P26.3.4 | `setLogin` (owner only, ADR-0027 §27) | `packages/contracts/src/people.ts`, `scripts/exports.snapshot.json`, `packages/contracts/src/contract.ts`, `packages/db/src/repos/` (a `setCanLogin` on the person store or `identifiers.ts`), `apps/core/src/modules/people/people.ts`, `procedures.ts`, `apps/core/src/cli/people-commands.ts`, `apps/tui/src/features/manage/people/people-actions.ts` + state | people.md ("Identifiers and `can_login`"), core-cli.md, permissions.md | off: password and PIN sign-in give the uniform failure and sessions end; on: works again; the owner and the owner's own account are refused as targets; a `people.manage` delegate gets `FORBIDDEN` (the owner only); audit row; TUI toggle (owner session only) and label | tests pass (`people-guard.test.ts` extended) |
| P26.3.5 | **FD11-04: removal covers every per-person table.** After P26.3.2: the core registers its own data in the removal registry (`apps/core/src/modules/people/removal-core.ts`). Tables, matched by session prefix `front:<id>` (which includes the workers `front:<id>:agent:...`) or by person id: `tasks` (`parent_session_id`), `eh_inbox` and `eh_inbox_keys`, `eh_state`, `eh_locks`, `eh_schedules`, `eh_stream_log` and `eh_stream_chunks`, `events` (activity rows of those sessions), `owner_reviews` (`requester`, payload included), `person_pair_codes`. Two tables rewrite instead of delete: `pairing_codes.created_by` and `groups.created_by` move to the heir (the owner), like the ACL move. Not touched on purpose, as people.md already says: budget ledger rows (`eh_budget_*`), audit rows and ACL moves. `keep` first writes a `data.json` (tasks and reviews of the person) into the removed folder next to `conversation.jsonl`, then deletes the rows in one `BEGIN IMMEDIATE`; `export` lists the same rows; `purge` has nothing left to delete in the database. A worker running at removal is stopped (`tasks.stop` with reason `person-removed`) before `keep`, so nothing is written afterwards; the reconcile at boot lists existing people only and cannot do it. Plugin tables are the plugins' own registrations (P26.3.2 contract). | `apps/core/src/modules/people/removal-core.ts` (+ test), `apps/core/src/modules/people/removed.ts`, `apps/core/src/modules/cortex/` (stop of a person's workers), `packages/db/src/repos/tasks.ts` (`deleteBySessionPrefix`), `packages/db/src/repos/reviews.ts` (`deleteByRequester`), `packages/db/src/repos/pairing.ts`, `packages/db/src/eh/inbox.ts`, `schedules.ts`, `stream-log.ts`, `activity-store.ts`, `apps/core/src/compose.ts` (registration) | people.md (new table "Where a person's data lives": table, key, kept or deleted or moved), db.md Retention inventory (P26.1.5 rows), SECURITY.md:102-104 | `removal-core.test.ts`: seed rows for persons A and B in every table above; remove A; a SQL scan finds no row of A in them and every row of B intact; `data.json` and the export hold A's tasks and reviews; a running worker of A is stopped first; a schema test lists every table that has a `session_id`, `requester`, `parent_session_id` or `created_by` column and fails when it is neither registered nor on the kept list | `SELECT ... FROM tasks` finds nothing of a removed person |

Phase gate: `bun run check` and `bun run smoke`.

### Phase 4 — Node tokens and rate limit

Goal: a node token is rotated after 30 days and a chatty node cannot flood the core.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P26.4.1 | Rate limit | `apps/core/src/modules/nodes/gateway.ts`, `gateway.test.ts` | nodes.md (Invariants, new "Limits"), SECURITY.md ("a paired node is trusted": drop "without a rate limit") | 201st message in a window is dropped; one audit row per 5 min; 30 s overload closes with 4008; normal heartbeat and progress traffic is untouched | tests pass |
| P26.4.2 | Rotation: contracts and store (adds the table "protocol version, plan, what it adds" to `docs/specs/node.md`: 1 = base, 2 = rotate and rate limit (this plan), 3 = drivers (P31)) | `packages/contracts/src/node-protocol.ts` (+ `node-protocol.test.ts`), `packages/db/src/schema/nodes.ts` (the file that holds `nodes`), generated `packages/db/drizzle/<next>_*.sql`, `packages/db/src/repos/nodes.ts`, `repos.test.ts`, `migration-<n>.test.ts`, `scripts/exports.snapshot.json` (`--write`) | nodes.md, node.md (protocol version table), db.md | old rows get `token_issued_at = created_at`; `findByTokenHash` matches next hash; `revoke` scrambles both; v1 nodes parse unchanged | tests pass |
| P26.4.3 | Rotation: gateway and node daemon | `apps/core/src/modules/nodes/gateway.ts`, `apps/node/src/connection.ts`, `apps/node/src/run.ts`, `apps/node/src/platform/config.ts` (atomic write), tests `gateway.test.ts`, `apps/node/src/run.test.ts` | nodes.md, node.md | token older than 30 days: after welcome the node gets `rotate`, writes the file (mode 0600), reconnects with the new token; lost ack still completes at the next connect; old token no longer opens a socket after the ack; revoked node is never rotated; v1 node untouched | tests pass |
| P26.4.4 | Smoke and docs | `scripts/smoke/node-limits.ts` (hooked from `scripts/smoke.ts`; rotate with a short core option `KEITH_NODE_ROTATE_MS`, read only in `apps/core/src/platform/config.ts` and mapped to `CoreTiming.nodeTokenRotateMs`), `docs/ARCHITECTURE.md` (Nodes row), `docs/specs/README.md` list, `docs/manual-testing.md` (the scenarios of "Owner to run"), P22 roadmap row | nodes.md | smoke: node reconnects after rotation | smoke passes |

Phase gate: `bun run check` and `bun run smoke`.

### Phase 5 — Retention and eval hygiene

Goal: no table grows without a number, and the eval tool treats real data as carefully as the core does.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P26.5.1 | **FD11-03: the retention tick.** `pruneRetention(sqlite, now, audit)` runs in the prune tick (after the removed-person purge) and deletes by the table in Design ("Retention"): revoked, rotated, evicted or expired `credentials` and `client_tokens` 90 days after the end; finished `tasks` 90 days; dead `eh_inbox` rows and their keys 30 days; closed `eh_budget_reservation` rows 7 days; the 1 day value for expired `pairing_codes` (`CoreTiming.retention.pairingCodes`) is only set here, the prune-tick call of `pairing.purgeExpired` is wired by P24.2.3 (which reads it); decided `owner_reviews` stay with P24.6.2 (30 days). A live credential is never deleted. One audit row `data.pruned { table, count }` per table per tick when the count is above zero (no ids, no text). Tests shorten the numbers through `CoreTiming.retention`; the owner has no setting for them. | `apps/core/src/platform/retention.ts` (+ test), `apps/core/src/compose.ts` (prune tick), `packages/db/src/repos/credentials.ts`, `tokens.ts`, `tasks.ts`, `packages/db/src/eh/inbox.ts`, `budget-ledger.ts`, `packages/contracts/src/audit.ts` (kind `data.pruned`), `apps/core/src/modules/audit/mine.ts` | db.md "Retention" (every row: table, number, pruned by; the P26.1.5 test requires it), SECURITY.md (what Keith keeps and for how long) | `retention.test.ts`: rows older than the number go, younger rows and every live credential stay, `data.pruned` is written once per table with the count; `eh_budget_record` is untouched; the P26.1.5 inventory test passes | a year of use leaves no revoked sign-in, finished task or dead letter older than its number |
| P26.5.2 | **FD11-11 and the rest of FD11-09.** The prune tick also calls the stream log's `sweep()` (a new `purgeExpired()` on the adapter), so the last turn's chunks of a quiet household do not outlive the 10 minutes; the db.md sentence says so (it said "purged lazily" until Nov 10). Reword the first-line comment of `packages/eh-ext/src/index.ts` ("Empty until M1") to say the package exports nothing and where the adapters live. | `packages/db/src/eh/stream-log.ts`, `packages/db/src/eh/conformance.test.ts` (stream log case), `apps/core/src/compose.ts` (prune tick), `packages/eh-ext/src/index.ts` (comment only) | db.md (stream log retention), thalamus.md (prune tick list), logging.md unchanged | conformance: an expired log is gone from `eh_stream_chunks` after `purgeExpired()` without any read or append; the tick calls it | no chunk of an expired log survives a prune tick |
| P26.5.3 | **FD11-07: `eval:news` with real data.** `--data` copies the database with `VACUUM INTO` from a read-only connection (a consistent snapshot while the core runs), then copies only `secret.key`, `workspace/` and `memory/` (never `keith.db-wal`, `-shm`, `core.sock`, `core.lock`, `backups/`, `exports/`, `logs/`); the temp folder is removed on `SIGINT`, `SIGTERM` and `exit` as well as in `finally`; reports and `result.json` are written 0600 into a 0700 folder (also with `--out`); the report redactor is the logger's `redactString` (exported from `platform/logger.ts`), so the `keith_` token and JWT patterns are covered; the newest 20 report folders are kept, older ones removed. | `apps/core/evals/news/cli.ts:56-97`, `apps/core/evals/news/report.ts:31-43,98-109`, `apps/core/src/platform/logger.ts` (export), `apps/core/evals/news/cli.test.ts` | evals.md:46-70 (copy rules, modes, redaction, report retention) | `cli.test.ts`: the copy opens and equals a database that has an open WAL writer; a `SIGINT` during a run leaves no temp folder; report modes are 0600; a `keith_`-prefixed token in a transcript is redacted; the 21st report folder removes the oldest | the eval never leaves real data in the temp folder or a readable report |

Phase gate: `bun run check`.

## Exit criteria

- [x] No "Changes in P26" marker is left in `docs/specs`, `SECURITY.md` or `packages/db/AGENTS.md` (`grep -rn "Changes in P2" docs SECURITY.md README.md`, lines that name P26): the step that lands the code rewrites the sentence in present tense.
- [x] The removal hook registry has a registered part per data owner so far, and a test proves a registered test module is kept, exported and purged.
- [x] Specs updated in the same commits: `db.md`, `thalamus.md`, `core-cli.md` (including "Upgrading and rolling back"), `backup.md` (new), `people.md`, `permissions.md`, `nodes.md`, `node.md`, `plugins/reminders.md`, `hippocampus.md`, `cortex.md`, `docs/deploy/README.md`, `SECURITY.md`, `packages/db/AGENTS.md`.
- [x] Contracts: `people.ts`, `acl-admin.ts`, `node-protocol.ts`, `admin.ts`; generated migrations not hand-edited; `scripts/exports.snapshot.json` regenerated.
- [x] No code path migrates an existing database without a verified snapshot.
- [x] Round trip backup, wipe, restore, doctor works (`restore.test.ts`; the smoke has no backup block, see Not verified).
- [x] Removed person: data kept 30 days, exportable by the owner only, then purged; `left` appears nowhere in code.
- [x] Every table in `schema/` has a retention row with a number or a reason (P26.1.5 test); a database newer than the code is refused; `secureDataDir` touches only the files Keith owns.
- [x] `bun run check` and `bun run smoke` pass.
- [ ] Manual scenarios below run by the owner (not done: see Not verified).
- [x] `docs/ARCHITECTURE.md` and the P22 roadmap row updated; doc gaps 4, 6, 9, 13 marked closed in the review index by the orchestrator.

## Risks and mitigations

- **A backup that is itself a leak.** The archive holds `secret.key` and every conversation. Mode 0600, listed in SECURITY.md, `backup` prints a warning when it includes the key.
- **Restore over live data.** Refused without `--force`; with it, the old files are moved aside, never deleted.
- **Removal now moves files before deleting the row.** If a move fails nothing is deleted; the person stays and the error names the path. The move is a rename inside one data folder (same filesystem).
- **Rotation lockout.** The next hash is accepted until the node proves it saved the new token; a node that crashed after writing the file still connects. A node whose file was lost needs a new join (unchanged).
- **Protocol bump.** v2 is additive, `MIN_PROTOCOL` stays 1; old nodes work and are never rotated.
- **Snapshot disk use.** Five snapshots of a small SQLite file; the retention is in the spec.
- **`Bun.Archive` may lack a feature** (modes, symlinks). Step P26.2.1 verifies; fallback `tar` is allowed by rule 11 with its reason in ADR-0006.

## Traceability

| Id | Closed by step |
| --- | --- |
| F-011 (silent migration, no backup) | P26.1.2, P26.1.3 |
| C-13 (where migrations run) | P26.1.2 (docs), P26.1.3 |
| F-027 (`db migrate` without the lock) | P26.1.3 |
| F-026 (stale lock takeover) | P26.1.1 |
| F-051 (`left`, "or deletes it") | P26.3.1, P26.3.2 |
| Doc gap 4 (removed person data) | P26.3.2, P26.3.3 |
| Doc gap 6 (`can_login` writer) | P26.3.4 |
| Doc gap 9 (node token rotation, rate limit) | P26.4.1, P26.4.2, P26.4.3 |
| Doc gap 13 (backup, restore, upgrade order) | P26.2.1 to P26.2.4 |
| ADR-0027 §3 | P26.1.2, P26.1.3 |
| Upgrade drill on a seeded database (review R10; P16/P11 not-verified) | P26.1.4 |
| Retention inventory (review R11) | P26.1.5 |
| Removal hook registry (extension point of ADR-0027 §26 for P25, P27, P28, P30) | P26.3.2 |
| ADR-0027 §25 | P26.2.2, P26.2.3, P26.2.4 |
| ADR-0027 §26 | P26.3.1 to P26.3.3 |
| ADR-0027 §27 (owner only) | P26.3.4 |
| ADR-0027 §28 | P26.4.1 to P26.4.3 |
| FD11-01 (database newer than the code), FD11-10 (behind, ahead, unreadable told apart) | P26.1.6 |
| FD11-02 (`secureDataDir` walks the workspace) | P26.1.7 |
| FD11-04 (removed person: every per-person table) | P26.3.5 (registry from P26.3.2) |
| FD11-03 (tables with no retention; numbers in db.md) | P26.5.1 (inventory P26.1.5) |
| FD11-11 (stream log purge is lazy) | P26.5.2 |
| FD11-09 (doc drift: lock order, eh-ext, logging retry) | fixed in docs on Nov 10; comment of `eh-ext/src/index.ts` in P26.5.2 |
| FD11-07 (`eval:news` real data handling) | P26.5.3 |

## Owner to run

1. Upgrade drill: `rm -rf .data/test`, check out the commit before this plan, `bun run manual:setup`, check out this plan, `bun run manual:core`. Expected: it prints the
   migrations it applied and `backups/keith-<timestamp>.db`; `ls .data/test/backups` shows the file.
2. `KEITH_HOME=.data/test keith-core db migrate` while the core runs. Expected: refused (core running or locked).
3. `keith-core backup`, then stop the core, `rm .data/test/keith.db`, `keith-core restore <archive> --force`, `keith-core start`. Expected: the people, notes and chats are back.
4. Add a member, give them a memory note and a workspace file, `keith-core people export <member>`, then `keith-core people remove <member>`. Expected: the tar lists the three parts;
   `.data/test/workspace/keith/removed/<id>/` exists with `manifest.json`; the member cannot sign in; `doctor` lists the purge date. Re-run with a short `removedKeepMs` in a test, or move `purgeAt` back by hand in `manifest.json`, restart: the folder is gone.
5. `keith-core people login <member> off`, try to sign in as them: the uniform failure; `on`: it works. A member with `people.manage` cannot run `people login` at all (owner only), and nobody can switch the owner off.
6. Join a node (`keith-node join ...`), edit its `token_issued_at` older than 30 days in the database, reconnect: `node.json` has a new token, the node stays online; the old token is refused.
7. Rollback (FD11-01): after a start on this build, check out the previous commit and `keith-core start`: it refuses with "migrated by a newer Keith" and changes nothing; `keith-core restore` of the snapshot made at the upgrade brings it back.
8. Modes (FD11-02): `chmod 755 .data/test/workspace/people/<id>/run.sh`, restart the core: the mode is still 755; `chmod 644 .data/test/secret.key`, restart: it is 600 again.
9. Retention (FD11-03): revoke a device, move the clock or the row's `revoked_at` back 91 days in a test database, restart: the row is gone and `keith-core audit` shows `data.pruned` with a count.
10. Removal (FD11-04): remove a member who has a finished task and a pending review: `sqlite3 .data/test/keith.db "select count(*) from tasks where parent_session_id like 'front:<id>%'"` prints 0 and the export holds `data.json`.

## Gate evidence (Nov 10, 2026)

- Commits e4832ea (atomic lock) to the final regenerate of the exports snapshot; `bun run check`: 2903 pass, 0 fail, check-imports, check-size, check-exports (19 entries) ok. `bun run smoke`: SMOKE PASS, 59 steps (block `scripts/smoke/node-limits.ts`).
- Deviations: archive uses the system `tar` (Bun.Archive writes every file 0644; reason recorded in ADR-0006); the node invoke message now carries `v: 2` (v1 daemons accept it: only `v < MIN_PROTOCOL` is refused) and the M3 test follows `PROTOCOL_VERSION`; token rotation reconnects once per 30 days right after the welcome; workspace path helpers moved to `platform/workspace-paths.ts` to break an import cycle (people to cortex); `@keith/db/testing` is a test-only subpath (apps/core has no drizzle-orm); the smoke proves a rotated node works by the approval audit row naming the node and command plus the node staying online (the command output sits in a worker session the smoke cannot read back).
- Not done: the doctor note for a node that last connected with protocol 1 (needs a persisted protocol column, so a migration outside the step).

## Not verified

- The manual scenarios of "Owner to run" (real terminal, real data folder): backup, restore on a copy, remove and export a person, node rotation on a real node.
- The upgrade drill ran on a synthetic database, not on a copy of the owner's real database (P32 phase 3).
- `smoke` has no backup and restore block; the round trip is a unit/e2e test.
- Rotation was tested with a short `KEITH_NODE_ROTATE_MS`, not across a real 30 days.
