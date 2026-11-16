# Database

Code: `packages/db` (`src/schema/{eh,settings,identity,audit,tasks,nodes,acl,plugins}.ts` re-exported by `src/schema.ts`, `src/connection.ts`, `src/eh/*`, `src/repos/*`, generated
`drizzle/`). Only `apps/core` imports `@keith/db`.

Generic adapters come from the `eharness/sqlite` subpath (shipped in eharness 0.11.0; the Keith-local twin
`packages/eh-sqlite` is deleted, ADR-0012), with its `eharness/sqlite/bun` driver. Its tables carry the `eh_` prefix.
`packages/db` builds `sqliteMessages`, `sqliteState`, `sqliteInbox`, `sqliteLock` and `sqliteBudgetLedger` on it (one shared
driver per bun:sqlite handle, `src/eh/driver.ts`); the other adapters stay Keith's own, see "Adoption of eharness/sqlite".
Only `packages/db` imports the subpaths (check-imports rule `eh-sqlite-only-from-db`).

## Purpose

One SQLite file (`<KEITH_DATA_DIR>/keith.db`; the folder defaults to `$KEITH_HOME/data`, else `<repo>/data`) for eharness storage, provider connections and
Keith's own data. It is created 0600 (`openDatabase` makes the empty file first; `-wal` and `-shm`
inherit it). The data folder is 0700 and every file Keith owns at its top level is 0600: core, `db:migrate` and `token:reset`
set `umask(0o077)`, and `secureDataDir` (`platform/db.ts`) tightens an older install at boot. The entries it owns are one
constant, `OWNED_ENTRIES`: `keith.db`, `keith.db-wal`, `keith.db-shm`, `secret.key`, `instance-id`, `core.lock` (0600), and the
folders `logs/`, `backups/`, `exports/` (0700, their files 0600, one level down). Nothing else is walked: `workspace/` and
`memory/` keep the modes their owners created under umask 077, so an executable a worker built stays executable. An entry
that cannot be changed is a warning (returned to the caller, logged by `runCore`), never a throw. `doctor` reads the same list.
Test: `platform/db.test.ts`.

## Tables (`src/schema/`)

| Table | Holds |
| --- | --- |
| `eh_messages` | Session messages (`session_id`, UUIDv7 `id`, role, parts, metadata) |
| `eh_state` | Session state with `rev` (optimistic concurrency) |
| `eh_locks` | Turn lock with a lease (`owner`, `until`); a crashed holder expires |
| `eh_inbox`, `eh_inbox_keys` | Inbox items with claims, retries, dead letters, and dedupe keys |
| `config_profiles` | Profiles keyed by (`kind`, `id`): provider connections now, other kinds later. `settings` JSON holds sealed secrets |
| `catalog_cache` | Cached public model catalogs |
| `dream_settings` | Per-person memory dreaming mode (`person_id` PK, `mode` `off`, `propose`, `auto`, `updated_at`, `updated_by`); no foreign key; ADR-0031 §5, `dreaming.md`; migration 0022, `schema/dreaming.ts` |
| `dream_runs` | Dreaming runs (`id` UUIDv7, `person_id`, `trigger`, `mode`, `status`, `reason`, `started_at`, `ended_at`, JSON `counts` and `cursor`, `undo_until`); ADR-0031 §8, `dreaming.md`; migration 0022, `schema/dreaming.ts` |
| `llm_sessions` | One row per session of the activity logs (ADR-0032 §3, `activity-logs.md`): `id` (PK, the session id), `kind` CHECK (the registry's kinds), `person_id`, `room_id`, `app`, `first_at`, `last_at`, `calls`, `cost_micro`, `primary_model`, `primary_provider`, `bodies_off`; no foreign key; migration 0023, `schema/activity-logs.ts` |
| `llm_calls` | One row per provider call (figures only, ADR-0032 §3): `id` (PK), `session_id`, `call_kind`, `trigger` (nullable), `started_at`, `duration_ms`, `status`, `model_id`, `provider`, token counts, `cost_micro` (nullable), `body_state` CHECK (`stored`, `truncated`, `purged`, `off`), `speaker_id`; no foreign key; migration 0023, `schema/activity-logs.ts` |
| `llm_bodies` | The gzip blobs (`request`, `response`, `output`) of a call that kept its bodies, keyed by `call_id` (PK); purged by retention without touching the figures; migration 0023, `schema/activity-logs.ts` |
| `settings` | JSON key-value (`model.front`, `model.cortex`) |
| `people` | Who uses Keith (`people.md`): `id` (PK; UUIDv7, or `owner` for the first owner), `name` (display), `role` (`owner`, `member`; unique partial index `people_one_owner` allows one owner), `created_at`, `username` (unique, nullable until the backfill), `status` (`active`, `suspended`, `left`; default `active`), `nickname`, `notes`, JSON `fields` and `divisions`, `member_id`, `created_by`, `updated_at`, `can_login` (integer, default 1: a User that may sign in; 0 = directory entry only; P14) |
| `person_accounts` | Platform accounts of a person: `id`, `person_id` (FK), `platform`, `native_id`, `label`, `status` (`linked`, `revoked`), `linked_via`, `linked_by`, `linked_at`, `revoked_at`; unique `(platform, native_id)` among `linked` rows; index `(person_id)` |
| `person_pair_codes` | Pairing codes that link a platform account: `hash` (PK, SHA-256), `person_id` (FK), `expires_at`, `used_at`, `created_at`; index `(person_id, expires_at)` |
| `client_tokens` | Legacy token SHA-256 hashes, label, `revoked_at` (still accepted; `auth.md`) |
| `credentials` | Session credentials (`keith_s_<id>_<secret>`): `id` (PK, 12 hex), `person_id` (FK `people`), `kind` (`device`, `token`), `label`, `secret_hash` (SHA-256 of the secret), `created_at`, `last_seen_at`, `last_ip`, `revoked_at`, `elevated_until` (end of the step-up window, ms, nullable), and since P14 (migration 0008, all additive): `methods` (JSON array of the methods that made the session; null on an older row, read as `['legacy']`), `assurance` (0 possession, 1 PIN, 2 password; default 0), `idle_expires_at`, `absolute_expires_at` (ms, null = no limit), `user_agent`, `revoked_reason`; index `(person_id)` |
| `person_identifiers` | Admin-set sign-in aliases (P14): `person_id` (FK `people`), `kind` (`email`, `phone`), `value_norm` (PK: the normalised value, unique across people), `created_by`, `created_at`; index `(person_id)`. Nothing is verified: there is no mail or SMS (`people.md`) |
| `person_secrets` | Password and PIN of a person: `person_id` (FK `people`), `kind` (`password`, `pin`), `hash` (argon2id PHC string), `updated_at`; PK `(person_id, kind)`. Kept apart from `credentials`: those are random 256-bit bearers hashed with SHA-256, these are human secrets hashed slowly (`auth.md`) |
| `auth_attempts` | Failed password and PIN attempts: `subject` (a person id, or `u:<hash>` for a username that does not exist), `ip` (the TCP peer, or `*` for the person-wide counter), `failures`, `last_failure_at`, `locked_at` (only on the `*` row of a member); PK `(subject, ip)`. Persists, so throttling survives a restart |
| `device_requests` | Pending device logins: `id` (PK), `code_hash` (unique, SHA-256 of the code), `poll_hash`, `label`, `ip`, `status` (`pending`, `approved`, `denied`), `credential_id`, `secret_hash` (of the future credential secret), `created_at`, `expires_at`; index `(ip, expires_at)`. Rows are deleted when consumed or long expired |
| `audit_events` | Append-only security log: `id` (AUTOINCREMENT), `at`, `kind`, `actor`, `via` (`local`, `tcp`, `offline`), JSON `detail` (no secrets); index `(at)`. Pruned by the retention setting `audit.retentionDays` (`auth.md`, "Audit"), nothing else deletes |
| `groups` | ACL groups (P15, `acl.md`): `id` (PK), `name` (unique), `created_by`, `created_at`. Flat; created by the owner |
| `group_members` | `group_id` (FK `groups`, cascade), `person_id` (no foreign key: removing a person is never blocked), `added_by`, `added_at`; PK `(group_id, person_id)`; index `(person_id)` |
| `resources` | The access data of shareable things (content stays in the plugin's table): `kind`, `id` (PK together), `owner_id`, `group_id` (the team, nullable; no foreign key, a group in use is refused at delete by the store), `mode` (nine bits, 0..511), `created_at`, `updated_at`; indexes `(owner_id, kind)` and `(group_id)` |
| `resource_acl` | Entries of a resource: `kind`, `id` (FK `resources`, cascade), `subject_kind` (`user`, `group`, `users`, `public`), `subject_id` (`''` for the last two), `bits` (1..7), `effect` (`allow`, `deny`), `created_by`, `created_at`; PK `(kind, id, subject_kind, subject_id, effect)`; index `(subject_kind, subject_id)` |
| `events` | Activity feed log (`seq` AUTOINCREMENT, `type`, `agent_id`, `session_id`, JSON `payload`, `created_at`); indexes `(type, seq)` and `(session_id, seq)` |
| `tasks` | Task board: `id` = child session id, `parent_session_id`, `agent`, `description`, `status`, `steps`, `summary`, `error`, timestamps; index `(parent_session_id, updated_at)` |
| `nodes` | Peripheral nodes: `id` (UUIDv7), `name` (unique among non-revoked, enforced in the repo), `os`, `arch`, `version`, JSON `manifest`, `allow_shell`, `token_hash` (unique, SHA-256), `status` (online, offline, revoked), `last_seen_at`, `created_at`, `revoked_at`; index `(name)`. Since P26 (migrations 0013 and 0014, additive): `token_next_hash` (SHA-256 of the token a rotation hands out, null when none is pending) and `token_issued_at` (when `token_hash` was issued: join or last rotation; 0014 sets it to `created_at` on every older row) |
| `eh_stream_log`, `eh_stream_chunks` | Stream log of a turn (eharness spec 04 §6.2): head (`status`, `length`, `ttl_ms`, `expires_at`) keyed by (`session_id`, `turn_id`), chunks keyed by (`session_id`, `turn_id`, `idx`); the column is `idx`, the package calls it `seq` |
| `eh_budget_scope`, `eh_budget_reservation`, `eh_budget_record` | Budget ledger: limit and spending per (`scope`, `period_start` = UTC month), reservations (`open` / `committed` / `released`, JSON `scopes`, `expires_at`), idempotency keys of `record`. Amounts are decimal text |
| `eh_schedules` | Schedules of `eharness/scheduler` (P16 step 9, migration 0012): `id` (PK), `session_id`, `state`, `next_fire_at`, `claimed_until`, `version`, `doc` (the schedule as JSON); indexes `(state, next_fire_at)` and `(session_id, id)`. Created by Keith's own migration (the package's `migrate` is never run); the columns and indexes equal `schemaSql` (`eh/schedules.test.ts`). The core schedules plugins' timers here (`plugins.md`, "Schedules") |
| `owner_reviews` | Operations plugins hold for the owner (P16 step 7, migration 0011): `id` (PK, UUIDv7), `requester` (person id, no foreign key), `plugin`, `operation`, `payload` (validated input, JSON), `status` (`pending`, `approved`, `denied`, `expired`), `reason`, `outcome` (`ok` or `error:<code>`), `created_at`, `expires_at`, `decided_at`, `decided_by`; indexes `(status, created_at)` and `(requester, status)` |
| `plugin_kv` | The key-value store of plugins (`ctx.kv`, P16 step 5, migration 0010): `plugin`, `key`, `value` (JSON text), `updated_at`; PK `(plugin, key)`. One namespace per plugin id; the host caps a key at 128 characters, a value at 64 KB and a plugin at 10000 keys |
| `pairing_codes` | One-time node pairing codes: `hash` (PK), `created_by`, `expires_at`, `used_at`, `used_by_node`, `created_at`; index `(expires_at)` |
| `deliveries` | The delivery service's runs (`delivery.md`, migration 0015, P25.1.2): `id` (PK, the run id), `source`, `recipient_id`, `bill_to`, `name`, `needs` and `data` (JSON), `text` (blanked when delivered), the failure notice (`report_to`, `report_text`, `report_key`), `status` (`pending`, `held`, `delivered`, `failed`; `held` is kept for the return digest, no migration: a text column), `reason`, `attempts`, `next_attempt_at`, `route`, `created_at`, `updated_at`; index `(status, next_attempt_at)` |
| `clients` | A person's clients (`parietal.md`, migration 0016, P27.1.2; `schema/presence.ts`): `id` (PK, the uuid the client keeps), `person_id`, `kind` (`tui`, `web`, `mobile`), `label`, `capabilities` (JSON list), `version`, `first_seen_at`, `last_seen_at`, `last_active_at` (null until one input), `environment` (JSON of the client's environment, null when not reported; migration 0024), `network` (`local-socket`, `loopback`, `lan`, `tailscale`, `public`, null when unknown; migration 0024); index `(person_id)`. At most 20 rows per person (the repo refuses the 21st) |
| `presence_signals` | Facts that presence is computed from (`parietal.md`, migration 0016): `id` (PK, UUIDv7), `person_id`, `client_id` (null for a person-level signal), `type` (`activity`, `client.active`, `client.connected`, `client.disconnected`, `node.event`, `device.location`), `at`, `detail` (JSON of at most 200 bytes, never message text); index `(person_id, at)` |
| `presence_status` | The stated status: `person_id` (PK), `state` (the kind, `busy` or `out`; `busy` is the first overlay source, `out` makes presence `away`), `note`, `from` (start, epoch ms, null: from `set_at`; migration 0026), `until` (null: no end), `set_at`. One row per person; `/free` deletes it |
| `push_subscriptions` | Web Push subscriptions (`push.md`, migration 0027; `schema/presence.ts`): `id` (PK, UUID), `person_id`, `endpoint` (unique; a secret of the subscription, never read back by a client), `p256dh`, `auth` (the browser's keys, base64url), `client_id` (the presence client of the browser, null when not sent), `label`, `user_agent`, `created_at`, `last_success_at` (null until one accepted push), `failure_count` (failures in a row; the row is dropped at 5 or on a 404/410); index `(person_id)`. At most 10 rows per person (the service refuses the 11th) |
| `presence_disclosure` | What a person shares, per audience: `(person_id, audience)` (PK), `level` (`none`, `state`, `detail`) |
| `protocols` | Protocol heads (`hypothalamus.md`, migration 0017, P28.1.4): `id` (PK), `owner` (`keith` or a person id), `name`, `built_in` (null or a built-in name), `enabled`, `paused_until`, `version` (current, moved by compare-and-set), `created_by`, `created_at`, `updated_at`; unique `(owner, name)` and `(owner, built_in)` |
| `protocol_versions` | Every saved version of a protocol: `protocol_id` (FK `protocols`, cascade), `version`, `definition` (JSON, `ProtocolDefinitionSchema`), `approvals` (JSON list: step id, SHA-256 of the input, approver, time), `saved_by`, `saved_at`; PK `(protocol_id, version)` |
| `protocol_runs` | Runs of protocols (migration 0017): `id` (PK, UUIDv7, the delivery key root), `protocol_id`, `version`, `person`, `trigger_ref`, `status`, `step`, `visits` and `answers` (JSON), `wake_at` (absolute ms, null when nothing is due), `cost_usd`, `started_at`, `updated_at`, `ended_at`; unique `(protocol_id, trigger_ref)` (the exactly-once guard of a trigger), indexes `(status, wake_at)` and `(person, started_at)` |
| `protocol_run_steps` | History of a run, one row per step execution: `n` (PK, AUTOINCREMENT), `run_id` (FK `protocol_runs`, cascade), `step`, `kind`, `outcome` (`started` first, then `ok`, `answered:<x>`, `timeout`, `refused:<r>`, `failed:<r>`, `unknown`), `at`, `detail` (JSON of ids, lengths and reasons, never message text); index `(run_id, n)` |
| `protocol_proposals` | Protocols Keith suggests (data, never a protocol): `id` (PK), `person`, `definition` (JSON, `ProposalDefinitionSchema`), `reason`, `source` (JSON of session and message ids), `status` (`pending`, `confirmed`, `dismissed`, `expired`), `created_at`, `expires_at` (7 days after creation); indexes `(person, status)` and `(status, expires_at)` |
| `agenda_items` | The personal agenda (ADR-0025 §2, migration 0017): `id` (PK), `person` (no foreign key), `what`, `starts_at`, `ends_at` (null allowed), `place`, `status` (`tentative`, `confirmed`, `done`, `cancelled`, `dismissed`), `source_session`, `source_message`, `created_at`, `updated_at`; index `(person, starts_at)` |
| `succession_state` | The one row of the owner-absence run (`succession.md`, migration 0018, P29.1.4): `id` (always 1, CHECK), `state` (`idle`, `check-in`, `grace`, `claimable`, `claimed`; CHECK), `run_id` (the P28 run), `heir` (a person id, no foreign key), `started_at`, `grace_started_at`, `claimable_at`, `last_sign_at`, `updated_at`. The claim reads it inside its transaction |
| `rooms` | Shared rooms (`corpus-callosum.md`, migration 0019, P30.1.3): `id` (PK, UUIDv7), `name`, `initiator` (a person id, no foreign key), `state` (`open`, `active`, `ended`; CHECK), `answer_mode` (`addressed` or `every`), `window_minutes` (30), `window_events` (200), `transport` (`text`), `generation` (moved only on a session rollover), `created_at`, `started_at`, `ended_at`, `ended_by`, `end_reason` |
| `room_members` | Members of a room (migration 0019): `room_id` (FK `rooms`, cascade) and `person_id` (PK together), `status` (`invited`, `active`, `declined`, `left`, `removed`, `expired`; CHECK), `invited_by`, `invited_at`, `joined_at`, `left_at` (the last moment the member may read the transcript), `leave_reason`; index `(person_id, status)`; partial unique index `room_members_one_active` on `person_id` where `status = 'active'`, so a person is active in one room at a time |
| `room_events` | The transcript of a room (migration 0019): `seq` (PK, AUTOINCREMENT), `room_id` (FK `rooms`, cascade), `at`, `kind` (`say`, `keith`, `join`, `leave`, `remove`, `end`, `system`, `handoff`, `post`; CHECK), `speaker` (a person id, `keith` or null), `text` (at most 2000 characters), `data` (JSON, never message text of another room); indexes `(room_id, seq)` and `(room_id, at)` |
| `room_requests` | Confirmations a human must give, never applied by a model (migration 0019): `id` (PK), `room_id` (FK `rooms`, cascade), `person` (who confirms), `kind` (`remove`, `end`, `post`; CHECK), `payload` (JSON), `status` (`pending`, `confirmed`, `refused`, `expired`; CHECK), `created_at`, `expires_at` (10 minutes after creation); indexes `(person, status)` and `(status, expires_at)` |
| `persona` | The current persona, one row (migration 0020, `schema/persona.ts`, P33.2.1): `id` (CHECK `keith`), `version` (moved by one with every write), `template_id` (`butler`, `friend`, `professional` or `custom`; CHECK), `body` (JSON of `PersonaBodySchema`), `updated_at`, `updated_by` (a person id, no foreign key); the write and its `persona_versions` row are one transaction |
| `persona_versions` | The history of the persona, never pruned (migration 0020): `id` (PK, UUIDv7), `version` (unique: a second row with the same version is refused), `template_id`, `body` (JSON), `reason` (`template`, `edit` or `restore`; CHECK), `changed_by`, `changed_at`, `note` (at most 200 characters) |
| `person_style` | The style a person set for Keith's replies (migration 0020, ADR-0029 §3): `person_id` (PK, FK `people`, no cascade: the removal registry deletes it), `address` (null: the name in the profile; at most 40 characters), `language` (`auto` or a tag from the fixed list; CHECK), `brevity` (`short`, `normal`, `full`; CHECK), `formality` (`casual`, `neutral`, `formal`; CHECK), `gentle_topics` (JSON array, at most 5 values of the closed list), `updated_at`, `updated_by`. An absent row means the defaults |
| `front_generations` | The current front generation of each person who has reset their front context (migration 0021, `schema/front-generations.ts`, P34.2.1): `person_id` (PK, no foreign key), `generation` (an absent row means 0), `updated_at`; one row per person, written by the first reset and moved by one with each later reset (`BEGIN IMMEDIATE`) |
| `workspaces` | The workspace of each person (migration 0028, `schema/workspace.ts`, ADR-0037, `workspace.md`): `person_id` (PK, no foreign key), `version` (an absent row means 0), `doc` (JSON of `WorkspaceDoc`, validated by the core on write and read), `updated_at`; written by compare and set on `version` |
| `llm_sessions` | The model-call log, one row per session (P36, ADR-0032 §3, `activity-logs.md`; the migration is the next free number, additive): `id` (PK, the session id), `kind` (`chat`, `task`, `room`, `guest`, `dream`, `aux`; CHECK), `person_id`, `room_id` (nullable, no foreign key), `app`, `first_at`, `last_at`, `calls`, `cost_micro`, `primary_model`, `primary_provider`, `bodies_off`; indexed by person, room and last time |
| `llm_calls` | One row per provider call (P36): `id` (PK, UUIDv7), `session_id`, `call_kind` (`step`, `compaction`, `flush`, `other`, `embedding`; CHECK), `trigger` (the turn kind, `none` without a turn; CHECK), times, duration, first chunk, `status` (`ok`, `error`, `aborted`; CHECK), finish reason, model, provider, upstream provider, token counts, `cost_micro`, `cost_source`, fallbacks, error name and message, request and response sizes, `body_state` (`stored`, `truncated`, `off`, `purged`; CHECK), `speaker_id` (rooms); no foreign key |
| `llm_bodies` | The gzip blobs of one call (P36): `call_id` (PK), `request`, `response`, `output`; kept apart from `llm_calls` so retention can purge bodies without touching the figures; no foreign key |

## Retention

Every table of `src/schema/` has one row here (the test `platform/retention-inventory.test.ts` fails when a table has none, or a row names no table). A row
gives the number, or the reason nothing is pruned. The prune tick (`compose.ts`) runs the removed-person purge first, then the retention of this table
(`platform/retention.ts`, P26.5.1); each deletion is audited as `data.pruned { table, count }`, one row per table per tick, with no id and no text. A live
credential is never deleted. The owner has no setting for these numbers; tests shorten them through `CoreTiming.retention`.

| Table | Rows deleted | After |
| --- | --- | --- |
| `credentials`, `client_tokens` | revoked, rotated, evicted or expired (never a live one); a credential ends at the earliest of its revoke time and its idle or absolute expiry | 90 days |
| `tasks` | finished (`done`, `failed`, `stopped`, `timed_out`, `interrupted`) | 90 days |
| `eh_inbox`, `eh_inbox_keys` | dead letters | 30 days |
| `eh_budget_reservation` | closed (committed or released); the table has no close time, so 7 days after `expires_at` | 7 days |
| `pairing_codes` | expired: pruned by P24.2.3 (`purgeExpired` in the prune tick); this table holds the number | 1 day |
| `owner_reviews` | decided | 30 days (P24.6.2) |
| `deliveries` | delivered or failed (`updated_at` is the end); a pending row is never pruned | 7 days (`delivery.md`, P25.1.2) |
| `presence_signals` | every signal older than its time (`at`) | 7 days (`parietal.md`, P27.1.2) |
| `clients` | a client not seen since `last_seen_at` (its heartbeat stops after the 60 s timeout; the row is kept for the period so its last activity stays readable) | 90 days unseen (P27.1.2) |
| `presence_status` | a status whose `until` passed; a status with no end is kept until `/free` or the person's removal | at `until` (P27.1.2) |
| `push_subscriptions` | removed with the person (the push removal part, `push.md`); a row is dropped by the sender on a 404 or 410 answer or after 5 failed sends in a row; never pruned by time | removal of the person |
| `presence_disclosure` | removed with the person (P27.2.2, the removal registry); a setting is never pruned by time | removal of the person |
| `protocol_runs`, `protocol_run_steps` | runs that ended (`ended_at`), with their step rows; a running or waiting run is never pruned | 90 days (`hypothalamus.md`, P28.1.4) |
| `protocol_proposals` | proposals past their expiry (`expires_at`), whatever their status; the table has no decision time | 30 days after expiry (P28.1.4) |
| `agenda_items` | items whose end (`ends_at`, or `starts_at` plus one hour when null) has passed | 30 days (`hypothalamus.md`, ADR-0025 §2) |
| `succession_state` | kept on purpose: the one row of the owner's run; the history is in the audit (`owner.succession.*`) and the next run replaces the row | not pruned |
| `rooms`, `room_events` | not pruned: the transcript of a room stays for its members after it ends (`corpus-callosum.md`, ADR-0026 §5); deleting a room is a later decision (ADR-0021 consequences) | not pruned |
| `room_members` | removed with the person (the rooms removal registry, P30.2); a member row is never pruned by time, and an ended room keeps its members | removal of the person |
| `room_requests` | not pruned yet: a pending request expires at `expires_at` (10 minutes) and stays with its room as a record of the decision | not pruned |
| `persona`, `persona_versions` | kept: the persona and its whole history are the owner's record of what Keith was told to be (prefrontal.md, "Data model"); a version is never pruned | not pruned |
| `person_style` | removed with the person by the removal registry (P33.2.5: keep, export or purge); a style is never pruned by time | removal of the person |
| `dream_runs` | runs that ended (`ended_at`); the cadence and the cursor come from the latest rows, so a run that is still `running` is never pruned (ADR-0031 §8, `dreaming.md`); the prune tick deletes them through `RETENTION_PERIODS.dreamRunsMs` | 90 days |
| `dream_settings` | kept with the person: the mode of a person (ADR-0031 §5); a setting is never pruned by time; deleted at the purge of a removed person by the dreaming removal part (`people.md`, Rules; no foreign key, so the person's delete does not reach it) | removal of the person |
| `front_generations` | kept with the person (the owner's record of which context was current); removed by the removal registry on purge (P34.2.4), never pruned by time | removal purge of the person |
| `workspaces` | kept with the person (one small document); written into the kept folder with the presence rows and deleted at the purge by the parietal removal part (`parietal.md`), never pruned by time | removal purge of the person |
| `llm_bodies` | the bodies of calls (`activity-logs.md`, "Retention"): the call's `body_state` becomes `purged`, the figures stay | `bodyRetentionDays` (owner setting, default 14, read at each prune; not a `RETENTION_PERIODS` row) |
| `llm_calls` | the figures of calls (`activity-logs.md`, "Retention"); a session's calls go with it | `metaRetentionDays` (owner setting, default 365, read at each prune; not a `RETENTION_PERIODS` row) |
| `llm_sessions` | a session with no `last_at` inside the meta period and no call left; removed with the person's data in the removal part (`activity-logs.md`, "Removal") | `metaRetentionDays` (owner setting, default 365, read at each prune) |
| `protocols`, `protocol_versions` | a protocol and all its versions are kept while the owner keeps them; a delete removes both (cascade); a removed person's protocols follow the removal registry | owner's delete or removal of the person (P28.3.1) |
| `eh_stream_log`, `eh_stream_chunks` | expired logs (10 minute log life); `purgeExpired()` in the prune tick | the first prune tick after expiry (every 10 minutes) |
| `events` | activity rows (`keepLast` 10 000 and older than 7 days, the activity store prune) | 7 days |
| `auth_attempts` | failure counters with no failure in the last day (`throttle.ts`, run hourly) | 24 hours |
| `device_requests` | consumed, denied or long expired requests (`purgeExpired` on each device login) | after expiry plus a grace period |
| `audit_events` | not by this tick: `audit.retentionDays` (default 180, 0 keeps all) | 180 days |
| `eh_budget_record` | kept on purpose: the spend record | not pruned |
| `eh_locks` | not pruned: one row per session, taken over by the next holder once `until` passed | not pruned |
| `eh_messages`, `eh_state`, `eh_schedules` | kept with the session: removed with the person (P26.3.5) | removal of the person |
| `eh_messages`, `eh_state` of `dream-judge:` sessions | none is written any more (the judge keeps no transcript, `dreaming.md`, "Judge"); the prune tick deletes the rows an older install stored (a range delete on the id prefix, idempotent, audited as `data.pruned` only when it deletes) | every prune tick (the boot prune too); zero after the first run |
| `person_accounts`, `person_grants`, `person_identifiers`, `person_secrets`, `group_members` | removed with the person (`people.md`, the person delete) | removal of the person |
| `person_pair_codes` | removed with the person (P26.3.5); an unused code is not pruned by time yet (open: no number decided) | removal of the person |
| `people` | kept while the person exists; a removed person's folder is kept 30 days, then purged (ADR-0027 §26) | 30 days after removal |
| `groups`, `resources`, `resource_acl` | access data, kept until the owner or the plugin deletes it (`acl.md`) | not pruned |
| `nodes` | kept while the node is paired; a revoked row holds no usable token (`revoke`) | not pruned |
| `config_profiles`, `settings`, `plugin_kv` | configuration and plugin settings, changed by the owner or the plugin | not pruned |
| `eh_budget_scope` | the limit and spend of a scope per UTC month: one row per scope and month, a few a year | not pruned |
| `catalog_cache` | a cache of public model catalogs, replaced on refresh; no personal data | replaced on refresh |

**File rule of the dreaming memory (P35, ADR-0031 §8; not rows, so not in the table above).** A prune tick (`compose-timers.ts`) also
calls `purge()` of `modules/hippocampus/dream/purge.ts`: archive entries of `memory/<personId>/archive.md` 30 days after they were archived,
and the preimages (`dreams/<personId>/undo/<runId>/`) and staged plans (`dreams/<personId>/staged/`) 7 days after their run ended. Each
deletion is audited as `data.pruned { table, count }` with the table names `dreaming.archive`, `dreaming.undo` and `dreaming.staged`.

## Adoption of eharness/sqlite

`schemaSql({ prefix: 'eh_' })` of `eharness/sqlite` 0.11.0 compared with the Drizzle migrations (all applied to an empty
database and read with `PRAGMA table_info` / `index_list`, 2026-11-08; the live manual-test schema equals the Drizzle
schema). Keith's migrations stay the only schema authority: the package's `migrate` is never run on `keith.db`, so its
other tables are never created. Outcome: some adapters adopted, some kept (the incompatible ones).

| Package table | Keith table | Columns | Verdict |
| --- | --- | --- | --- |
| `eh_messages` | `eh_messages` | identical | adopted |
| `eh_state` | `eh_state` | identical | adopted |
| `eh_inbox`, `eh_inbox_keys` | same names | identical columns; only index names differ (`eh_inbox_session_available` and `eh_inbox_session_id` vs `eh_inbox_session`, and `eh_inbox_keys_expiry` only in Keith); no query depends on them | adopted; `subscribe` is stripped so the holder keeps polling (`inbox.pollMs`) |
| `eh_budget_scope`, `eh_budget_reservation`, `eh_budget_record` | same names | identical | adopted, with the package's `setBudgetLimit`; `currentPeriod` and `budgetStatus` stay in Keith |
| `eh_locks` | `eh_locks` | identical | adopted since 0.10: eharness passes `recovery.instanceId` as `owner` to `acquire`, so a restarted core takes its own stale lease back at once; the `takeOver` option is gone |
| `eh_stream_log` | `eh_stream_log` | identical (Keith adds `DEFAULT 0` on `length`; index named `eh_stream_log_expiry`) | kept Keith's adapter (next row) |
| `eh_stream_chunks` | `eh_stream_chunks` | `seq` in the package, `idx` in Keith | kept Keith's adapter: adopting the package needs the column renamed. `drizzle-kit generate` offers the rename but emits a table rebuild that copies `seq` from a table that only has `idx` (it fails on a database that holds chunks), and generated migrations are never edited by hand. The log is a 10 minute cache; revisit when a rename can be generated safely |
| `eh_activity`, `eh_activity_meta` | `events`, `settings` (key `events-pruned-through`) | columns equal, names differ | kept: the package fixes table names by prefix only |
| `eh_profiles` | `config_profiles` | columns identical, name differs | kept: same reason |
| `eh_schedules` | `eh_schedules` | identical (0012) | adopted since P16 step 9: `sqliteSchedules(sqlite)` is the package's `sqliteScheduleStore` on the shared driver |
| `eh_outbox`, `eh_handoffs`, `eh_people`, `eh_person_*` | none, or `people` family with `username`, `role`, `owner` | different | not used; people stay Keith's (`username`, caller ids, `transferOwner`) |

Revisit the kept rows when the package can take table names or the chunk column is renamed.

## Public API (`src/index.ts`)

`openDatabase(file)` (creates the folder; `:memory:` allowed; `busy_timeout = 5000` set before WAL, so a database another process holds for a moment is waited for (Nov 14, 2026),
`foreign_keys = ON`), `migrateDatabase(sqlite)` (the core's migrations only; plugins: `@keith/host/storage`, see "Plugin storage"), `assertMigrated(sqlite)`, `MIGRATIONS_DIR`,
adapters `sqliteMessages`, `sqliteState`, `sqliteLock`, `sqliteInbox`, `sqliteProfileStore`,
`sqliteCatalogCache`, `sqliteStreamLog(sqlite, { retentionMs?, now? })` (no `subscribe`: readers poll; every write is `BEGIN IMMEDIATE`;
an append with `at` is idempotent by length and a gap rejects; retention 10 minutes by default, moved by every append and close, shortened by `expire`; an expired log reads
as `missing`; `purgeExpired()` deletes the chunks and heads of every expired log (the prune tick calls it every 10 minutes and once at boot, so no read, append or close is needed; a read, append or close also drops the log it touches)), `sqliteBudgetLedger(sqlite)` (limits per scope and UTC month; a new month inherits the latest limit and starts at 0 spent; reserve, commit,
release, record and check as eharness spec 12 §4.1; each write is one `BEGIN IMMEDIATE`), `setBudgetLimit(sqlite, scope, usd | null)` (current month; `null` removes the limit),
`currentPeriod(now?)` (first instant of the UTC month, epoch ms), `budgetStatus(sqlite, scopes, now?)` (read-only: per scope `{ limitUsd | null, spentUsd, reservedUsd, periodStart }`), `sqliteActivityStore(sqlite, { now? })`, `reviewsRepo(sqlite, { now? })` (`create(input, cap)` is one `BEGIN IMMEDIATE` that refuses with `{ ok: false, reason: 'cap' }` when the requester has `cap` pending, unexpired rows; `get`, `list({ status?, requester?, limit? })` newest first, `decide` acts once on a pending unexpired row, `setOutcome`, `expire()` returns the rows it moved, `purge(before)` deletes the decided rows whose `decided_at` is before `before`, never a pending one), repos `settingsRepo` (`get`, `set`, `delete`), `tokensRepo`, `credentialsRepo(sqlite, { now? })` (`create`, `find` with the person and `secretHash`, `touch(id, ip, at)`, `list(personId, kind?)`, `setElevated(id, until)`, `revoke(id, kind?)`, `revokeAll(personId)`), `secretsRepo(sqlite)` (`findPerson(username)`, `get`/`kinds`/`set`/`clear` of `person_secrets`, and the counters `attempt`, `fail`, `lock`, `reset`, `locked`, `prune`; exports `ANY_IP`), `deviceRequestsRepo(sqlite, { now? })` (`create` refuses with `{ ok: false, reason: 'limit' }` at `MAX_PENDING_PER_IP` = 5 pending per address, `get`, `findPendingByCode`, `listPending`, `approve`, `deny`, `remove`, `purgeExpired(graceMs)` returns `{ removed, credentialIds }`: the credential ids of approved, uncollected requests it removed; approve and deny only act on a pending, unexpired row), `auditRepo(sqlite, { now? })` (`add`, `list(limit)` newest first, `prune(before)` deletes `at < before` and returns the count), `sqliteAcl(sqlite, { kinds, now? })` (the `AclStore` of `@keith/acl` over `groups`, `group_members`, `resources`, `resource_acl` and `people`, plus `filterSql` and `transaction`; see "ACL storage"), `sqlitePersonStore(sqlite, { via? })` (`eharness/identity` `PersonStore` plus `username`, `byUsername`, `owner`, atomic `transferOwner`, `withVia`; see `people.md`), `backfillPeople(sqlite)`,
`clientsRepo(sqlite)` (`register(personId, input, at, network)` in one `BEGIN IMMEDIATE`, the network is the core's derivation (`null` when unknown): `registered` (with `created`), `foreign` (the id is another person's: no hijack) or `full` (20 clients); `get`, `listFor(person)`, `countFor`, `touch(personId, id, at, active)`, `remove(personId, id)`), `presenceSignalsRepo(sqlite)` (`record(input)`: a `client.active` of the same client within 60 s is skipped, returns false; `detail` over 200 bytes throws a RangeError; `newest(personId, types)`), `presenceStatusRepo(sqlite)` (`get`, `set` (busy), `clear`), `presenceDisclosureRepo(sqlite)` (`list(personId)`, `set(personId, audience, level)` upsert); the prune of the three tables is `retentionRepo.presenceSignals`, `clients` and `presenceStatus` (see "Retention"); see `parietal.md`.
`deliveriesRepo(sqlite, { now? })` (`create(input)` inserts a pending row or returns the stored row of the same id with `created: false`, the exactly-once guard; `get`, `due(now, limit)` oldest due first, `settle(id, patch)` (a `delivered` row blanks its text), `pendingFor(recipient)`, `deletePendingFor(recipient)`, `pendingBefore(cut)`, `heldFor(recipient, limit?)`, `heldRecipients()`, `heldBefore(cut, limit)`, `deleteHeldFor(recipient)`; `retentionRepo.deliveries(before)` prunes the ended rows; see `delivery.md`), `tasksRepo(sqlite, { now? })` (`upsert` keeps `createdAt`, `get`, `list({ parentSessionId?, active?, limit? })`
newest updated first, `markFinished`). `TaskRecord` and `TaskStatus` (queued, running, waiting, done, failed,
stopped, timed_out, interrupted) are defined in the repo; the wire schema lives in contracts.
`nodesRepo(sqlite, { now? })` (`create` throws when a non-revoked node has the name, starts offline and sets `token_issued_at` to now, `get`, `findByTokenHash`
live nodes only, matching the current or the pending token hash, `list({ includeRevoked? })`, `updateManifest`, `setStatus`, `touch`,
`beginTokenRotation(id, nextHash)` sets `token_next_hash` (the current token keeps working), `commitTokenRotation(id, hash)` moves the pending hash
into `token_hash`, sets `token_issued_at` and clears the pending one, and returns undefined when `hash` is not the pending one, so a repeat is a no-op;
`revoke` sets `revoked_at` and replaces both token hashes with `revoked:<id>` so they never match again; updates on unknown or revoked ids return undefined). `pairingRepo(sqlite, { now? })`
(`create({ hash, createdBy, ttlMs })` returns `{ ok: false, reason: 'limit' }` when 3 codes are active, counted across all creators;
`consume(hash, usedByNode?)` is one `BEGIN IMMEDIATE` transaction returning `{ ok: true }` or `{ ok: false, reason: 'unknown' | 'used' | 'expired' }`;
`active(createdBy)`, `purgeExpired(keepMs?)`: deletes codes that expired more than `keepMs` ago). `nodesRepo.joinWithCode` checks, creates and spends in one transaction. Node tokens and pairing codes are stored as hashes; hashing is the caller's.
The activity store keeps the retention mark in `settings` (`events-pruned-through`), only moving forward.

The generation repo (`repos/front-generations.ts`, P34.2.1): `frontGenerationsRepo(sqlite)` (`get(personId)` the row or undefined, which means generation 0; `bump(personId, at)` moves the row to the current generation plus 1 (0 when no row exists) in one `BEGIN IMMEDIATE` and returns the new generation; `list()` ordered by person).

The persona repos (`repos/persona.ts`, `repos/persona-style.ts`, P33.2.2): `personaRepo(sqlite, { now? })` (`get()` the persona or undefined before the first write; `write({ templateId, body, reason, changedBy, note? })` writes the persona row and one `persona_versions` row in one `BEGIN IMMEDIATE`, the version is the current one plus 1 and a refused write leaves neither row; `version(n)`, `versions(limit?)` newest first; `restore(n, changedBy, note?)` writes a new version (reason `restore`) with the old template and body, or returns undefined for an unknown version). `personStyleRepo(sqlite, { now? })` (`get(personId)` the stored style or undefined, `upsert(personId, patch, updatedBy)` merges the patch over the stored or default style in one transaction and returns the style after it, `delete(personId)` for the removal purge). Both check their values with the contract schemas (the address deny list and shape included); the repo never decides a change of right.
Adapter writes that need atomicity use `BEGIN IMMEDIATE`, so two processes can share the file.
The hypothalamus repos (`hypothalamus.md`, P28.1.5): `protocolsRepo(sqlite)` (`create(input, at)` writes version 1 and refuses a duplicate name or built-in with `{ ok: false, reason: 'name' | 'built-in' }`; `get`, `findBuiltIn`, `list(owner?)`, `version`, `versions`; `saveVersion(id, expectedVersion, input, at)` is a compare-and-set on the current version, `{ ok: false, reason: 'conflict', current }` writes nothing; `setEnabled`, `setPausedUntil`, `remove` (cascades the versions)); `protocolRunsRepo(sqlite)` (`start(input, at, cap?)` is one `BEGIN IMMEDIATE`: an existing run of the same id or `(protocol_id, trigger_ref)` returns `exists`, then the optional daily cap returns `limit`, else `created`; `get`, `findByTrigger`, `list({ protocolId?, person?, limit })`, `inStatus` (recovery); `claimDue(now, limit)` moves due `waiting` runs to `running` in one transaction; `advance(id, expectedUpdatedAt, patch, at)` writes only over the revision the caller read and returns `undefined` for a loser, the stored `updated_at` is `max(at, expected + 1)`; `appendStep` returns the step `n`, `settleStep(n, outcome)`, `steps(runId)`); `protocolProposalsRepo(sqlite)` (`create`, `get`, `list(person, status?)`, `decide(id, to)` only from `pending`, `expireDue(now)`); `agendaRepo(sqlite)` (`add`, `get`, `update(id, patch, at)` changes the named fields only, `list(person, { from?, to? })` overlapping items, `busyAt(person, at)` confirmed items only). Their prune is `retentionRepo.protocolRuns`, `protocolProposals` and `agendaItems` (see "Retention"). The succession repo (P29.1.4): `successionRepo(sqlite)` (`get()` returns the idle default when no row exists; `start(input, at)` moves `idle` or `claimed` to `check-in` once, false while a run is active; `move(from, to, at, fields)` is a compare-and-set on the state; `transaction(fn)` is one `BEGIN IMMEDIATE` for the claim). No prune: see "Retention".

## Migrations

- Generate SQL from the schema: `bun run --filter @keith/db db:generate` (drizzle-kit). Files in
  `drizzle/` are generated: never edit them by hand.
- Apply: `bun run db:migrate` (`apps/core/src/migrate.ts`, drizzle bun-sqlite migrator), or at `keith-core start` and setup (`runCore`, the offline admin and `db migrate` all go through `migrateWithBackup`, P26.1.3; `db migrate` takes `core.lock` first). `migrateWithBackup(config, plugins, log, via)` (`platform/db.ts`, P26.1.2, ADR-0027 §3) is the one way an existing database is migrated: a missing file is created with no backup; a behind one (core or plugin journal) is first copied with `VACUUM INTO` to `<dataDir>/backups/keith-<yyyymmdd-hhmmss>.db` (folder 0700, file 0600) and the copy must pass `integrity_check`. If the copy fails the migration is refused and nothing changes (`BackupError`: "could not back up the database: <reason>; nothing was changed"). Then the core's and the plugins' migrations run, the newest five snapshots are kept (`pruneSnapshots`; other files in `backups/` are never matched), the run is audited as `db.migrated { from, to, backup, pluginMigrations }` (`via` `offline` or `local`) and one line is logged.
- **States** (`dbState`, `platform/db.ts`, P26.1.6, FD11-01, FD11-10; read only, it never writes): `missing`, `ready`, `behind` (a journal has fewer rows than it ships: migrated as above), `ahead` and `diverged` (written by another build: refused), `unreadable` (corrupt, no permission, or locked by another connection: refused with the SQLite reason and the `backups/` folder, never as "run setup" or "run migrate"). `ahead` is more rows than shipped; `diverged` is a row of the shared prefix whose `hash` or `created_at` differs from the shipped journal (`journalStateOf` in `@keith/db`, `pluginJournalState` in `@keith/host/storage`; the core and each plugin are compared). The refusal, for `assertMigrated`, `openKeithDatabase`, `runCore`, `start`, `db migrate`, the offline admin and `doctor`: "this database was migrated by a newer Keith (<n> applied, this build ships <m>): update Keith, or `keith-core restore` a backup made before the upgrade" (there is no downgrade). `migrateWithBackup` refuses before any snapshot or migration.
- `assertMigrated` compares applied migrations (`__drizzle_migrations`) with the shipped journal.
  When behind it throws: "database schema is behind (a/b migrations): run `bun run db:migrate`".
  Core boot (`openKeithDatabase`) closes the database and rethrows, so the core refuses to start.

**Migration 0008 (P14)** adds the six `credentials` columns, `people.can_login` and `person_identifiers`; it only adds
(nullable columns or columns with a default) and drops or rewrites nothing, so it is safe on existing rows. The session columns are read and written since P14 step 6 (`auth.md`, Sessions); an old row keeps null expiries, so it never ends by time.
`migration-0008.test.ts` builds a fresh temp database from the migrations before it (the journal cut at 0008), fills it
(owner and member, password and PIN, `token` and `device` credentials, one revoked, one elevated, a legacy token),
migrates, and checks every old value is unchanged and the new columns read as defaults. Procedure for the owner's real
file: `cp <data>/keith.db <data>/keith.db.bak` (stop the core first), run `bun run db:migrate`, start the core;
`assertMigrated` still refuses an unmigrated file. The new credential `kind` value `session` is **not** part of 0008:
`kind` stays `device` or `token` until step 6 (see the plan).

**Migration 0015 (P25.1.2)** adds the `deliveries` table and its index; nothing else changes. Generated by drizzle-kit from
`schema/delivery.ts`. `migration-0015.test.ts` migrates a database built before it: the rows of older tables are unchanged and the new table starts empty.

**Migration 0025 (ADR-0033 amendment, Nov 12, 2026)** drops the table `presence_client_context` (the per-person client-context switch, removed). Nothing else changes: the rows of the other tables stay. Generated by drizzle-kit (`0025_drop_client_context.sql`). `migration-0025.test.ts` checks the table is gone and the client columns stay.

**Migration 0027 (ADR-0035, W9)** adds the table `push_subscriptions` (unique `endpoint`, index `(person_id)`) and nothing else. Generated by drizzle-kit (`0027_purple_skullbuster.sql`). `migration-0027.test.ts` migrates a database built before it: older rows are unchanged, the table starts empty, takes a row and refuses a second row with the same endpoint.

**Migration 0028 (ADR-0037, P40.2)** adds the table `workspaces` (one versioned document per person, no foreign key; additive).

**Migration 0026 (ADR-0034 §5, P37.3)** adds the nullable integer column `from` to `presence_status` (the start of a stated status; a future `from` does nothing until then). Nothing else changes: stored statuses keep their kind, note and end and read back with `from` null. Generated by drizzle-kit (`0026_powerful_ego.sql`). `migration-0026.test.ts` migrates a database built before it.

**Migration 0024 (ADR-0033)** adds `clients.environment` and `clients.network` (two nullable columns; the rows that exist keep null). It also created the table `presence_client_context`, which migration 0025 drops again. `migration-0024.test.ts` migrates a database built before it.

**Migration 0023 (P36.2.1)** adds the activity-log tables `llm_sessions`, `llm_calls` and `llm_bodies` (columns and CHECKs in the table list above; times are epoch milliseconds, cost is integer micro-dollars, closed sets come from `@keith/contracts`). Generated by drizzle-kit from `schema/activity-logs.ts`. `migration-0023.test.ts` migrates a database built before it: the rows of older tables are unchanged and the three tables start empty. The repo is `activity-logs-repo.ts` (`insertCalls` writes a batch in one transaction and upserts the session totals; purges refresh the totals of the sessions they touch). `activity-logs-repo.test.ts` covers the round trip, the totals, the CHECKs, stable paging and the purges.

**Migration 0022 (P35.2.1)** adds the dreaming tables `dream_settings` (`person_id` primary key, `mode` CHECK `off`, `propose`, `auto`, `updated_at`, `updated_by`) and `dream_runs` (`id` primary key, UUIDv7; `trigger` CHECK `schedule`, `manual`; `mode` CHECK as above; `status` CHECK `running`, `applied`, `staged`, `skipped`, `refused`, `failed`, `rejected`; `reason`, `started_at`, `ended_at`, JSON `counts` and `cursor` with the default `{}`, `undo_until`) with the index `dream_runs_person_started` on `(person_id, started_at)`. Neither table has a foreign key. Generated by drizzle-kit from `schema/dreaming.ts`. `migration-0022.test.ts` migrates a database built before it: the rows of older tables are unchanged, both tables start empty and a second `setMode` for the same person is one row. The repo is `repos/dreaming.ts`.

**Migration 0021 (P34.2.1)** adds the table `front_generations` (`person_id` primary key, `generation`, `updated_at`) with no foreign key, the index-free primary key on the person and nothing else. Generated by drizzle-kit from `schema/front-generations.ts`. `migration-0021.test.ts` migrates a database built before it: the rows of older tables are unchanged, the table starts empty, one row per person holds and a person without a `people` row is accepted.

**Migration 0020 (P33.2.1)** adds the prefrontal tables `persona`, `persona_versions` and `person_style`, with the singleton CHECK of `persona`, the unique index `persona_versions_version` and the CHECKs of their enums; nothing else changes. Generated by drizzle-kit from `schema/persona.ts`. `migration-0020.test.ts` migrates a database built before it: the rows of older tables are unchanged, the new tables start empty, and the singleton, the unique version, the foreign key of a style to a person (no cascade) and the CHECKs refuse a bad row.

**Migration 0019 (P30.1.3)** adds the shared-room tables `rooms`, `room_members`, `room_events` and `room_requests`, with their indexes, the partial unique index `room_members_one_active` and their CHECKs; nothing else changes. Generated by drizzle-kit from `schema/rooms.ts`. `migration-0019.test.ts` migrates a database built before it: the rows of older tables are unchanged, the new tables start empty, and the primary keys, the foreign keys (a delete of a room removes its members, events and requests) and the CHECKs refuse a bad row.

**Migration 0017 (P28.1.4)** adds the hypothalamus tables `protocols`, `protocol_versions`, `protocol_runs`, `protocol_run_steps`, `protocol_proposals` and `agenda_items`, with their indexes and unique guards; nothing else changes. Generated by drizzle-kit from `schema/protocols.ts`. `migration-0017.test.ts` migrates a database built before it: the rows of older tables are unchanged, the new tables start empty, and a second run with the same trigger ref or a second built-in of the same owner is refused.

**Migration 0016 (P27.1.2)** adds the presence tables `clients`, `presence_signals`, `presence_status` and `presence_disclosure`, with their index; nothing else changes. Generated by drizzle-kit from `schema/presence.ts`. `migration-0016.test.ts` migrates a database built before it: the rows of older tables are unchanged and the new tables start empty and take a row.

## Plugin storage (P16 step 5)

Code: `packages/host/src/storage` (the `@keith/host/storage` subpath, for the core only), `scripts/plugin-db-generate.ts`, wiring in `apps/core/src/platform/db.ts` and `compose-plugins.ts`.

- **Tables.** A plugin owns the tables `plg_<id>_*` (the hyphens of its id become underscores: `beta-two` owns `plg_beta_two_*`) and nothing else. Two plugins that keep tables
  must not have nesting prefixes (`ab` and `ab-cd`): the loader fails the second. A plugin references people by plain text id, never a foreign key into a core table.
- **Schema and migrations.** `plugins/<id>/schema.ts` (Drizzle, written with `@keith/host/schema`) and `plugins/<id>/migrations/` (generated). The manifest names the folder: `storage: { migrations: import.meta.dir + '/migrations' }`.
  `bun run plugin:db:generate <id> [--dir <folder>] [--name <label>]` runs drizzle-kit with a generated config (schema, `out`, `tablesFilter: ['plg_<id>_*']`, journal table `__plg_<id>_migrations`). Never edit the files by hand.
  drizzle-kit's `tablesFilter` does **not** limit `generate`, so the script reads the schema first and refuses a table outside the prefix; the apply step checks again.
- **Applying.** `bun run db:migrate` runs the core migrations, then, for each built-in plugin that keeps tables, `migratePluginStorage`: every statement of every migration is checked
  (`assertMigrationSql`: only `plg_<id>_*` tables and indexes, the `__new_plg_<id>_*` table of a rebuild, `PRAGMA foreign_keys`; no view, trigger, attach or other pragma) **before** the drizzle bun-sqlite migrator runs
  with `migrationsTable: '__plg_<id>_migrations'`. Each plugin has its own journal, so plugins and the core never share one. Idempotent. The core migration (`migrateKeithDatabase`) applies these journals right after its own, at `keith-core start`, setup and `db migrate`.
  Verified end to end (`packages/host/src/storage/storage.test.ts`): two plugins with their own folders apply independently, in any order, twice; the core journal `__drizzle_migrations` is not touched.
- **Boot check.** `openKeithDatabase(dataDir, dbFile, plugins)` runs `assertMigrated` and then `assertPluginStorageMigrated`: the rows of `__plg_<id>_migrations` against the plugin's `meta/_journal.json`.
  Behind: "plugin <id>: database schema is behind (a/b migrations): run `bun run db:migrate`". `isMigrated` (doctor, run-core, offline admin) takes the same list. Doctor reads through `openKeithDatabaseReadOnly` / `openReadOnlyDatabase` (`platform/db.ts`, P23.4.6): SQLite opens read only, nothing is created or migrated, and the data folder is not re-secured.
- **The scoped handle (`k.db`).** A Drizzle handle over a client that only forwards `prepare`, `exec` and `transaction`; every statement goes through `assertScopedSql` first. It reads tokens, not text: data statements only (no DDL, `PRAGMA`,
  `ATTACH`, `load_extension`), and **no identifier** (quoted, bare, with comments or schema qualifiers around it) may name a table or index that the plugin does not own: any name in the live schema outside its prefix, and any `plg_`,
  `eh_`, `sqlite_`, `pragma_` or `__` name. The price: a column may not share a name with a core table. This is a seatbelt against mistakes and a tripwire for review, not a sandbox: plugins are trusted code (ADR-0016, tier T1).
  The names of the schema are read once when a plugin's handle is first made (after the migrations ran).
- **`k.kv`.** `get`, `set`, `delete`, `list({ prefix?, limit? })` over `plugin_kv` (a core table, so a plugin that only needs a few settings ships no migration); the plugin id is the namespace.
- **Import rules (`check-imports`).** `plugins-no-node-builtins` (no `node:*` or `bun:*` in plugin source; tests and configs may), `plugins-no-host-storage` (the storage subpath is the core's), and the existing `plugins-only-host-contracts` and `db-only-from-core`
  (no plugin imports `@keith/db` or another plugin: other plugins are reached through `services` and `call`, step 6). `check-size` and `check-exports` already walk `plugins/*`.
- **Procedure for the owner's real file** (when a built-in plugin with tables ships): stop the core, `cp <data>/keith.db <data>/keith.db.bak`, `bun run db:migrate`, start the core. The plugin migrations only add `plg_<id>_*` tables.
  `apps/core/src/plugins-storage.e2e.test.ts` rehearses it on a temp database built from the shipped migrations: core tables, indexes and rows are identical afterwards.

## ACL storage (P15 step 3)

**Migration 0009** adds `groups`, `group_members`, `resources` and `resource_acl` (all new tables, nothing dropped or rewritten).
`migration-0009.test.ts` builds a fresh temp database from the migrations before it (`src/testing/migrations.ts`, `migrationsBefore('0009_')`),
fills it (people, a credential, audit rows, a setting), migrates, and checks every old row is unchanged and the new tables start empty and work.
The same procedure as 0008 applies to the owner's real file: copy the file, run `bun run db:migrate`.

Upgrade drill (P26.1.4, `apps/core/src/platform/upgrade-drill.test.ts`): a temp database at the previous schema (all core migrations but the last, every plugin journal) is seeded with people, notes, reminders, a running worker and a pending approval, then `migrateWithBackup` runs. The test asserts the row counts are equal before and after, the snapshot opens with the old rows and the previous migration count, and boot recovery on the migrated copy marks the worker interrupted while the approval stays pending. The helpers `migrateFolder` and `migrationsBefore` come from `@keith/db/testing`.

`sqliteAcl(sqlite, { kinds, now? })` implements `AclStore` (`acl.md`). Membership and status are read from `group_members` and `people`
(`status = 'active'`) at every check. Writes are `BEGIN IMMEDIATE`; `transaction(fn)` runs `fn` in one such transaction and hands it the
same store, so a check for write and the write it guards cannot race (TOCTOU); a throw rolls everything back. Unique and primary key
violations are `AclError('CONFLICT')`; bad modes, bits, kinds and groups are `AclError('INVALID')`.

**`filterSql(actor, kind, want, { rootAccess? })`** returns `{ sql, params }`: a subquery `SELECT r.id FROM resources r WHERE r.kind = ? AND ...` with
bound parameters only (a person id, a kind or a subject never appears in the text). Use it as `WHERE note.id IN (<sql>)` with `...params`, so the
filter runs before `ORDER BY`, `LIMIT`, cursors, `count(*)` and FTS ranking. It encodes the same rule as `check` bit by bit: for every wanted bit,
(owner class, team class through `group_members`, public class, an allow entry matching the actor) and no matching deny entry; the actor must be
`active` (a guest is not a row and is not checked); a guest keeps only the bits of `GUEST_CEILING` and matches only `@public` entries; the instance
owner's root read covers the read bit of every row of the kind. An unknown kind, a `want` outside the class or an empty actor id selects nothing
(`WHERE 0`). With `rootAccess: false` the root read is left out: the rows in `filterSql(...)` but not in the `rootAccess: false` variant are what the
owner sees only as root (what step 4 audits). `visibleIds` runs the same fragment. A differential test checks the fragment against `check` for 1200 random
resources, every actor and every `want`.

FTS: `bun:sqlite` ships FTS5. A Notes-shaped test joins `notes_fts` to `notes` with `n.id IN (<fragment>)` and orders by `bm25`, with `LIMIT`: the top-k is filled
with visible rows, `snippet()` only reads visible rows and a hidden row never appears. The rank is computed over the whole index (document counts and term
statistics include hidden rows), so a plugin must never return or compare the raw `bm25` value across people; only the order of visible rows leaves the database.

`removePerson(personId, heirId)` hands the person's resources to the heir, deletes their `user:` entries and memberships. `people.remove` does
not call it yet (step 5/6 wires it from the people module); until then a removed person's resources keep their owner id, are denied to everyone but the
instance owner's audited root read, and shared entries to others still apply.

## Invariants

- `migrateDatabase` runs the generated migrations and then `backfillPeople` (idempotent: the owner row of a P8 database gets username `owner`, and `updated_at` = `created_at`).
- There is at most one `owner` row (unique partial index); the service layer keeps it at exactly one.
- Person events are `audit_events` rows of kind `person.<event>` with `detail.personId`; `PersonStore.delete` never deletes them; only the audit retention prune does (after `audit.retentionDays`, default 180).
- Table shapes change only through a new generated migration.
- Tokens are stored as hashes only; secrets in `config_profiles` are sealed before storage.
- Message order is the text order of the UUIDv7 id.
- Shared rooms (`src/repos/rooms.ts`, P30.1.4): a person is `active` in at most one room (partial unique index, checked again by the repo); a move applies only from the status the caller read; a member reads a transcript only after joining and only up to `left_at` (an event at that instant is shown only when it is a membership event: `leave`, `remove` or `end`); a request is confirmable only while pending and before `expires_at` (10 minutes).

## Tests

`src/eh/conformance.test.ts` runs the eharness suites `messageAdapterConformance`,
`stateAdapterConformance`, `lockConformance`, `inboxAdapterConformance` and
`profileStoreConformance`, `activityStoreConformance`, `streamLogConformance` and `budgetLedgerConformance` (the factory applies the case's limits with `setBudgetLimit`) (two connections to one file = two instances) against a file database. `src/eh/conformance.test.ts` also runs `personStoreConformance` (a fresh in-memory database per case); `src/eh/person-store.test.ts` covers UUIDv7 ids, username uniqueness and rename, one owner and atomic transfer, delete (credentials gone, events kept), audit rows with their `via`, and the migration of a P8 database. `src/repos/rooms.test.ts` covers the shared-room repo (one active room per person, the member status machine, the end of a room, the window of 200 events within 30 minutes, the transcript cut at `left_at`, request expiry), and `src/migration-0019.test.ts` the migration of the room tables. `src/connection.test.ts` covers open, migrate
and `assertMigrated`; `src/repos/repos.test.ts` covers budget status (limit, spent, reserved, month rollover), settings, tokens, tasks, nodes (revoked token, name uniqueness) and pairing (single use, expiry, 3-active limit).
