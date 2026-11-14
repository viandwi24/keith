# P23 — Identity, access and audit fixes

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku and Sonnet implementers, orchestrated; `bun run check` and `bun run smoke` pass: 56 smoke steps) · depends on: P21 (done) · first plan of the P22 order; P26 phase 1 (migration backup, `core.lock` for `db migrate`) ships right after it (this plan adds no migration) · ADR: 0027 §2, §4, §5, §6, §7, §8 (builds on 0014, 0015, 0020) · closes: F-005 (verified: docs pass of Nov 10), F-006, F-014, F-015, F-018, F-028, F-029, F-030, F-031, F-035, F-044, F-045, F-046, F-047, F-050 (verified: docs pass of Nov 10), Q-011, Q-013, Q-014, Q-016, doc gap 3 (first-login notice), REQ-094 (verify), REQ-041, REQ-051 to REQ-053, REQ-246 (trace only), FD10-01, FD10-02, FD10-05, FD10-09, FD10-10, FD10-11, FD10-13, FD10-15, FD10-16, FD11-05 (second review round, `docs/flow-review/2026-11-10-folded/`)

## Goal

Sign-in and credential rules apply the same way on every route and every entry point (HTTP, socket, offline CLI). Every person can see, in the TUI, what the owner looked at of theirs, and the owner is told once at first login that this is how Keith works. The audit log is complete for setup, providers, ACL and approvals, and only the owner reads the whole log.

## Why

- ADR-0027 §2 (PIN step-up follows the PIN zone rule), §4 (`/auth/login` narrows like `/auth/flow`), §5 (credentials), §6 (audit visibility, `audit.mine`, first-login notice), §7 (audit completeness), §8 (owner self-share allowed, documented).
- Findings: F-006, F-028 (two routes, two rules; lifetime without role or kind), F-014 (live credential after a purged device request), F-015 (revoke by id across people), F-029 and F-030 (offline entry points skip revocation and the lockout guard), F-031 (PIN step-up refused on LAN), F-047 (dead policy fields), F-018 (no member view, `audit.read` grantable and whole-log), F-044 to F-046 and F-035 (audit rows missing or too thin), F-005 (owner self-share), F-050 (role-change revocation sentence is stale).
- Requirements: REQ-007, REQ-018, REQ-021, REQ-024, REQ-029, REQ-034, REQ-043, REQ-070, REQ-073, REQ-085, REQ-086 (share half), REQ-089, REQ-091 (recon d1 and d2 traceability rows).
- Promise to members that is not met today: `docs/sharing-and-privacy.md` ("What did the owner look at of mine?") has no member-facing path.

## Scope

In: everything under "Phases" below. Specs changed: `auth.md`, `permissions.md`, `people.md`, `acl.md`, `core-cli.md`, `cli.md`, `thalamus.md`, `tui.md`, `tui-login.md`, `tui-design.md`; also `docs/sharing-and-privacy.md`, `SECURITY.md` (audit section) and `ARCHITECTURE.md` (identity paragraph).

Out (and where it goes):

| Item | Where |
| --- | --- |
| Removed person's data, `left` status (F-051), `people login on\|off` (REQ-064, ADR-0027 §26 to §27) | P26 (P26.3.1 to P26.3.4 for ADR-0027 §26 and §27, P26.4.x for §28) |
| Migrations with backup, `core.lock` for `db migrate`, atomic stale-lock takeover (F-011, F-026, F-027) | P26 |
| Reminders cancel by the owner (F-016, REQ-086 reminders half, REQ-213) | P24 |
| Members read all nodes (F-017, OWN-008) | P24 |
| `transferOwner` target needs a secret (F-013), delegate cannot take over the owner (F-001) | done in P21 |
| REQ-094 (plugin view audit, `apps/core/src/modules/plugins/view-audit.ts`) | already implemented; recon only marked it "out of D2 scope"; step P23.3.5 verifies it with a test |

## Design

### No migration

`audit_events` keeps its shape (`id, at, kind, actor, via, detail`). The member view reads rows by the JSON detail fields through SQLite `json_extract` (the table is small and pruned by retention). Rows about a person carry one canonical key so the filter stays simple:

- `subject`: the person the event is about (set on every `person.*`, `credential.*`, `acl.owner-access`, `acl.share|unshare|chmod|chgrp|chown` row; existing rows also match on their old keys `personId` and `owner`).
- `resourceOwner`: the person who owns the resource an ACL row touches (new on share, unshare, chmod, chgrp, chown, create, remove, deny; `acl.owner-access` already has `owner`).

**Subject registry.** Which detail field names the subject of a kind is data, not a convention: `packages/contracts/src/audit.ts` exports `AUDIT_SUBJECT_FIELDS: Record<kind, string[]>` (for example `'person.secret.set': ['subject']`, `'acl.owner-access': ['owner']`, `'plugin.reminders.cancelled': ['creator','recipient']`). `AuditRepo.listFor` reads the fields of that map, and the core keeps a twin `registerMySummary(kind, (detail) => string | undefined)` in `modules/audit/mine.ts`. Later plans register their kinds in the same two places in their own audit step (P24.6.5, P26.3.3, P27.4.1, P28.2.7, P29.3.2, P30.2.4); a test fails when a kind that is written with a subject has no summary and is not listed as hidden.

If the scan ever shows in profiling, a later plan adds a generated column and index; that would be an additive migration with the P26 backup.

### Contracts (`packages/contracts`)

- `capabilities.ts`: add `'audit.mine'` to `CAPABILITY_IDS`; add it to `ROLE_CAPABILITIES.member` (the owner has all); add `'audit.read'` to `OWNER_ONLY_CAPABILITIES` (existing grants are ignored by `capabilitiesOf`, which already drops owner-only ids for non-owners).
- `contract.ts`: `admin.audit.mine` (`can('audit.mine')`, input `{ limit?: 1..200, before?: number }`, output `MyAuditEvent[]`); `admin.audit.notice.get` and `admin.audit.notice.ack` (`can('authenticated')`).
- `audit.ts` (new file, exported from `index.ts`): `MyAuditEventSchema = { id, at, kind, actorName, summary, resource?: { kind, id?, count? } }`. `summary` is built in the core from the kind (English, for example "looked at 3 of your notes"). No `ip`, no `via`, no raw `detail`: a member sees who did what to what, never network facts about someone else.
- `auth-flow.ts`: `AuthRuleSchema` loses `rateLimit` and `requireAssurance`. Reading an old stored row strips them (zod default strip); `admin.auth.policy.set` input uses `AuthRuleInputSchema = AuthRuleSchema.strict()` so a new write with those keys is a 400 with the message "removed field".

### Audit kinds

| Kind | Written by | Detail |
| --- | --- | --- |
| `settings.provider.add` | `providers.put` when the connection did not exist | `{ connection, provider }` |
| `settings.provider.key` | `providers.put` when it replaced a key | `{ connection }` (never the key) |
| `settings.provider.test` | `providers.test` | `{ connection, ok }` |
| `settings.provider.remove`, `settings.model.set`, `settings.budget.set`, `settings.budget.cap`, `settings.access.set` | already over RPC; now also by offline setup with `via: 'offline'` | as today; `budget.cap` records the person id, not the typed name |
| `acl.create`, `acl.remove` | `access.ts` resource registration and removal | `{ kind, id, resourceOwner }` |
| `acl.deny` | `AclAudit.denied`, called from the plugin access port on a resource-level refusal | `{ kind, count, suppressed }` per session window (unchanged) |
| `approval.answered` | `audit/attention.ts` | adds `node`, `capability`, `command` (redacted, first 200 chars) and `remember` as applied |
| `person.notice.seen` | `audit.notice.ack` | `{ notice: 'audit-privacy' }`, `subject` = the person |
| `audit.pruned` | the running core | `via: 'local'` (was `offline`) |

### First-login notice (doc gap 3)

Text (English, shown in the person's language by the TUI only if the front agent translates it; the stored text is English): "The owner of this Keith can read what you keep in it. Every time the owner looks at something of yours, Keith writes it down, and you can read those lines under Manage > Privacy." Shown once per person, after the first successful sign-in on a TUI, as a dialog with Enter to dismiss. Seen state is the settings key `notice.audit-privacy.<personId>` (settings repo, no migration) plus the `person.notice.seen` row. The owner sees the same notice once (it explains the rule they enforce).

### Error codes

Unchanged public codes. New refusal text only: `policy field removed` (400) on `admin.auth.policy.set`. A revoke of another person's credential by a non-owner answers `NOT_FOUND` (no existence oracle).

### TUI copy

- Dialog "How this Keith treats your things" (the notice above), key hint `Enter  got it`.
- Manage > Privacy (every person): list "when / who / what", oldest at the bottom, `r` refresh; empty state "Nobody looked at your things. Lines appear here the moment someone does."
- The owner's Manage > Audit stays the whole log.

### CLI

- `keith-core audit mine <person>` (owner, offline or over the socket): prints that person's rows, so the owner can show them ("the owner can show you the lines" now has a command).
- `keith-core doctor` prints "audit.read granted to <name>: ignored since P23" for every stale grant (one line per person).

## Phases

### Phase 1 — Sign-in and credentials (security first)

Goal: one sign-in rule on every route and entry point, and no credential outlives its purpose.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P23.1.0 | Size headroom, no behaviour change (`scripts/check-size.ts` fails above 800 lines and later plans add to these files): split `packages/contracts/src/index.ts` into `export *` per area file, `packages/db/src/schema/keith.ts` into one file per area (drizzle reads `./src/schema/*.ts`, `packages/db/drizzle.config.ts:8`, no config change): `schema/settings.ts` (`config_profiles`, `catalog_cache`, `settings`), `schema/identity.ts` (`people`, `person_accounts`, `person_pair_codes`, `client_tokens`, `credentials`, `person_identifiers`, `person_secrets`, `person_grants`, `auth_attempts`, `device_requests`), `schema/audit.ts` (`audit_events`, `events`), `schema/tasks.ts` (`tasks`, `owner_reviews`), `schema/nodes.ts` (`nodes`, `pairing_codes`), `schema/acl.ts` (the four `acl_*` tables), `schema/plugins.ts` (`plugin_kv`); `schema/eh.ts` stays; `schema/keith.ts` no longer exists. Later plans cite these files, or add a new area file `schema/<area>.ts`. `apps/core/src/cli/doctor.ts` stays as a thin entry (`runDoctorChecks`, `doctorCommand`, the exit-code rules, so every import stays valid) and each check moves to `cli/doctor/checks/<name>.ts` (`database`, `loose-modes` (the `OWNED_ENTRIES` consumer), `tailscale`, `network`, `views`, `providers`; later plans add `grants`, `delivery`, `backup`, `unpriced`, `guests-proxy`, `protocols`, `succession`, `drivers`, `vision`, `sandbox`), with a table test of the exit code rules. Later plans add to the split files. | `packages/contracts/src/index.ts` and new area files, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `packages/db/src/schema/*.ts`, `apps/core/src/cli/doctor.ts`, `apps/core/src/cli/doctor/checks/` | contracts and db.md (file layout lines: the area files above) | `bun run check` green with an unchanged exports snapshot diff (names only), `doctor` cases of `cli.test.ts` unchanged | no file above 450 lines in the three places; no migration is generated (`bun run --filter @keith/db db:generate` reports nothing) |
| P23.1.1 | `/auth/login` resolves the person and identifier kind through `identifiers.lookup(candidatesOf(username))` and passes `permitted` (role + kind) and the narrowed lifetime to `password.verifyFor`; an unknown name takes the same path with no role (same work, uniform 401). `password.verify` stops hard-coding `permitted: true`. | `apps/core/src/modules/auth/login.ts`, `methods/password.ts`, `identifier.ts` | auth.md "Adapters, zones and policy" (old routes follow the same rule); closes Q-016 option A | `login.test.ts`: policy `password` with `roles: ['owner']`, member gets uniform 401 on `/auth/login` and on `/auth/flow`; owner signs in; `identifierKinds` narrowing the same | the same member is refused on both routes with the same body and audit reason |
| P23.1.2 | `sessionTerms` takes `{ role, identifierKind }` and calls `ruleFor` with them; `flow.ts` computes terms after the person is known (it already has `flow.person` and `flow.kind`); `login.ts` passes what 1.1 resolved. | `apps/core/src/modules/auth/session-terms.ts`, `flow.ts`, `login.ts` | auth.md (session lifetime comes from the rule that admits this person); REQ-029 | `sessions.test.ts`: two password rules for one zone (`owner` 1 day, `member` 30 days): each role gets its own lifetime in either rule order | order of rules no longer changes who gets which lifetime |
| P23.1.3 | PIN step-up follows the PIN rule: `/auth/step-up` reads the body first, then gates with method `pin` or `password` by the answer kind (still one uniform 403 `login_not_allowed_here`, same audit row, no oracle because the kind is in the caller's own body). | `apps/core/src/modules/auth/login.ts` (`gate` takes the method), `network-rule.parity.test.ts` | auth.md "Password, PIN and step-up" (zone rule per method) and permissions.md Step-up matrix; ADR-0027 §2 | `login.test.ts`: device session on `lan` steps up with the PIN (200); password step-up from `lan` stays 403; PIN step-up from `public` 403; `network-rule.parity.test.ts` row for step-up | a phone on the LAN confirms a sensitive call with its PIN |
| P23.1.4 | Purging an expired device request revokes the credential of an approved, uncollected one: `devices.purgeExpired` returns the credential ids it removed; `device.ts` revokes them and writes `credential.revoked` (`by: 'expiry'`). The purge also runs on the prune tick, not only at the next start. | `packages/db/src/repos/devices.ts`, `apps/core/src/modules/auth/device.ts`, `apps/core/src/compose.ts` (prune) | auth.md "Device login"; REQ-007 | `device.test.ts`: approve, never poll, advance the clock past expiry plus the purge window, run the purge: the credential no longer authenticates | no live credential without a collectable request |
| P23.1.5 | `admin.devices.revoke` and `admin.tokens.revoke` act on the caller's own credentials unless the caller is the owner; any other id answers `NOT_FOUND`. | `apps/core/src/modules/admin/procedures.ts`, `apps/core/src/modules/auth/credentials.ts` (lookup by id returns `personId`) | permissions.md (`tokens.manage`, `devices.manage` = own credentials); ADR-0027 §5 | `permissions.e2e.test.ts`: member with `tokens.manage` revokes an owner token id: `NOT_FOUND`, owner token still works; own token revokes; owner revokes any | cross-person revoke impossible |
| P23.1.6 | Offline setup and first-owner that set a PIN or password revoke the person's other sessions (all credentials except the one the same command creates) and write `person.sessions.revoked` with `via: 'offline'`. | `apps/core/src/cli/setup-steps.ts` (`saveOwnerPin`, `saveOwnerPassword`), `apps/core/src/modules/auth/local-access.ts` (`firstOwner`) | auth.md "Password, PIN and step-up" (setting a secret revokes); REQ-021 | `setup-owner.test.ts` and `local-first-owner.e2e.test.ts`: an older session stops authenticating after a setup that sets a password; first-owner's own new session survives | re-running setup to rotate a leaked session works |
| P23.1.7 | Offline `auth local set` runs the same `policyProblem` guard as the RPC (shared function exported from `admin/auth-local.ts`). The spec states plainly that the socket never reads the policy, so the guard protects the TCP sign-in the owner would be locked out of. | `apps/core/src/cli/auth-local-command.ts`, `apps/core/src/modules/admin/auth-local.ts` | auth.md "The local socket" and core-cli.md; REQ-043 | `auth-commands.test.ts`: `--trust none` with a policy that has no loopback rule is refused offline with the RPC's message | the two paths refuse the same inputs |
| P23.1.8 | Remove `rateLimit` and `requireAssurance` from the rule schema; old stored rows load without them; `policy set` and `keith-core auth policy` reject them with `policy field removed`. | `packages/contracts/src/auth-flow.ts`, `apps/core/src/modules/auth/policy-store.ts`, `apps/core/src/modules/admin/auth-policy.ts`, `apps/core/src/cli/auth-policy-command.ts` | auth.md rule fields list; contracts export snapshot (`bun scripts/check-exports.ts --write`) | `policy-store.test.ts`: a stored row with both fields loads and re-saves without them; `policy-admin.e2e.test.ts`: a write with them is 400 | no control that looks active and is not |
| P23.1.9 | Verify-only tests for the admin shell session (`keith-core login` / `logout`, `apps/core/src/cli/admin-session.ts`): the file is written with mode 0600 and `logout` revokes the credential on the server, not only the file. Add the tests if missing; change code only if a test fails. | `apps/core/src/cli/admin-session.ts`, `admin-session.test.ts` | core-cli.md (login/logout rows) | file mode 0600; after `logout` the old bearer is refused | the two rules are pinned |
| P23.1.10 | **FD10-01, high priority: ship first of this phase, right after P23.1.0.** An open stream of a revoked, suspended or demoted client is closed. New `apps/core/src/modules/thalamus/open-streams.ts`: a registry of the long-lived requests (`/activity/*`, `/sessions/*` streams, `/attention`) with `{ personId, credentialId, role, grantsVersion, controller }`. In `thalamus/app.ts` the routes that hand the request to eharness (`app.all('/activity/*', ...)`, `/sessions/*`, `/attention`) pass a request whose `signal` is a child of the registry controller, so closing aborts eharness' stream (eharness listens only to `request.signal`; no upstream change needed). Close triggers: `revokeSessions` and the single `credentials.revoke` / `tokens.revoke` (`compose-identity.ts:45`), the people service suspend, role change, transfer and remove (`people.ts:91`), and a grant or revoke of a capability (`people/grants.ts`) through one `onAccessChanged(personId)` hook. A 30 s backstop sweep re-checks the credential (expiry), the person (`active`) and the role against the values at open, the same shape as `plugins/view-socket.ts` (`stillAllowed`, fail closed). Every reconnect already resolves the principal again; a `resync` request is re-authorised before the feed answers. The same hook emits the activity record `identity.changed` (schema `IdentityChangedRecordSchema` in `packages/contracts/src/activity.ts`, no payload beyond `personId` and `reason`) on the person's front session id, from the people and auth services (grant, revoke, suspend, role change, `can_login`, credential revoke), so `activityFilter` shows it to that person only; P27.3.6 only consumes it. The client side needs nothing new for the close: a closed stream reconnects, gets a 401 and the monitor goes `logged-out` (`packages/client/src/connection-monitor.ts`). | `apps/core/src/modules/thalamus/open-streams.ts` (+ test), `apps/core/src/modules/thalamus/app.ts`, `apps/core/src/compose-identity.ts`, `apps/core/src/modules/people/people.ts`, `apps/core/src/modules/people/grants.ts`, `apps/core/src/modules/auth/credentials.ts`, `apps/core/src/modules/thalamus/activity-filter.ts` (comment only), `packages/contracts/src/activity.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | thalamus.md (Activity feed: an open stream ends when its principal stops being valid; the `identity.changed` record, which the table of P27.1.4 lists), auth.md ("stops working at once" includes open streams), tui.md (the fake `core.revoke()` now mirrors the real core) | `open-streams.test.ts`; real-core `activity-revoke.e2e.test.ts` (scripted models, real HTTP): a member and an owner open the feed; revoke by `devices revoke`, suspend, role change, grant change and `transferOwner` (the former owner's stream) each end the stream within one second and the reconnect gets 401 (or a fresh filter after a grant change); an unrelated person's stream stays open; a stream of an expired credential ends on the sweep; each of those changes emits one `identity.changed` record on the affected person's own session id and on nobody else's | no record reaches a client after its credential, person or role stopped being valid |
| P23.1.11 | **FD10-02 (terminal escapes).** Strip control and escape sequences from every server-supplied string at render. `stripControl(text, { newlines })` removes C0 and C1 controls, ESC sequences (CSI, OSC including OSC 52, DCS), DEL and bidirectional overrides (U+202A to U+202E, U+2066 to U+2069); it keeps `\n` only where asked and never `\r`. Canonical copy in `packages/cli/src/sanitize.ts`, used by `printTable` and every `stdout.write` of server text in `keith-core` (`devices list`, `devices approve`, `people list`, `groups`, `audit`, `guests list`); `packages/ui` has its own copy (no workspace imports, `packages/ui/AGENTS.md`) in `src/safe-text.ts`, applied inside `Txt`, `Message`, `Markdown`, `ListRow` and `Field` so no feature can draw a raw server string (device labels, person names, group names, node names, task text, guest text). The device label is validated at the source: `DeviceStartRequestSchema.label` trims and refuses control characters and bidi marks (400), and `device.ts` stores the trimmed value; rows already stored are cleaned at render only. P24.5.5 covers the guest peek text on the server side. | `packages/cli/src/sanitize.ts`, `packages/cli/src/output.ts`, `packages/cli/src/index.ts`, `packages/ui/src/safe-text.ts`, `packages/ui/src/text.tsx`, `message.tsx`, `markdown.tsx`, `list-row.tsx`, `field.tsx`, `packages/contracts/src/admin.ts:82`, `scripts/exports.snapshot.json`, `apps/core/src/modules/auth/device.ts`, `apps/core/src/cli/auth-commands.ts` | auth.md (Device login: label rules), cli.md (Rules: server text is stripped), tui-design.md and `packages/ui/AGENTS.md` (one rule: draw server text only through the primitives), guests.md | `sanitize.test.ts` and ui `safe-text.test.ts` share one table of cases (CSI `ESC [ 2 J`, OSC 52 clipboard write, C1 `0x9b`, bare `\r`, U+202E, an embedded newline that forges a table row); `login.test.ts` (a label with ESC answers 400, a forged-row label answers 400); a TUI Devices snapshot with a hostile stored label draws it inert | `devices list` never shows a forged row; no escape sequence from a stranger reaches the terminal |
| P23.1.12 | **FD10-05.** `keith login --token` checks the credential before it saves it: `whoOf(core, token)` first; a 401 or an unknown credential refuses (`CliError`, exit 1, "<core> did not accept that credential; nothing was saved") and leaves the previous `client.json` untouched; an unreachable core refuses too unless `--no-check` is given. Only a checked credential is written, and the success line names the person. | `apps/tui/src/commands.tsx` (`login`, the `write` closure), `apps/tui/src/login-view.ts` | tui.md:24 (the text login checks through `auth.whoami`, then saves), client.md sign-in controller | `commands.test.ts`: wrong token against a fake core keeps the old file byte for byte and exits 1; right token writes and prints the name; unreachable core without `--no-check` refuses | a mistyped token cannot replace a good login |
| P23.1.13 | **FD10-09.** A sign-in that is not "remembered" leaves no long session behind: its server lifetime is capped (idle 12 h, absolute 7 days, the PIN rule's numbers) whatever the rule says, and the TUI revokes it on a clean quit (`auth.logout`, best effort, 2 s timeout, not for remembered credentials). | `apps/core/src/modules/auth/session-terms.ts`, `apps/tui/src/app-session.tsx`, `apps/tui/src/use-session-actions.ts`, `apps/tui/src/app-root.tsx` (unmount hook) | auth.md Sessions (lifetime of a non-remembered sign-in), tui.md:66 | `sessions.test.ts`: password rule with 30 days, `remember: false` gets 12 h and 7 days, `remember: true` keeps the rule; `app-root.test.tsx`: quitting calls `auth/logout` once for a memory-only credential and never for a remembered one | `keith-core sessions list` does not fill with dead sessions |
| P23.1.14 | **FD10-11.** The console's "Start core" makes the same owner sign-in offer as `start`: `ensureOwnerSignIn` runs before `startCore` (after the Ink screen has returned). | `apps/core/src/cli/console.tsx`, `apps/core/src/cli/start.ts` (export only), `apps/core/src/cli/console.test.tsx` | core-cli.md:35 and :47 | `console.test.tsx`: owner with no PIN or password, choose start: the offer is asked once; with a PIN set it is not asked | the console and `start` agree |
| P23.1.15 | **FD10-13.** Secrets are never trimmed: `askHidden` stops calling `.trim()` (it removes only the line ending of piped input); the CLI, the TUI forms and the sign-in controller all send the typed text as it is. PIN and password rule messages name a leading or trailing space when that is the problem. | `packages/cli/src/prompts.ts:53`, `apps/core/src/modules/auth/password-rules.ts`, `apps/core/src/cli/people-commands.ts` (stdin reads) | cli.md (Rules), password-rules header comment ("spaces and paste are fine"), core-cli.md | `prompts.test.ts`: "pass phrase " keeps its trailing space interactively and by `--password-stdin` (only `\n` and `\r\n` removed); `password-rules.test.ts` | the same phrase signs in from the CLI and from the TUI |
| P23.1.16 | **FD11-05.** A username may not be digits only: `USERNAME_RE` becomes `/^(?![0-9._-]+$)[a-z0-9][a-z0-9._-]{1,31}$/` (at least one letter), so it can never equal a phone alias. Person create and rename also refuse a username equal to an existing `person_identifiers.value_norm` or id, in the same transaction as the insert (defence in depth). Existing digits-only usernames keep signing in; `doctor` lists them as a `!` note. | `packages/contracts/src/people.ts:12`, `apps/core/src/modules/people/people.ts`, `packages/db/src/eh/person-store.ts`, `apps/core/src/cli/doctor.ts` (after P23.1.0: `cli/doctor/checks/`) | people.md (Usernames), auth.md (identifier-first lookup order) | `people.test.ts` and `person-store.test.ts`: `6281234567890`, `007` refused; `a1`, `ana` accepted; a rename to an alias value refused; Ana's phone sign-in still resolves to Ana; doctor note for an old digits-only name | no sign-in identifier can resolve to two people |
| P23.1.17 | **FD10-16.** `keith-core people remove` and `people transfer-owner` ask before they act, like the TUI Manage screen: remove asks "remove <username>? [y/N]" (`confirm` of `packages/cli`; no retention words here: the 30 day keep is worded by P26.3.2), transfer-owner asks to type the new owner's username; `--yes` skips the question; without a terminal and without `--yes` the command refuses (UsageError). | `apps/core/src/cli/people-commands.ts` (`remove`, `transfer-owner`), `packages/cli/src/prompts.ts` (`confirm`, existing), `docs/manual-testing.md` (commands that now take `--yes` in scripts) | core-cli.md (people rows), cli.md | `cli.test.ts` people cases: a no answer changes nothing, `--yes` acts, no terminal without `--yes` exits 2; a typed name that differs from the target refuses | a mistyped username cannot remove or promote someone |

`bun run check` passes; `bun run smoke` (device login, member password login, step-up).

### Phase 2 — Audit visibility (privacy)

Goal: only the owner reads the whole log; every person reads the lines about themselves.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P23.2.1 | `audit.read` becomes owner only: add to `OWNER_ONLY_CAPABILITIES`; `grants.grant` refuses it; `doctor` lists stale grants; the people capability list in the TUI hides it for members. | `packages/contracts/src/capabilities.ts`, `apps/core/src/modules/people/grants.ts`, `apps/core/src/cli/doctor/checks/grants.ts` (new, listed in the table of `cli/doctor.ts`), `apps/tui/src/features/manage/people/` | permissions.md Capabilities and Roles and grants; people.md grants; ADR-0027 §6 | `people-guard.test.ts` and a new `capabilities.test.ts` case: grant refused, an old stored grant is ignored (`audit.list` is FORBIDDEN for the holder), doctor prints the line | a member with a leftover grant reads nothing |
| P23.2.2 | Canonical `subject` and `resourceOwner` keys on rows (see Design); the people, credential and ACL record helpers add them. | `apps/core/src/modules/people/people.ts`, `secrets.ts`, `grants.ts`, `aliases.ts`, `apps/core/src/modules/auth/credentials.ts`, `apps/core/src/modules/acl/access.ts`, `apps/core/src/modules/audit/acl-audit.ts` | auth.md Audit table; acl.md Audit | `audit.test.ts` (helper adds the keys), `access.test.ts` (share/chown rows carry `resourceOwner`) | every row about a person has `subject` |
| P23.2.3 | `AuditRepo.listFor(personId, { limit, before })` using `json_extract` over the fields that `AUDIT_SUBJECT_FIELDS` names for each kind (plus `subject`, `resourceOwner`, `owner`, `personId` for old rows), with a bound on the rows scanned per call; `admin.audit.mine` handler builds `MyAuditEvent` with `actorName` and an English `summary` from `registerMySummary`, drops everything else; create the registry in `packages/contracts/src/audit.ts` and `modules/audit/mine.ts` (see Design, Subject registry). | `packages/db/src/repos/audit.ts`, `apps/core/src/modules/audit/audit.ts` (new `mine.ts` next to it), `apps/core/src/modules/admin/procedures.ts`, `packages/contracts/src/audit.ts`, `contract.ts`, `capabilities.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | permissions.md (`audit.mine`); auth.md Audit; `docs/sharing-and-privacy.md` | `audit.test.ts` (repo filter, the scan bound), new `mine.test.ts`: every kind written with a subject has a summary or is listed as hidden; member sees the owner's `acl.owner-access` rows for their notes and a `person.secret.set` about them; never another person's rows; never `ip` or `via` | the promise of sharing-and-privacy.md is a real call |
| P23.2.4 | Client method and TUI panel: `client.audit.mine()`; Manage > Privacy for every person (members get the Manage screen with only the sections they may open); owner CLI `keith-core audit mine <person>`. | `packages/client/src/client.ts`, `apps/tui/src/features/manage/audit/` (adds `use-my-audit.ts`), `apps/tui/src/features/manage/sections.ts`, `apps/core/src/cli/admin-commands.ts`, `apps/core/src/cli/console*.tsx` (test only) | tui.md Manage; core-cli.md Commands | `section-view.test.tsx`, `manage-state.test.ts` (member sees Privacy, not Audit), a render test that a member never reaches an owner-only manager section through the `keith-core` console (`cli/console*.tsx`), `auth-commands.test.ts`, a CLI-versus-RPC parity test (every `people`, `groups`, `acl`, `plugin`, `guests`, `reviews` subcommand maps to one procedure with the same capability and step-up flag read from `contract.ts` meta) | a member opens Privacy and reads their lines |
| P23.2.5 | First-login notice: `audit.notice.get/ack` (settings key per person plus `person.notice.seen` row); TUI dialog after the first sign-in; never shown twice, also not after another sign-in on another device. | `packages/contracts/src/contract.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `apps/core/src/modules/admin/procedures.ts`, `apps/tui/src/features/identity/` (new `privacy-notice.tsx`), `apps/tui/src/app-root.tsx` (mount point) | tui-login.md (after sign-in), sharing-and-privacy.md; ADR-0015 consequence | `apps/tui/src/features/login/login.test.tsx`: dialog appears once, `Enter` acks; `procedures` test: second `get` says seen | each person is told once and it is on record |

`bun run check` passes.

### Phase 3 — Audit completeness

Goal: every change and every approval leaves a row that says what happened.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P23.3.1 | Offline setup audits provider add/key/remove, roles, budget, access and `setup.done` with `via: 'offline'` (same kinds as the RPC); the text "not audited in P8" is replaced. | `apps/core/src/cli/setup-steps.ts`, `setup.ts`, `setup-apply.ts`, `apps/core/src/modules/admin/offline.ts` (the offline admin carries `audit`) | auth.md Audit ("Documented exception" becomes the rule); ADR-0027 §7, Q-013 | `setup-owner.test.ts`: a headless setup writes one row per change and none holds a key; the wizard model output and `--non-interactive` write the same settings and the same audit rows | setup is as visible as RPC |
| P23.3.2 | Distinct `settings.provider.add` / `settings.provider.key`; `providers.test` writes `settings.provider.test`; `budget.setPersonCap` records the person id; the running core's `audit.pruned` says `via: 'local'`. | `apps/core/src/platform/rpc.ts` (AUDITED table), `apps/core/src/modules/providers/router.ts`, `apps/core/src/modules/audit/retention.ts`, `apps/core/src/compose.ts` | auth.md Audit | `rpc` audit test, `retention.test.ts` (via), `service.test.ts` | an edit of a key is not recorded as an add |
| P23.3.3 | Write `acl.create` and `acl.remove` in `access.ts` and wire `AclAudit.denied` from the plugin access port (resource-level refusal); function-level refusals stay `plugin.denied`. | `apps/core/src/modules/acl/access.ts`, `apps/core/src/modules/plugins/access-port.ts`, `packages/host/src/ctx.ts` (session key passed so the window keys on the session) | acl.md Audit | `access.test.ts`, `acl-audit.test.ts` (denied count per window), `adapter.test.ts` | a member probing ids leaves an `acl.deny` row |
| P23.3.4 | The approval row carries node, capability, command (redacted, 200 chars) and the remember scope that was applied, not requested: amygdala exposes `describeApproval(sessionId, attentionId)` and the effective answer from `parseAnswer`; the audit hook reads them. | `apps/core/src/modules/audit/attention.ts`, `apps/core/src/modules/amygdala/attention.ts` | amygdala.md `/attention` and auth.md Audit; REQ-092 | `amygdala.test.ts` and `audit.test.ts`: owner answers a member's `shell.exec` with `remember: 'session'`: the row says `remember: 'once'` and names the node and command | the row says what was approved |
| P23.3.5 | Verify that opening a plugin view is audited (REQ-094): add the test if missing, change code only if it fails. | `apps/core/src/modules/plugins/view-audit.ts`, `view-audit.test.ts` (or `modules/audit/audit.test.ts`) | plugins.md (views), auth.md Audit | opening a plugin view writes the row with `subject` and the plugin id, no content | the row exists and the test pins it |
| P23.3.6 | Smoke block for phases 1 to 3 (P22 rule: a step writes it) | `scripts/smoke/identity-access.ts` (a one-line hook in `scripts/smoke.ts`) | docs/manual-testing.md (the P23 scenarios) | `bun run smoke`: a device session on the LAN header steps up with the PIN, an offline setup that sets a password rotates the person's sessions, `audit.mine` returns the member's own row and never another person's | `bun run smoke` stays near 40 s and passes |

`bun run check` passes; `bun run smoke` (setup, shell approval, audit row).

### Phase 4 — Documentation truth (last, wording)

Goal: the written rules match the code.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P23.4.1 | Verify-only (F-005): the docs pass of Nov 10 already says owner self-share is allowed (acl.md Changing access and Audit, sharing-and-privacy.md); check the sentences still match the code after Phases 2 and 3 and edit only if they differ; the share or chown row (with `resourceOwner`) is the audit trail. | `docs/specs/acl.md` (Changing access, Audit), `docs/sharing-and-privacy.md`, `docs/specs/plugins/notes.md` ("The instance owner") | ADR-0027 §8 | none (docs); `access.test.ts` already covers the row from 3.3 | no document promises what the code allows |
| P23.4.2 | Verify-only (F-050): the docs pass already rewrote the role-change sentence (`setRole` accepts only `member`; ownership moves by `transferOwner`, which revokes both people); check `auth.md` and `people.md` against the code and edit only if they differ. | `docs/specs/auth.md`, `docs/specs/people.md` | REQ-021 | none | sentence matches code |
| P23.4.3 | Rewrite the audit paragraph of `docs/sharing-and-privacy.md` (Privacy panel and `keith-core audit mine`), SECURITY.md audit section, ARCHITECTURE.md identity paragraph; add the P23 scenarios of "Owner to run" to `docs/manual-testing.md`; mark the P23 row done in the P22 roadmap table. | `docs/sharing-and-privacy.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/manual-testing.md`, `docs/plans/active/P22-one-keith-foundations.md` | newest source wins (ADR-0027 §1) | none | the member page names the real path |
| P23.4.4 | Trace-only (no planned code): read the code and cite or add a test for REQ-041, REQ-051 to REQ-053 and REQ-246 (the local socket, host allowlist and proxy trust). Add a row to the Traceability table of P32 phase 1 when a defect shows. | `apps/core/src/modules/auth/local-access.ts`, `apps/core/src/modules/thalamus/`, the nearest existing tests | auth.md (local socket, host allowlist) | the cited or new test per id | each id has a file and a test, or a finding row |
| P23.4.5 | **FD10-10.** `doctor` never prompts: `viewsCheck` connects with `{ prompt: false }`; a 401 or a locked socket becomes a `!` note ("views: needs an admin session, run keith-core login"), never a PIN question and never a `✗`. | `apps/core/src/cli/doctor.ts:137` (after P23.1.0: `cli/doctor/checks/views.ts`), `apps/core/src/cli/context.ts:59`, `apps/core/src/cli/admin-session.ts:77` (`askHidden` becomes an option) | core-cli.md:49 | `cli.test.ts` doctor: piped stdin is never read, trust `none` with no session gives the note and the same exit code as before | a cron `doctor` cannot be answered by its own input |
| P23.4.6 | **FD10-15.** `doctor` opens the database read only and writes nothing: `openOfflineAdmin({ readOnly: true })` opens SQLite read only, builds the vault without creating `secret.key` (`createVault` gets `create: false`), and skips the `settings.unreadable` audit rows; a stored key that this process cannot read (the key lives only in the service's environment) is a `!` note "doctor cannot read the key the core uses: run it with the same KEITH_SECRET_KEY", not a `✗`. | `apps/core/src/cli/doctor.ts:237` (after P23.1.0: `cli/doctor/checks/providers.ts`), `apps/core/src/modules/admin/offline.ts`, `apps/core/src/platform/vault.ts:20`, `apps/core/src/platform/db.ts` | core-cli.md:49 (doctor is read only), db.md | `cli.test.ts` and `offline-unreadable.test.ts`: a different `KEITH_SECRET_KEY` gives the note, exit 0, no audit row, no `secret.key` in an empty folder | `doctor` leaves no trace in the live log or the folder |

`bun run check` passes.

## Exit criteria

- [x] No "Changes in P23" marker of this plan is left in `docs/specs` (`grep -rn "Changes in P2" docs SECURITY.md README.md`, lines that name P23): the step that lands the code rewrites the sentence in present tense.
- [x] Specs updated in the same commits: auth.md, permissions.md, people.md, acl.md, core-cli.md, tui.md, tui-login.md, plugins/notes.md.
- [x] Contracts: `audit.mine`, `audit.notice.*`, capability changes, rule schema; exports snapshot regenerated.
- [x] `bun run check` passes; `bun run smoke` passes after Phases 1 and 3 (new blocks go in `scripts/smoke/identity-access.ts`, hooked from `scripts/smoke.ts`).
- [x] Manual scenarios under "Owner to run" done.
- [x] `docs/sharing-and-privacy.md`, SECURITY.md and ARCHITECTURE.md match; P22 roadmap row marked done.
- [x] Every id in the Traceability table points at a merged step.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Owner sessions break when `audit.read` leaves the grantable set | Owner role keeps it; only grants to members are ignored; doctor lists them first so nobody is surprised |
| `/auth/login` narrowing locks out a member whose username is an alias kind not allowed by the rule | The identifier lookup is the same as `/auth/flow`; the refusal is the uniform 401 and the audit reason names the rule |
| `json_extract` scan gets slow on a large audit table | Retention bounds the table; `before` cursor and `limit` 200; later generated column is an additive migration |
| Step-up zone change opens PIN step-up on LAN (plain HTTP) | ADR-0027 §2 accepts it because PIN sign-in is already allowed there; the PIN never confirms for a PIN-made session (rule kept) |
| A member sees "who" the owner is | They know already; no network facts are exposed |

## Traceability

| Id | Closed by step |
| --- | --- |
| F-006, Q-016, REQ-024 (role and kind at verify) | P23.1.1 |
| F-028, REQ-029 | P23.1.2 |
| F-031, Q-011, REQ-018, REQ-034 | P23.1.3 |
| F-014, REQ-007 | P23.1.4 |
| F-015, permissions.md `tokens.manage` / `devices.manage` row | P23.1.5 |
| F-029, REQ-021 (offline setup) | P23.1.6 |
| F-030, REQ-043 | P23.1.7 |
| F-047, REQ-024 (policy fields) | P23.1.8 |
| F-018, Q-014 (owner-only `audit.read`) | P23.2.1 |
| F-018, Q-014 (`audit.mine`), REQ-085, REQ-070 (member can see owner access) | P23.2.2, P23.2.3, P23.2.4 |
| doc gap 3 (first-login notice) | P23.2.5 |
| F-044, Q-013, REQ-091 | P23.3.1 |
| F-045 | P23.3.2 |
| F-046, REQ-089 | P23.3.3 |
| F-035 | P23.3.4 |
| F-005 (verified), REQ-073, REQ-086 (share half), REQ-070 (self-share trail) | P23.4.1 (verify) with P23.2.2 and P23.3.3 (row) |
| F-050 (verified), REQ-021 (role change) | P23.4.2 (verify) |
| REQ-094 | P23.3.5 |
| REQ-041, REQ-051 to REQ-053, REQ-246 (trace only) | P23.4.4 |
| Size gates (file split before growth) | P23.1.0 |
| Admin shell session (R4, verify) | P23.1.9 |
| ADR-0027 §2 | P23.1.3 |
| ADR-0027 §4 | P23.1.1, P23.1.2 |
| ADR-0027 §5 | P23.1.4 to P23.1.8 |
| ADR-0027 §6 | P23.2.1 to P23.2.5 |
| ADR-0027 §7 | P23.3.1 to P23.3.4 |
| ADR-0027 §8 | P23.4.1 |
| Recon rows covered elsewhere | REQ-065 (P21), REQ-064 (P26.3.4, ADR-0027 §27), REQ-086 reminders half and OWN-008 (P24), REQ-115 and REQ-109 (P26) |
| FD10-01 (live feed after revoke, suspend, role or grant change), auth.md "stops working at once" | P23.1.10 |
| FD10-02 (terminal escapes from device labels and server text; guest peek half in P24.5.5) | P23.1.11 |
| FD10-05 (`login --token` saves unchecked text) | P23.1.12 |
| FD10-09 (non-remembered sessions outlive the process) | P23.1.13 |
| FD10-11 (console start skips the owner sign-in offer) | P23.1.14 |
| FD10-13 (secret prompts trim) | P23.1.15 |
| FD11-05 (username shadows a phone alias) | P23.1.16 |
| FD10-16 (CLI `people remove` and `transfer-owner` confirm; decision of the second round) | P23.1.17 |
| FD10-10 (doctor asks for the PIN) | P23.4.5 |
| FD10-15 (doctor writes while the core runs) | P23.4.6 |

## Owner to run

Use `bun run manual:setup`, `manual:core`, `manual:admin`, `manual:tui` (KEITH_HOME=.data/test, docs/manual-testing.md).

1. Policy narrowing: `keith-core auth policy` set a password rule with `roles: owner` for loopback. Sign in as a member with the password through the TUI and through `curl -X POST /auth/login`: both refused with the same 401. The owner signs in on both.
2. PIN step-up on LAN: sign in a second device by device code from a LAN address, run a sensitive command (for example `keith people grant`), confirm with the PIN: works. Confirm with the password from LAN: refused.
3. Uncollected device: start a device login, approve its code, never poll; restart core after the expiry hour; `keith-core` token list shows the credential revoked.
4. Revoke scope: grant a member `tokens.manage`; as that member try to revoke the owner's token id: refused as not found.
5. Setup rotation: sign in on the TUI, run `keith-core setup` offline and set a new password; the old TUI session needs a sign-in again.
6. Audit: grant a member `audit.read` (refused). As the owner open a member's note (`reminders` or notes view); as that member open Manage > Privacy: the owner's look is listed.
7. First login: create a member, sign in on the TUI: the privacy dialog shows once; sign out and in again: it does not return.
8. Setup audit: change the model role by `keith-core setup`, then read `keith-core audit` as the owner: a `settings.model.set` row with `via: offline`.
9. Approval row: ask the member's agent to run a shell command on a node, approve as the owner with "allow for task": the audit row names the node and command and says the scope applied was `once`.
10. Live feed (FD10-01): open `keith` as a member in one terminal; as the owner run `keith-core devices revoke <id>` for that member's device (or `people suspend`). The member's TUI shows the signed-out state within a second; no new activity arrives. Repeat with a grant change: the feed reconnects with the new filter.
11. Hostile text (FD10-02): start a device login with the label `ok<ESC>[2J`; `keith-core devices list` shows the label without the escape and `POST /auth/device/start` with a control character in the label answers 400.
12. Safe prompts (FD10-13, FD10-16): `keith-core people passwd <member>` with a passphrase that ends in a space, then sign in with it from `keith login --password`: works. `keith-core people remove <member>` asks first; `--yes` skips the question.

## Gate evidence (Nov 10, 2026)

- Commits 12a6bac (P23.1.0 split) to ff02bf6 (docs) plus follow-ups (a12c244 lint, f85254b people tests `--yes`, 2a1484b budget cap summary).
- `bun run check`: 2767 tests pass, check-imports, check-size, check-exports ok. `bun run smoke`: SMOKE PASS, 56 steps (the P23 block is `scripts/smoke/identity-access.ts`).
- Deviations recorded by the implementers: P23.1.9 (the admin session file is gone, the test pins server-side revoke instead); P23.3.5 (the view-open row has no `subject` or plugin key, the plugin id is the `viewId` prefix, matches auth.md); `acl.create`/`acl.remove` are written by the host ACL proxy (`packages/host/src/acl-audited.ts`) because plugins create resources; `providers.put` audit moved into the router (it needs the prior state); an edit of label or enabled alone writes no row; the unmount-time revoke on quit is fire and forget (the `/quit` path waits).
- Owner-access audit keeps its 10 minute window per session and resource (acl.md:132), a batch is one row with a count.

## Not verified

- By eye on a real terminal: the Privacy panel, the first-login notice dialog, the Manage screen for a member.
- Smoke step "guests: a cap hit is 429 ..." failed once with "Unable to connect" and passed on the rerun (a race between the 2 s listener poll and the step; not caused by P23, worth hardening in P32).
- `bun run smoke` does not express a LAN peer, so the PIN step-up from `lan` is covered by unit tests only.
