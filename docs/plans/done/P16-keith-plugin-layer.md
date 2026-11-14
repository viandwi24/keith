# P16 — The Keith plugin layer, Notes and Reminders

Nov 8, 2026 · status: **done, all 11 steps (Nov 9, 2026)** · ADR-0016 · specs touched: new `plugins.md`, `plugins/notes.md`, `plugins/reminders.md`; `permissions.md`, `db.md`, `thalamus.md`, `core-cli.md`, `tui.md`
Order: P14 -> P15 -> **P16** -> P17 -> P18. Needs: `Actor` (P14), `Acl`, `visibleIds` and the leak kit (P15). Gives P17 the `audience: 'public'` rule and P18 the manifest `tui` slot.

## Goal

A plugin author writes `defineKeithPlugin({...})` with operations; the host derives the AI tools, HTTP routes with OpenAPI, inter-plugin calls and UI data from them, and
every call passes one guard. Notes and Reminders are the first plugins and use no privileged path.

## Verified starting point

- `packages/host/src/index.ts` is `export {}`; `plugins/` has only a README; the workspace globs include `plugins/*` (`package.json` workspaces); the import rule `plugins-only-host-contracts` exists.
- Migrations: `packages/db/src/connection.ts` runs `migrate(..., { migrationsFolder })` only from `bun run db:migrate`; `assertMigrated` counts rows in `__drizzle_migrations`
  against `meta/_journal.json` and refuses an old file. **The plugin research said "the core runs migrations at boot": that contradicts the code;** plugin migrations follow the core rule.
- drizzle-orm 0.45.4 `MigrationConfig` has `migrationsTable` and `migrationsSchema` (type declaration read); whether the bun-sqlite migrator honours it end to end is unverified.
- zod 4.6.7 exports `toJSONSchema`; hono 4.13.14 is the HTTP layer.
- `budget.scopes(ctx)` (`modules/budget/budget.ts`) reads `ctx.principal?.id`; the principal is an open JSON object, so extra accounting keys are possible.
- `eharness/scheduler` ships (export `./scheduler`; spec 29 says Draft; `eharness/sqlite` has `schedules.ts`). `fire` may return `{ fired: false }` (slot handled, nothing fired). Keith uses no scheduler today; `modules/tasks/reminder.ts` is a prompt reminder of active tasks, not a scheduled one.
- `/attention` carries approvals only (`thalamus.md`); there is no generic owner queue yet.
- eharness: the function form of a tool is resolved once per session; `defineToolSource({ refresh: 'turn' })` re-lists each turn; `principal` is a live getter (research, spec 01; re-verify in step 2).

## Decisions taken (ADR-0016)

| Question | Decision |
| --- | --- |
| Shape | `defineKeithPlugin`, compiled to one eharness plugin `k-<id>` plus one tool source |
| Centre | Operations registry; tools, routes (+OpenAPI), `k.call` and UI data derive from it |
| Guard | actor -> audience -> capability -> ACL -> review -> rate limit -> audit -> run |
| Context | Built per call from the live principal; actor re-read from the DB |
| Guests | Reachable only if `audience: 'public'`; default empty |
| Tier | T1 trusted code; honest wording, no sandbox claim |
| Storage | `plg_<id>_*`, per-plugin migrations table, applied by `db:migrate`, drizzle-kit per plugin |
| Capabilities | Plugins register ids into the closed set; owner sees them |
| Review queue | Host facility, table `owner_reviews`, replay as the requester on approval, expiry 7 days, at most 10 pending per requester |
| Reminder billing | Creator pays: the fire turn carries `principal: { id: recipient, billTo: creator }`; `budget.scopes` charges `billTo ?? id`. `billTo` is an accounting key only, never authority; the host re-checks the creator's right at fire time |
| Scheduling | `eharness/scheduler` with its SQLite store; `fire` re-resolves creator and recipient, returns `{ fired: false }` plus an audit row when skipping |
| Notes/Reminders | Plugins in `plugins/notes`, `plugins/reminders`; not brain-region modules |

## Non-goals

Third-party install flow, subprocess or MCP tier, hot reload, plugin-defined auth methods (a plugin that mints sessions is root-equivalent), plugin websockets, TUI views (P18),
moving `tasks` or hippocampus into plugins, a Notes-to-memory merge, mail or channel delivery for reminders (a later `delivery` option).

## Design in brief

**Manifest** (`@keith/host`): `id` (kebab, at most 24 chars), `version`, `apiVersion: 1`, `requires`, `provides`, `permissions`, `config` (zod, rendered as a form per ADR-0007),
`storage { schema, migrations }`, `resources` (ACL kinds and bit meaning), `operations`, `events`, `schedules`, `start(ctx)` (boot, once per process, returns stop), `hooks`
(`onPersonRemoved`, `onShareChanged`). The slot `tui: { menu, views }` is reserved and validated but unused until P18.

**Operation:** `{ name, description, input, output, permission, audience, risk?, review?, expose?: { ai, http, call }, run(input, k) }`. The model name is `<plugin>_<op>`; a collision is a boot error.
HTTP: `POST /plugins/<id>/<op>`, auth by the usual bearer, OpenAPI document at `/plugins/openapi.json` built from the visible operations of the caller.

**Context `k`:** `actor`, `session { id, kind: front | worker | wake | schedule | api, method, elevated }`, `acl`, `caps`, `db`, `kv`, `config`, `audit`, `clock`, `schedule`, `services`,
`call`, `notify`, `signal`. Session facts are recorded by the core at turn start (a `TurnAuth` map keyed by turn id or `send` runtime), never read from the durable principal.

**Visibility of tools** depends only on actor-level facts (role, grants, enabled), not on ACL state, so the prompt cache stays stable per session. Every `run` re-checks; the model naming a hidden
operation is refused with "not found or not permitted".

**Folder layout** (`plugins/<id>/`): `plugin.ts` (the only file the loader imports), `operations/*.ts`, `schema.ts`, `migrations/` (generated), `config.ts`, `*.test.ts`, `README.md`,
`package.json` (workspace package, `catalog:` versions). Host re-exports `sqliteTable`, column helpers and `z` from `@keith/host/schema` so the import rule stays literal.

**Reminders flow:** `reminders_create({ text, at | cron, tz?, to? })`.
- owner, any `to`: direct. Self: direct. User A for B: guard stores a review, answers "sent to the owner for review".
- Fire (scheduler callback): re-resolve creator and recipient; skip if either is suspended or gone, or the creator lost the right (audit `reminder.skipped` with the reason); else inject a wake turn
  into `front:<recipient>` with the principal above. The text is framed as data from `<creator>`, never as an instruction.
- Rate limit per creator, cap on recipients, and the creator's budget is charged; a refusal by budget skips and audits.

**Notes:** `notes_create|get|update|delete|list|search|share|unshare|shares`; delete is owner-only; list and search use `visibleIds` before FTS; results from other authors carry `by: <name>`.

## Steps (one commit each, in order; `bun run check` green after each)

1. **Spec and types.** _Done, commit `97c82bc`._ `docs/specs/plugins.md` (manifest, operation, guard order, context, layout, storage, tiers); manifest and operation validation (ids, names, collisions, `apiVersion`); `defineKeithPlugin`
   with tests, no core wiring. Scope `host`.
2. **Guard pipeline and testing kit.** _Done, commit `156aee0`._ `createGuard`, `KeithCtx` builder, `@keith/host/testing` (`fakeActor`, memory ACL, fake clock). Tests: **staleness** (two principals through one session-resolved tool get two actors),
   suspended person refused, guest refused unless public, rate limit, audit row. Scope `host`.
3. **Compile to eharness and load.** _Done, commit `8bc3c8a`._ Adapter to `definePlugin` plus `defineToolSource({ refresh: 'turn' })`; `tool.approve` for audience and capability; core loader reading a static built-in list,
   an `enabled` setting per plugin, boot isolation of a failing plugin. Specs `plugins.md`, `thalamus.md`. Scope `core`.
4. **HTTP and OpenAPI.** _Done, commit `e5bc223`._ Routes mounted under `/plugins/<id>/`, the same guard, `toJSONSchema` document, golden-file test. Capability registration into the closed set; fix the "every procedure has a known capability" test to take runtime ids. Scope `core`.
5. **Storage.** _Done, commit `ec510f0`._ Scoped Drizzle handle, `plugin:db:generate <id>` script (a drizzle config per plugin), `db:migrate` iterates plugins with `migrationsTable: '__plg_<id>_migrations'`, `assertMigrated` checks them; copy-of-real-DB migration test. `check-imports` gains `plugins-no-node-builtins`,
   `plugins-no-cross-plugin` (only `services`/`call`) and "plugins never import `@keith/db`"; `check-exports` and `check-size` cover `plugins/`. Specs `db.md`. Scope `db`.
6. **Services, events, calls.** _Done, commit `43e1670`._ `provides`/`requires` order check at boot, typed events on the activity feed with the per-actor filter, `k.call` through the same guard. Scope `host`.
7. **Owner review queue.** _Done, commit `f24c4d4`._ Table `owner_reviews`, host API, owner list and decide in the attention list and `keith-core reviews list|approve|deny`, audit, expiry sweep, cap per requester. Specs `plugins.md`, `core-cli.md`. Scope `core`.
8. **Notes plugin.** _Done, commits `fe53431` (`billTo` in the budget), `85d1481` (schedule store), `92a8fc3` (host services and Notes)._ All operations, FTS5 table, tests including the P15 leak kit with three actors, share and unshare, `spec plugins/notes.md`. Scope `host`.
9. **Reminders plugin.** _Done, commit `0df0f3e`._ Scheduler wiring, the principal with `billTo`, review rule, skip-and-audit, rate limits; scripted-model tests for wake principal and billing; spec `plugins/reminders.md`. Scope `host`.
10. **Operator surface.** _Done, commit `fd3a4e3`._ `keith-core plugin list|show|enable|disable`, Plugins and Reviews sections in `keith manage`, plugin capabilities grantable to one person (`admin.people.grant`, `auth.whoami`, `admin.capabilities.list`). Scope `core`.
11. **Docs and proof.** _Done (this commit)._ `docs/manual-testing.md` scenario 14, the `plugins` smoke steps (`scripts/smoke/plugins.ts`), the dated addendum to the P15 gate, plan to `done/`. Scope `repo`.

## Risks

- **Actor staleness** if the context is built at resolve time: step 2 has the failing test first.
- **Prompt-cache churn** from a varying tool list: visibility uses actor facts only.
- **Plugin migrations vs the owner's data:** additive tables only, copy-first procedure, separate migration tables.
- **T1 is not a sandbox:** the install notice and docs say plugin code runs with core authority.
- **Review spam and injection:** cap, expiry, the requester's text shown as data, approval replays validated input only.
- **Two permission systems:** one table, ids registered at install; a test fails on an unknown id.
- **`check-size`:** one file per operation keeps files short.

## Open verifications

1. ~~The bun-sqlite drizzle migrator honours `migrationsTable`~~ **Settled (step 5):** yes, end to end. `SQLiteSyncDialect.migrate` reads `config.migrationsTable` for the create, the last-row read and the insert; two plugins with their own folders and journals apply independently, in any order, twice, and `__drizzle_migrations` is untouched (`packages/host/src/storage/storage.test.ts`).
2. ~~drizzle-kit per-plugin generation~~ **Settled (step 5):** a separate `out` and journal table work (`scripts/plugin-db-generate.ts`, a JSON config in a temp folder, `out` relative to drizzle-kit's cwd because it prefixes `./`). **`tablesFilter` does not limit `generate`**: a stray table in `schema.ts` is generated anyway, so the script reads the schema first and refuses it, and the apply step checks every statement again.
3. ~~`billTo` through inbox, park and wake~~ **Settled (step 7 agent, `apps/core/src/spike-billto.test.ts`, scripted model, production SQLite inbox):** yes, no other mechanism is needed. A principal `{ id: 'ben', billTo: 'ana' }` arrives intact (every key, `toEqual`) in `ctx.principal` of (a) `send(..., { principal })`; (b) the continuation after a park: `respond` answered by the owner runs with the principal of the turn that asked; (c) a wake turn started by `session.inject(kind, data, { wake: true, principal })`; (d) `session.enqueue(text, { principal })` on the durable inbox, drained by a **different instance** (the scheduler path of spec 29 §4.1). `scopes(ctx)` of the eharness `budget.ledger` config receives that same principal in the `send` and `wake` turns, and a `scopes` that returns `person:${billTo ?? id}` makes the ledger reserve under `person:ana` and never `person:ben`. What the Reminders agent must still do: change `budget.scopes` in `modules/budget/budget.ts` (it reads `ctx.principal?.id` today) to `billTo ?? id`; keep `billTo` identifiers-only (principal is persisted, at most 2048 bytes); treat `billTo` as accounting only and re-check the creator's right in `fire`; a worker inherits the parent turn's principal, so a billed turn bills its workers to the same scope.
4. ~~`eharness/scheduler` across a restart~~ **Settled (step 7 agent, `packages/db/src/eh/scheduler-restart.test.ts`, fresh temp files, `sqliteScheduleStore`):** a schedule is a durable row and survives closing the connection and a new process. **A slot that came due while the core was down is dropped by default**: the default `catchUp: 'skip'` reports it as `skipped: 'catch-up'`, a `once` schedule ends with `nextFireAt: null` and **nothing fires and nothing is recorded** unless the app records it; so Reminders must create schedules with `catchUp: 'once'` (fires the missed slot late, exactly once, original slot time in the id) or `{ max: n }`, and audit `reminder.skipped` itself from `TickReport.skipped`. `graceMs` (default `max(2 x tickMs, 1000)`) is what separates "late" from "missed". A claim left by a process that died is taken over after `leaseMs` (`TickReport.recovered`) and the slot is then judged like any other (an old one is missed). `fire` returning `{ fired: false }` is `skipped: 'declined'`, the schedule advances and `lastFireAt` is not set (honoured). `fireId = sched:<id>:<scheduledAt>` is deterministic, pass it as the inbox `id`. **Two gaps for the Reminders agent:** Keith's migrations create no `eh_schedules` table (db.md; the test builds it with `schemaSql`), and `eharness/sqlite` may only be imported by `packages/db` (rule `eh-sqlite-only-from-db`): either add `eh_schedules` to the core migrations and a `sqliteSchedules(sqlite)` adapter in `packages/db`, or keep reminders in a `plg_reminders_*` table with a small `ScheduleStore`. The cron calculator is still undecided (rule 11: a Bun-first or justified tool; `scheduler` refuses a cron schedule without `next`).
5. ~~A tool source with `refresh: 'turn'` plus metadata reaches `tool.approve` as `toolMetadata` in 0.12.~~ **Settled (step 3, `adapter.test.ts`):** a tool from a `refresh: 'turn'` source whose `tool({ metadata })` carries `{ risk, keithPlugin, keithOperation }` reaches `tool.approve` as `e.toolMetadata` and is stored on the message part. (`withToolFields` was not needed: the tool is built with `tool({ metadata })`.) The hook still decides by tool name, not metadata.
6. **Settled (steps 2 and 3):** `ctx.principal` is read live. One session sent twice with `send(..., { principal })` as two people runs `echo_who` as each (`adapter.test.ts`, "STALENESS"); a person suspended between two turns loses the tools at the next listing. `defineToolSource` in released 0.12 is `ToolSourceDef { id, list(ctx), refresh?, defer?, explain?, open?, close? }`, as the plan assumed. Not tested: the raw function form of a static tool (the adapter never uses it).
7. Still open: the `Bun.serve` single websocket handler (P18). **The cron calculator is settled (step 9):** `Bun.cron.parse(expr, from)` (a Bun built-in, rule 11), evaluated in the core's local time zone; no `tz` per reminder. Items 1 to 4 are settled above.

## Deviations (Nov 9, 2026, steps 1 to 4)

- **Capability registry in step 3, not step 4.** The loader must register a plugin's ids and a member must hold the role default before any operation can be reached, so `createCapabilityRegistry` (`@keith/contracts`) and `createCapabilities(grants, registry)` landed with the loader. Step 4 did the rest: the "every procedure has a known capability" test now asks the registry, and tests walk the operations of loaded plugins against the manifests' ids (`packages/host/src/capabilities.test.ts`, `apps/core/src/plugins.e2e.test.ts`). `Capabilities.of` now returns `ReadonlySet<string>`; `auth.whoami` and `admin.people.grant` keep the closed core enum, so a plugin capability reaches a person by **role default only** until the operator surface (step 10).
- **`tool.approve` does not decide audience or capability.** Both depend on the live actor and `tool.approve` is re-run on re-validation (AGENTS.md gotcha). They are enforced where the live actor is read: the per-turn catalog (`guard.visible`) and `guard.run`. The hook decides from the tool name and the static declaration: `dangerous` asks, an operation hidden from the AI is denied.
- **Guard order** is the one the task gave (actor, status, capability, audience, input, ACL, rate limit, audit, run), not the ADR text (audience before capability, a review step). Input is parsed after the four cheap checks so a caller who may not use an operation learns nothing of its shape; `review` is step 7. A system actor is never an audience (work runs as a person or not at all).
- **Enable setting is read at boot** (`plugins.<id>.enabled`), as the task said; ADR-0016 says live toggling: that comes with step 10.
- **Workers do not get plugin tools** (only the front agent); `ctx.actor`'s session fields (`elevated`, `zone`, `methods`) are conservative defaults, the facts of a call are in `k.session` (the `TurnAuth` map is not built; an AI turn is never `elevated`).
- **Host depends on `@keith/acl`** (`AclError`, `aclActorOf`, `memoryAcl` for the testing kit), allowed since `check-imports` only restricts plugins.
- **Plugin tools are exposed as `<id>_<op>`** with the plugin id's hyphens kept (`notes-list_all`); ids hold no underscore, so the first underscore splits uniquely.
- **Doc drift found:** AGENTS.md rule 5 and the Map still say eharness 0.9.0; the catalog, `node_modules` and `.ref/eharness` are 0.12.0.
- **Extra:** `core.plugins` (`status()`, `loaded()`, `guard`, `visibleOperations`, `capabilities()`), `CoreOptions.plugins`, `bootCore(..., { plugins })`, 10 s `start` timeout, request body limit of 64 KB, OpenAPI 3.1 with `x-keith-*` extensions and a hoist of zod's self references.

## Deviations (Nov 9, 2026, steps 5 to 7)

- **`plugin_kv` is a core table (migration 0010), not a `plg_<id>_kv` table**, so a plugin that only needs a few settings ships no migration; the namespace is the plugin id and `k.kv` is the only way in. The scoped `db` cannot see it.
- **The storage runtime lives in `@keith/host/storage`** (a core-only subpath: scoped handle, kv, migration runner and checks), not in `packages/db`, so plugin tests run the real scoped handle on an in-memory database through `memoryHost`. `packages/db` only gained the tables (`plugin_kv`, `owner_reviews`) and `reviewsRepo`. `migrateKeithDatabase` and `openKeithDatabase` take the plugin list (default `BUILTIN_PLUGINS`) and call the host runner.
- **The manifest carries `storage: { migrations }`** (the plan said `storage { schema, migrations }`); the schema is found by convention (`plugins/<id>/schema.ts`) by the generate script only.
- **drizzle-kit `tablesFilter` does not limit `generate`**: the script refuses a foreign table first, and `assertMigrationSql` checks again at apply time. `plugins-no-cross-plugin` needed no new rule (`plugins-only-host-contracts` already forbids another plugin); added `plugins-no-node-builtins` and `plugins-no-host-storage`.
- **Scoped SQL is a token check, not a parser**: a column may not be named like a core table. Not a sandbox (T1).
- **`k.notify` is self-only**; another recipient goes through the review queue (the host's own `reviews` channel tells the owner). Events are one record per recipient, type `plugin.<id>.<event>`.
- **`k.call` takes `'<plugin>.<operation>'`**; the callee must have `expose.call`. A service runs with the provider's authority (documented), it is not guarded.
- **Review step order**: after ACL and before the rate limit, as planned; a held call returns a `ReviewTicket` instead of the output (HTTP 202). Cap 20 (plan text said 10; the task said 20), settings `reviews.maxPending` and `reviews.expiryDays`.
- **The owner decides in `admin.reviews.*` and `keith-core reviews`, not inside eharness' `/attention` list** (that list is agent approvals); the TUI section is step 10. New owner-only capability `reviews.decide`. Plugin ids `reviews` and `review` are reserved.
- **Approval of a suspended requester is refused and the review stays pending** (the owner can deny); a later loss of capability is recorded as `outcome: error:NOT_FOUND`.

## Deviations (Nov 9, 2026, steps 8 and 9)

- **More host than the plan said.** Notes and Reminders needed facilities the host lacked, each added to `@keith/host` and documented in `plugins.md`: `k.schedule` + `onSchedule` + `ctx.wake` (timers by key over `eharness/scheduler`; the plugin never sees the scheduler or a session), `k.access` (checked share/unshare through the core's access service, so the rules and audit rows are the `acl.share` ones; widening needs `k.session.elevated`),
  `k.people` (`find` an active person by name, `name`), `k.aclActor`, `k.audit.ownerAccess` (the instance owner's root reads, `acl.owner-access`). The testing kit gained in-memory schedules, wake, access, `revoke`, and re-exports the ACL leak kit (a plugin may not import `@keith/acl/testing`).
- **Schedule store.** Migration 0012 adds `eh_schedules` (identical to `schemaSql`, tested) and `sqliteSchedules` in `packages/db`; the core ticks every 15 s (`CoreTiming.scheduleTickMs`) and once at boot, runs its own ticker so that `TickReport.skipped` can be audited, and drops no slot silently: `catchUp` is `once` or `{ max }`, never `skip`. A throw in `onSchedule` is audited and the slot dropped (no retry loop). A disabled plugin declines its slots (audited, `plugin-off`).
- **FTS5 in a plugin migration.** The host refused every virtual table; it now accepts a plugin's own `CREATE VIRTUAL TABLE plg_<id>_... USING fts5`. Drizzle cannot describe it, so the index is a **custom** drizzle-kit migration (`plugin:db:generate notes --name search_index --custom`; the script got the `--custom` flag) whose SQL was written into the empty generated file: the one place a generated file holds hand-written SQL, by design of `--custom`.
- **Notes.** No `chmod` operation (`@public` and `@users` entries cover it). Sharing to `@users` or `@public` through the chat is refused (a chat turn is never elevated); it works over HTTP after a step-up and with `keith-core acl share`. `notes_share` and `notes_delete` are `dangerous` (the model asks first). `public_get` and `public_list` are the only `audience: 'public'` operations (hidden from the model), and answer only what a **guest** could read whoever calls.
  `by` is the author's display name (`you` for the caller), through `k.people`. Delete is the ACL owner's only; the instance owner reads as root (audited) and cannot write.
- **Reminders.** The creator owns the ACL resource, the recipient has an `r` entry. A request counts as for another person unless `to` is absent, `me` or the caller's own person id (any other spelling is held, the safe direction). Cron is evaluated in the core's time zone (`Bun.cron.parse`), at most every 15 minutes (host rule); `at` must carry a UTC offset.
  The text of an approved reminder for another person cannot be edited by the creator (that would bypass the review): cancel and create again. Limits: 20 creates a minute, 50 active per creator, 10 other recipients per member, 20 fires an hour per creator.
- **Existing tests changed.** Core harnesses that boot a core now migrate the built-in plugins too (`testing/migrate-all.ts`); `access.test.ts` and `groups.test.ts` no longer register the `note` kind themselves (Notes does). `plugins/*` is covered by `check-exports` (16 entries).
- **Commit message warning.** The Notes commit body has a line `audience: public operations` that commitlint reads as a footer (a warning, not an error).

## Deviations (Nov 9, 2026, steps 10 and 11)

- **Enable and disable are restart-only.** The setting `plugins.<id>.enabled` is read at boot, as since step 3; ADR-0016's "live toggling" is amended in the ADR (the CLI, the TUI and the docs say "takes effect at the next boot"). A plugin turned off keeps its tools and routes until the restart.
- **New owner-only capability `plugins.manage`** (in `OWNER_ONLY_CAPABILITIES`); `admin.plugins.list|show|enable|disable` and `admin.capabilities.list` (`people.manage`, the grant picker's source). Enable and disable are `sensitive` and audited (`plugin.enabled|disabled`).
- **Capability ids are strings on the wire** (`PersonCapabilitySchema`): the closed enum stays for the core's procedure metadata, the grants service checks a grant against the live registry (an id of a plugin that is not loaded is `BAD_REQUEST`), `auth.whoami` lists every id the person holds. The name `CapabilityIdSchema` was taken by the node protocol.
- **No "config form"** in the Plugins section: neither built-in plugin declares `config`. The detail view is a read-only note (Show details), not a screen; Reviews is its own section (the plan said "the attention list"), a separate flow from eharness' `/attention`.
- **Smoke restarts the core** inside a step (`restartCore`, a new child on the same data folder) to prove a reminder that came due while down fires once; it creates three extra people (`hana`, `gio`, `fai`), each with a password login, so the smoke grew from 31 to 39 steps and about 21 s to about 38 s.
- **`public_get` is reachable over HTTP only with a credential** (a signed-in member calling it sees only what a guest could read); without a credential the route answers 401. A guest actor does not exist until P17.

## eharness impact

None required. Optional follow-ups, each generic and extending only: a typed `Principal` (already ADR-0069 future work) and `agent.plugins()` introspection with opaque `meta` for admin UIs. Neither blocks this plan.

## Verification items for the gate

- Staleness, suspended, guest-denied and rate-limit tests are green; the OpenAPI golden file matches.
- The leak kit passes for Notes and Reminders; a private note never shows in another user's list, search, count or error.
- A reminder from A to B appears in the owner's queue, does nothing until approved, then fires once; the budget ledger shows the creator's scope charged.
- Fire after the creator lost the right: skipped, audited, no turn.
- Migration of a copy of the real database; `bun run check` and `bun run smoke` pass.

## Gate

`bun run check` exit 0 on a clean copy; smoke gains plugin steps (notes create/share, reminder review). Record counts.

## Gate evidence

Nov 9, 2026, on the working tree of the commit that closes this plan (not a clean-copy run: the tree also held the owner's uncommitted `apps/tui/src/cli.tsx` and `scripts/manual.ts`, neither touched nor staged).

- `bun run check` ran once at the end (after step 10's commit): Biome, tsc on every package and the scripts, and check-types passed; `bun test`: **2058 pass, 13 skip, 1 fail** of 2072 tests in 250 files. The one failure was `features/home/home.test.tsx` ("over 80 % of the limit the Budget item has a !"): it pressed down at most 8 times to reach Budget and the two new sections (Plugins, Reviews) pushed it to the tenth row. Fixed (bound 12); the home directory (77 tests) then passes. Because the owner's rule for this run allowed one full check, the suite was **not re-run in full after that fix**. check-imports (800 files, 14 packages), check-size (warnings only, none above 800) and check-exports (16 entries) were run on their own after the check and are ok.
- Commits before the final full run (steps 1 to 10) were verified only with targeted checks (tsc of the touched projects, Biome on the changed files, the tests of the touched modules and their dependents); the full suite ran once, at the end.
- Step 10 tests: `plugins-operator.e2e.test.ts` (6: list and show, owner only, disable and enable audited and restart-only, step-up over TCP, grant and revoke of a plugin capability, `whoami`), `manage-plugins.test.tsx` (10), `features/manage/manage-state.test.ts` (the sections per role), `cli/plugin-command.test.ts`, and the real-pty `cli.plugins.pty.test.ts` (run alone first, passes).
- `bun run smoke`: `SMOKE PASS (39 steps ok, about 38 s)`, 31 before, eight new steps (`scripts/smoke/plugins.ts`): (1) `plugin list|show|disable|enable` with the next-boot wording and an unknown id refused; (2) a private note is `404` for an outsider with the same body as a made-up id, absent from list and search; (3) a share to a group opens it to a group member and not to the outsider; (4) a public share is read through `public_get` (a group-only note is not; no credential is `401`); (5) the owner's read of a private note writes `acl.owner-access`; (6) a reminder that came due while the core was down fires exactly once after a restart on a real file database; (7) a reminder for another person waits in `reviews list` and fires after `reviews approve`; (8) no note or reminder text in the audit log. No keith, node or smoke process was left.
- This closes the end-to-end ACL gate of P15 (dated addendum in `plans/done/P15-acl-and-visibility.md`).

**Unverified.** (1) A real front model's compliance with the "reminder text is data, not an instruction" framing: the tests assert the wrapped text and the principal, not what a real model does with it. (2) A migration on a **copy of the owner's real database**: the migration tests run on fresh and migrated files only. (3) LAN behaviours (a second machine, the public route over the network). (4) The TUI sections were driven against the fake core (component tests and one pty), not against a real core by hand. (5) The manual scenarios are **owner to run**: `docs/manual-testing.md` scenario 14 (and steps 4 to 8 of scenario 13); the smoke covers their no-eye parts. (6) No sentinel check of real model output; the cheap sentinel check on the audit log is smoke step 8.

**For P17 (guest mode).** Guests reach an operation only if it declares `audience: 'public'` (default `user`); the built-in ones are Notes `public_get` and `public_list` (hidden from the model, `expose.ai: false`; they answer only what a guest could read, whoever calls, through the `PUBLIC` ACL subject). The guard already refuses a guest for any other audience; there is no guest actor yet (the HTTP route answers 401 without a credential): P17 adds the actor (zone `public`, no person id), which the guard, `k.people` and `k.access` must treat as read-only and never elevated. A held review needs a person, so a guest is refused where an operation would be reviewed ("nothing runs unreviewed"). Rate limits are per operation and per actor in the guard (`rateLimit`), and the review queue caps 20 pending per requester; a guest needs its own per-visitor limit and the owner-paid budget scope (`billTo`, an accounting key only). Plugin capability ids now appear in `auth.whoami` and can be granted per person; a guest holds none.

## Owner to run

1. `keith-core plugin list`; disable Notes, ask Keith to write a note (refused), enable it again.
2. Ask Keith for a note, share it with one friend; the friend reads it in their TUI; another friend gets "not found".
3. Ask for a reminder for yourself in two minutes; it fires.
4. As a friend, ask for a reminder for another friend: see "sent to the owner"; approve in `keith manage`; it fires and your budget (not theirs) moves.
5. Suspend the creator, wait for a fire: skipped, audit row.
6. Open `/plugins/openapi.json` with a member token and with the owner token: different operation sets.
