# P28 — Protocol engine (hypothalamus) and the personal agenda

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku implementers, orchestrated by Sonnet; `bun run check` 3691 pass and `bun run smoke` 68 steps pass; phase 6 stopped after the host port: ADR-0028) · depends on: P24 (approval expiry and the `approvalId` / `expiresAt` event fields), P25 (delivery service), P27 (presence, signals, ports), P26 (removal registry) · ADR: 0024, 0025 §2, 0020, 0027 §10, §16 · closes: ADR-0024 §1–§5, ADR-0025 §2; supports F-009 (the ping before expiry; the expiry itself is ADR-0027 §10, built by P24) and F-010 (the `reminder-missed` ladder; the delivery report is P25)

## Goal

Keith acts before it is asked, and every proactive act is a visible, pausable rule. The owner (and any person, for their own life) can list,
pause and audit protocols in `Apps > Protocols`; Keith proposes protocols from what a person says ("meeting at 9: keep 9 to 10 quiet?") and
saves one only after the person confirms. A deterministic engine runs the rules and survives a restart, and the front agent keeps a
per-person agenda that presence uses ("busy until 10:00").

## Why

- ADR-0024 §1–§4: protocol as data, deterministic engine with durable runs, authoring rules, built-ins `approval-stale` and `reminder-missed`.
- ADR-0025 §2: intentions go into a confirmed agenda; presence `note` reads it (P27 owns presence, this plan feeds it).
- ADR-0027 §10: approvals expire after 24 h; the `approval-stale` protocol pings before that (F-009: today a pending approval never expires and shows
  no age, `docs/flow-review/2026-11-09-full/REPORT.md` F-009, `recon/d3-shell-nodes.md`).
- ADR-0027 §16: a reminder that could not be delivered is reported to its creator (F-010); P25 reports the failure, `reminder-missed` is the
  ladder that retries and reports.
- ADR-0020 §3: a model turn runs as one principal. A `wake` step runs as the protocol owner; the engine itself is never a model.
- P22 M3 and M4 (this plan replaces them in detail). P22 also listed F-007 under M3; ADR-0027 §11 gave it to the task and approval fixes, so it is not
  closed here (see Traceability).

## Scope

In:

- Protocol store with versions, per-run durable state, proposals, agenda table (SQLite, additive migration).
- Contracts (zod) for definition, trigger, condition, step, limits, run, proposal, agenda item.
- Engine: triggers `time`, `absence`, `signal`, `event`; conditions; steps `notify`, `ask`, `wake`, `act`, `wait` with branches; limits; restart recovery.
- Authoring rules in code (who may create which step; pre-approved `act` with the exact input; Keith proposes, person confirms).
- RPC `protocols.*` and `keith-core protocols` commands, audit `protocol.*`, events `brain.hypothalamus.*`.
- TUI `Apps > Protocols` (list, detail with runs, pause, resume, delete, confirm a proposal, create a personal reminder ladder from a form).
- Agent tools for the front agent: `protocol_propose`, `protocol_list`, `protocol_pause`, `protocol_answer`.
- Built-ins `approval-stale` and `reminder-missed` (ADR-0024 §4).
- Reminders become protocols inside (ADR-0024 §5, final phase 6): the plugin keeps its API.
- Agenda: `agenda_add` / `agenda_list` / `agenda_done` tools, extraction rule in the front prompt, confirmation when unsure, protocol proposals from the agenda, `note` feed to presence.

Out:

- `owner-absence` and the heir claim: P29 (it only needs this engine).
- Changing the reminders plugin API: none. Its internals move onto protocols in phase 6 (ADR-0024 §5); the tools and the TUI view stay as they are.
- Rooms opened by a protocol (ADR-0026 revisit), protocols that coordinate several people, protocols that run on a node while the core is down (ADR-0024 revisit).
- A visual protocol designer. The TUI authors a protocol from a small form or accepts a proposal; free-form JSON editing is a CLI import only.
- Shared calendars (ADR-0025 revisit).
- Dropping the old `plg_reminders_fires` table after phase 6: it stays, unread; a drop is a later owner decision (P22 "Not planned", residue row in P32).

## Design

### Region and layers

New brain region `hypothalamus` (ADR-0004, ADR-0020 §5): `apps/core/src/modules/hypothalamus/`. It is Keith's self layer for protocols owned by `keith`
and the personal layer for protocols owned by a person. The agenda is personal data (ADR-0020 §1): it is read only by its person, by the owner with
an `acl.owner-access` audit row (ADR-0015), and never loaded into another principal's context.

### Data model (one additive migration, generated with `bun run --filter @keith/db db:generate`; the core takes the backup of ADR-0027 §3 before it runs)

| Table | Columns | Notes |
| --- | --- | --- |
| `protocols` | `id` (UUIDv7), `owner` (`person id` or `keith`), `name`, `built_in` (null or `approval-stale`, `reminder-missed`, `owner-absence`), `enabled`, `paused_until` (ms, null), `version` (current), `created_by`, `created_at`, `updated_at` | unique `(owner, name)`; unique `built_in` per owner |
| `protocol_versions` | `protocol_id` (FK), `version`, `definition` (JSON, validated by `ProtocolDefinitionSchema`), `approvals` (JSON: one entry per `act` step with the SHA-256 of the exact input, who approved, when), `saved_by`, `saved_at` | PK `(protocol_id, version)`; an edit writes a new row, old rows stay (audit) |
| `protocol_runs` | `id` (UUIDv7, the run id used as the delivery key of P25), `protocol_id`, `version`, `person` (the principal the run acts for), `trigger_ref` (fire id, `absence:<lastSignAt>`, signal id, event seq), `status` (`running`, `waiting`, `done`, `cancelled`, `failed`, `skipped`, `expired`), `step` (current step id), `visits` (JSON counts per step), `answers` (JSON), `wake_at` (ms, null), `cost_usd`, `started_at`, `updated_at`, `ended_at` | unique `(protocol_id, trigger_ref)` is the exactly-once guard of a trigger; indexes `(status, wake_at)` and `(person, started_at)` |
| `protocol_run_steps` | `run_id` (FK), `n` (AUTOINCREMENT order), `step`, `kind`, `outcome` (`started`, `ok`, `answered:<x>`, `timeout`, `refused`, `failed`, `unknown`), `at`, `detail` (JSON, no content of messages: ids and lengths) | the run history shown in the TUI |
| `protocol_proposals` | `id`, `person`, `definition` (JSON), `reason` (one line shown to the person), `source` (session id and message id), `status` (`pending`, `confirmed`, `dismissed`, `expired`), `created_at`, `expires_at` | a proposal is data, never a protocol; expires after 7 days |
| `agenda_items` | `id`, `person` (FK-less like `group_members`), `what`, `starts_at`, `ends_at` (nullable), `place` (nullable), `status` (`tentative`, `confirmed`, `done`, `cancelled`, `dismissed`), `source_session`, `source_message`, `created_at`, `updated_at` | index `(person, starts_at)`; purged 30 days after `ends_at` in the prune tick |

Removing a person (ADR-0027 §26): step P28.3.1 registers protocols, runs and agenda rows in the P26 removal registry (`onPersonRemoved`: `keep` moves them into the 30-day retention with the person's other data, `export` adds them to `people export`, `purge` deletes them); no edit of `people.ts`.

### Contracts (`packages/contracts/src/protocols.ts`, exported through `index.ts`)

- `ProtocolDefinitionSchema = { trigger, conditions: Condition[], steps: Step[], limits, start: stepId }`, at most 40 steps, ids `[a-z0-9-]{1,32}`, unique.
- `TriggerSchema` (discriminated by `kind`):
  - `time`: `{ cron } | { at }` (same rules as the reminders plugin: cron at least 15 minutes apart, `Bun.cron`).
  - `absence`: `{ person, afterMs }` (no sign of life from `person` for `afterMs`; 1 hour to 90 days).
  - `signal`: `{ type, filter? }` over the signal types of ADR-0025 §1 (`client.connected`, `client.disconnected`, `client.active`, `device.location`, `node.event`, `activity`); `filter` is a flat equality map, no code.
  - `event`: `{ type, filter?, afterMs?, until?: { field, beforeMs }, guard? }` over brain events (`brain.amygdala.wait`) and the P25 activity record `delivery.failed` (`{ personId, deliveryId, source, reason }`, emitted by P25.1.3). With `afterMs` the run is created at once in `waiting` with `wake_at = event.at + afterMs`; with `until` it waits until `event[field] - beforeMs` (an absolute time carried by the event, such as `expiresAt`); at that time `guard` (a Condition) is re-evaluated. A false guard ends the run as `skipped`; the guard `approval.pending` may also answer "pending, but due later" (the approval's current `expiresAt - beforeMs` moved because the TTL setting changed), and then the run waits again until that time.
- `ConditionSchema` (pure, evaluated in code, no expression language, no model): `all`, `any`, `not`, `time.between` (`HH:MM`, `HH:MM`, the core's zone, quiet hours use it), `presence` (`person`, `state in [...]`, disclosed state only), `agenda.busy` (`person`, at the evaluation time), `signal.since` (`person`, `ms`), `budget.remaining` (`person`, `usdAtLeast`), `approval.pending` (`approvalId`, returns pending and the approval's current `expiresAt`).
- `StepSchema` (discriminated by `kind`, each with `id`, optional `next` (a step id or `end`), optional `branches`):
  - `notify`: `{ to: 'owner-of-run' | personId, text (up to 500 chars, fixed), needs?: ClientCapability[] }`.
  - `ask`: `{ to, text, options?: string[], timeoutMs }`; branches `answer:<option>` and `timeout`.
  - `wake`: `{ instruction (up to 1000 chars, fixed) }` runs one front turn as the run's person (P25 delivery wake path).
  - `act`: `{ operation: { kind: 'node.capability', node, capability } | { kind: 'plugin.operation', plugin, operation }, input }`.
  - `wait`: `{ durationMs }` (up to 30 days).
  - A `branch` is `{ when: 'answer:<x>' | 'timeout' | 'ok' | 'failed' | 'condition', condition?, goto }`. Loops are allowed (a daily check-in is a `wait` that goes back to its `notify`); `limits.maxSteps` (default 100 per run) and `limits.maxVisits` (default 30 per step) end a runaway run as `failed` with `limit`.
- `LimitsSchema = { maxRunsPerDay (default 3), budgetUsdPerRun (default 0.05; only `wake` costs), quietHours?: { from, to }, cancelWhen?: Condition }`. A `notify` or `wake` inside quiet hours is delayed to the end of them unless the step says `urgent: true`, which only an `owner-of-run` that is the owner may set. `cancelWhen` is re-evaluated at every tick of a running or waiting run; true ends it as `cancelled` (P29 uses it for "any owner sign cancels").
- Run, run step, proposal, agenda item and RPC input/output schemas next to them. Every `text` and `instruction` is plain text; the engine never interpolates data into them (no templates), so a fixed text cannot become an injection channel.

### Engine (`modules/hypothalamus/`)

Files: `engine.ts` (tick and state machine), `triggers.ts`, `conditions.ts`, `steps.ts`, `authoring.ts`, `service.ts` (CRUD, versions, proposals), `builtins.ts`, `agenda.ts`, `tools.ts` (agent tools), `procedures.ts` (oRPC), `index.ts`.

- **Tick.** One interval (`protocols.tickMs`, default 15 s; the engine is idle when no run is due and no absence trigger is armed). Each tick: (1) evaluate `absence` triggers, (2) drain new feed events and signals since a stored cursor (settings key `protocols.cursor`), (3) advance every run with `wake_at <= now`, (4) evaluate `cancelWhen`.
- **`time` triggers** are schedules in `eh_schedules` (the eharness scheduler already used by plugins, `modules/plugins/schedule.ts`): session id `protocol:<id>`, payload `{ protocolId, version }`, catch-up latest slot only (ADR-0027 §16 pattern), `fireId` becomes `trigger_ref`. No second timer system.
- **Exactly once.** `INSERT` of a run with `(protocol_id, trigger_ref)` is the guard: a duplicate fire, a re-read feed event after a restart or a second tick starts nothing. `maxRunsPerDay` is counted in the same transaction.
- **Durable state.** Before a step's side effect the engine writes the step row with outcome `started` and the new `wake_at`; after it, `ok` or the failure, in one transaction with the next step pointer. Delivery of `notify`/`ask`/`wake` passes the key `<runId>:<stepId>:<visit>` to the P25 delivery service, which is exactly-once by that key, so replaying a `started` step after a crash cannot send twice. A replayed `act` is never repeated: its `started` row without a result becomes outcome `unknown`, the run `failed` and the owner is told (an act is not safe to guess).
- **Restart.** At boot `engine.recover()` re-arms schedules, reloads `waiting` runs (`wake_at` is absolute, so overdue ones advance at the first tick), replays `started` steps as above, and re-reads the event cursor. Tests kill and re-create the engine with the same SQLite file.
- **Principal and rights.** A run belongs to `person` (the protocol owner; for a `keith`-owned protocol, the person named per step, never an implicit owner). `wake` opens the front session of that person with `frontSessionOptions` and the principal `{ id }` (`platform/sessions.ts`); a `wake` of a suspended or removed person is skipped (same rule as wake, ADR-0027 §15). `notify` to a person other than the owner of the run is allowed only for a `keith`-owned protocol or when that person is the owner role (no member can make Keith message another member by authoring a protocol).
- **`act`.** `node.capability` goes through the `NodeRegistry.invoke` path with the static risk table of `@keith/contracts`: `read` capabilities run; anything riskier needs a stored pre-approval whose hash equals the hash of the exact input at run time, otherwise the step ends `refused` (audited). `plugin.operation` goes through the plugin host with the owner's actor and the plugin's own guard; the same pre-approval rule applies to operations of risk above read. A protocol never widens access: the engine calls the same functions as a person would and checks the same ACL.
- **Budget.** `wake` cost is charged to the run's person (`billTo` is never the owner by default, P22 cross-cutting rule); a run without budget for one turn skips the step with outcome `refused:budget` and tells the person once.

### Authoring rules (`authoring.ts`, one pure function used by RPC, CLI, agent tools and proposal confirmation)

| Who | May create |
| --- | --- |
| Any signed-in person (capability `chat`) | Protocols they own with `notify` (to themselves), `ask` (to themselves), `wake`, `wait`; triggers `time`, `absence` of themselves, `signal` of their own signals, `event` of their own events; limits within caps. |
| Owner only | `owner: keith`; any `act` step; `notify` or `ask` to another person; `urgent`; `cancelWhen` over other people; built-ins. |
| Nobody | A step that changes ownership, a grant or a secret. Only the built-in succession protocol of P29 may call `transferOwner` (ADR-0022 §2), through its own coded path, not through `act`. |

Saving a protocol with an `act` step records the pre-approval: the owner is shown the operation and the exact input (TUI confirm or `keith-core
protocols save --approve`), and `protocol_versions.approvals` stores the input hash. Changing the input is a new version that needs a new approval.
Keith may only **propose** (tool `protocol_propose` writes `protocol_proposals`; it cannot write `protocols`); the proposal shows as a card in the
person's chat and in `Apps > Protocols`; confirming is a person action (RPC `protocols.confirm`, or answering the card), re-validated by the same
authoring function with the confirming person as author. A proposal can never contain `act`, `urgent`, or a step addressed to someone else; the
proposal schema rejects them before it is stored.

### Audit, events, settings, errors

- Audit kinds (written by the service, `actor` = who did it, `via`): `protocol.create`, `protocol.update` (new version), `protocol.delete`, `protocol.pause`, `protocol.resume`, `protocol.approve` (pre-approval of an `act`, with the input hash, never the input), `protocol.proposal.create`, `protocol.proposal.confirm`, `protocol.proposal.dismiss`, `protocol.run.start`, `protocol.run.step` (kind and outcome only), `protocol.run.end` (status), `protocol.run.refused` (why). Rows about a member are visible to that member through `audit.mine` (ADR-0027 §6): step P28.2.7 registers every `protocol.*` kind in `AUDIT_SUBJECT_FIELDS` and `registerMySummary` (P23.2.3).
- Events (activity feed, schemas in `packages/contracts/src/brain.ts`, region added to `BrainRegionSchema`): `brain.hypothalamus.fire` (run started: `protocolId`, `runId`, `trigger`), `brain.hypothalamus.step` (`runId`, `step`, `kind`, `outcome`), `brain.hypothalamus.wait` (`runId`, `wakeAt`), `brain.hypothalamus.end` (`runId`, `status`). Payloads carry `personId`; visibility follows the existing feed filter (a person sees their own, the owner sees `keith`-owned ones).
- Settings: `protocols.tickMs` (5000 to 60000), `protocols.maxPerPerson` (default 20), `protocols.maxPerPersonRunsPerDay` (default 20), `approvals.pingBeforeHours` (default 2, at least 1 and below `approvals.ttlHours`; owner, step-up, audited `settings.approvals.set` like the TTL). Built by steps P28.2.8 (schema, defaults, store), P28.3.5 and P28.3.6 (RPC, CLI), P28.4.3 (TUI rows).
- Errors (RPC `ORPCError` codes + message): `BAD_REQUEST` for an invalid definition (the first zod issue path), `FORBIDDEN` with `reason` `author-rule` for a step the caller may not author, `CONFLICT` for a duplicate name or a stale `version`, `NOT_FOUND` for another person's protocol (as good as absent), `PRECONDITION_FAILED` for an `act` without its pre-approval.
- Capabilities: no new capability. Own protocols need `chat`; owner-only paths check the role in the service (same pattern as `notOwner`, ADR-0022 §1), not only in the gate.

### RPC and CLI

`protocols.list`, `protocols.get`, `protocols.save` (create or new version, `approve` flag for owner), `protocols.setEnabled`, `protocols.pause` (`until`), `protocols.delete`, `protocols.runs` (history), `protocols.answer` (an `ask`), `protocols.proposals`, `protocols.confirm`, `protocols.dismiss`, `agenda.list`, `agenda.add`, `agenda.update`, `agenda.done`. Contract in `packages/contracts/src/contract.ts`, handlers in `procedures.ts`, client methods in `packages/client`.
CLI (`apps/core/src/cli`): `keith-core protocols list|show|pause|resume|delete|runs [--person]` (owner, offline reads allowed under the same rules as other admin commands; changes go through the running core).

### Agent tools (front agent only; not workers, not guests, not rooms)

All run as the turn's principal (`ctx.principal`) and call the same service functions. `protocol_propose({ name, reason, trigger, steps })` (writes a proposal; the answer text says it waits for the person), `protocol_list()` (own protocols and pending proposals), `protocol_pause({ id, until? })` (own only), `protocol_answer({ runId, option?, text? })` (the person answers an `ask` in chat; the service checks `run.person === principal.id`). `agenda_add`, `agenda_list`, `agenda_done` (own agenda). Tool inputs are zod-validated; none takes a person id, so a tool cannot be pointed at another person.

### TUI (`Apps > Protocols`)

New Manage section `protocols` (`apps/tui/src/features/manage/protocols/`, registered in `sections.ts` with `read: ['chat']`, shown under the `Apps` group in `features/home/menu-state.ts`). List columns: `name`, `owner`, `trigger` (short), `state` (`on`, `paused until 14:00`, `off`), `last run`. Detail box: steps as a ladder (`1 notify · 2 wait 1d · 3 ask`), the last five runs with status. Actions: `pause`, `resume`, `delete` (confirm), `new reminder ladder` (form: when, text, repeat count, ask yes/no), `proposals` (list with `confirm` / `dismiss`; the card shows the one-line reason and the exact steps). Copy examples: `Keith suggests: keep 09:00 to 10:00 quiet (you said "meeting at 9"). [confirm] [dismiss]`; a run waiting on a question shows `asked 2h ago: Still there? [answer]`. The summary line in the Home menu box: `3 protocols · 1 proposal`. `act` steps appear only for the owner, with the stored pre-approval hash shown as `approved 2026-11-10 by owner`.

### Built-ins (`builtins.ts`, seeded at boot, idempotent by `built_in`)

- **`approval-stale`** (owner: `keith`, enabled): trigger `event` `brain.amygdala.wait` (payload extended by P24.1.4 with `approvalId` and `expiresAt`) with `until: { field: 'expiresAt', beforeMs: approvals.pingBeforeHours }` (default 2 h before the expiry, a setting), `guard: approval.pending(approvalId)` (re-reads the approval's current `expiresAt` at guard time, so a TTL change never makes the ping early or late); steps: `notify` to the owner of the approval route ("An approval for <tool> on <node> from <person> waits and expires in about 2 hours."; text fixed, names come from ids resolved in code at delivery, not from the template) then `end`. It never answers or expires anything: the expiry belongs to the approval code (ADR-0027 §10). The expiry settings and the event fields exist because P24 ships before this plan.
- **`reminder-missed`** (owner: `keith`, enabled): trigger `event` on the P25 `delivery.failed` record with `source: 'plugin:reminders'`; steps: `wait 15 min`, `notify` the creator on the best channel ("Your reminder '<title>' could not be delivered at 09:00; here it is now"), on failure `wait 1 h`, then `notify` queued for the next connection and `end`. Run id of P25's delivery is the trigger ref, so one failure makes one run.

### Agenda (phase 5)

- Extraction rule in the front prompt (`wernicke-broca/agent.ts`, a short block after `FRONT_INSTRUCTIONS`): when the person states something they will do at a time or place, call `agenda_add` with the fields; when the time or meaning is unclear, ask one short question first and call the tool only after the answer (`status: confirmed`), else `tentative`. No extra model call: it is the same turn (ADR-0025 consequences).
- `agenda_add` stores with `source_session` and `source_message`. The same tool can set `ends_at`; "tomorrow" is resolved by the model with the `datetime` tool and stored as an absolute time.
- Proposals from the agenda: a rule in code (`agenda.ts`) after an item is confirmed: for a meeting item, create a `protocol_proposals` row "keep <start> to <end> quiet" (a `time` trigger at `starts_at - 5 min` with a `notify` to the person's own best channel and a presence note, no `act`), at most one proposal per item. Keith mentions it in the same turn through the tool result.
- Presence feed: this plan implements a `PresenceOverlay` (`id: 'agenda'`, `busy(person, now)` from `agenda.busyNow` and `agenda.noteFor`, `"in a meeting until 10:00"`) and registers it with P27's `parietal.addOverlay`; P27's compute is not edited, and the agenda never writes presence, it answers questions. Disclosure stays P27's rule: only the disclosed line leaves the personal layer.

## Phases

### Phase 1 — Contracts, spec, store

Goal: the protocol model exists as a spec, zod contracts and tables, with no behaviour yet.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.1.1 | Write the module spec: data model, trigger/condition/step tables, authoring rules, audit kinds, events, limits | `docs/specs/hypothalamus.md` (new), `docs/specs/README.md` (index line) | hypothalamus.md all sections | none (doc) | the spec states every rule of the Design section; reviewed against ADR-0024 |
| P28.1.2 | Contracts: definition, trigger (with `until`), condition, step, limits, run, proposal, agenda item, RPC schemas | `packages/contracts/src/protocols.ts`, `packages/contracts/src/index.ts`, `scripts/exports.snapshot.json` (regenerate: `bun scripts/check-exports.ts --write`) | hypothalamus.md "Contracts" | `packages/contracts/src/protocols.test.ts`: a valid ladder parses; a loop parses; unknown step kind, unknown condition key, a template-like field, 41 steps, duplicate step id, a `goto` to a missing step, a cron under 15 minutes, `afterMs` over 90 days all fail with a path | `bun test ./packages/contracts` passes |
| P28.1.3 | Region and events: add `hypothalamus` and the four `brain.hypothalamus.*` schemas | `packages/contracts/src/brain.ts`, `packages/contracts/src/brain.test.ts` | brain-events.md (events table, regions list) | each payload parses; a bad one returns `undefined` from `parseBrainEvent` | `brain-events.md` lists the events; `ARCHITECTURE.md` region table gains the row |
| P28.1.4 | Schema and migration (a new area file in `packages/db/src/schema/`, next free number; retention inventory rows, P26.1.5): `protocols`, `protocol_versions`, `protocol_runs`, `protocol_run_steps`, `protocol_proposals`, `agenda_items` (additive) | `packages/db/src/schema/`, generated `packages/db/drizzle/` (never by hand) | db.md (tables list, retention inventory) | `packages/db/src/migration-00NN.test.ts` style (see `migration-0009.test.ts`): applies on a database with data, existing rows unchanged, unique `(protocol_id, trigger_ref)` rejects a duplicate | migration generated, db.md table rows added |
| P28.1.5 | Repos: protocols (versions, CAS on `version`), runs (insert-if-absent, claim due, advance), proposals, agenda | `packages/db/src/repos/protocols.ts`, `packages/db/src/repos/agenda.ts`, `packages/db/src/index.ts` | db.md (Public API) | `repos` tests: duplicate trigger ref returns "exists"; two concurrent advances of one run, only one wins; version CAS conflict | repos exported and tested |
| P28.1.6 | Authoring function (pure): who may author which step, caps, proposal schema | `apps/core/src/modules/hypothalamus/authoring.ts`, `.../authoring.test.ts` | hypothalamus.md "Authoring" | member with `act` refused; member `notify` to another person refused; member `wake` allowed; owner `act` needs approval hash; proposal with `act` or `urgent` rejected; nobody can express a transfer | table of cases passes |

`bun run check` passes.

### Phase 2 — Engine

Goal: a protocol definition runs end to end, deterministically, and survives a restart.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.2.1 | Conditions evaluator over injected ports (clock, presence, agenda, budget, pending approvals, last sign) | `modules/hypothalamus/conditions.ts`, `conditions.test.ts` | hypothalamus.md "Conditions" | each condition true/false; `all`/`any`/`not`; quiet hours across midnight; presence uses only the disclosed state; unknown kind rejected before evaluation | pure, no I/O in the file |
| P28.2.2 | Run state machine: start (dedupe), step advance, branches, loop limits, `wait`, quiet hours, `maxRunsPerDay`, `cancelWhen` | `engine.ts`, `steps.ts`, `engine.test.ts` | hypothalamus.md "Engine" | scripted clock: ladder notify, wait, ask answered, ask timeout branch; loop ends at `maxVisits`; second start with same trigger ref creates no run; 4th run of a day refused | engine runs against fake ports |
| P28.2.3 | `notify`, `ask`, `wake` steps through the P25 delivery service with key `<runId>:<stepId>:<visit>`; `wake` as the run's principal; budget and suspended-person refusal | `steps.ts`, `deliver-port.ts`, `steps.test.ts` | hypothalamus.md "Principal and rights"; thalamus/ras spec lines that mention wake (`plugins.md` "Schedules and wake") | a replayed step sends once (fake delivery counts by key); `wake` carries `{ id: person }` and never the owner; a run without budget skips with `refused:budget`; a suspended person gets no wake | proven with the fake delivery service |
| P28.2.4 | `act` step: node capability and plugin operation, pre-approval hash check, risk table, `unknown` outcome on crash | `steps.ts`, `act.ts`, `act.test.ts` | hypothalamus.md "act"; motor.md (static risk table is the authority) | read capability runs; destructive without approval refused; changed input hash refused; crash between start and result gives `failed` and no second call; ACL of the plugin operation still applies | no `act` path bypasses `tool.approve`-equivalent rules |
| P28.2.5 | Triggers: `time` over `eh_schedules`, `absence`, `signal` (P27 port), `event` with `afterMs` and `guard` (feed cursor) | `triggers.ts`, `triggers.test.ts` | hypothalamus.md "Triggers" | cron fire creates one run; absence after N ms creates one run per absence period (anchored on the last sign); a signal filter matches only equal fields; an event with `afterMs` waits, guard false ends `skipped`; a `delivery.failed` event with `source: plugin:reminders` starts one run (a second event with the same `deliveryId` starts none); cursor survives re-creation | cursor stored in settings `protocols.cursor` |
| P28.2.6 | Recovery at boot and graceful stop; compose wiring | `engine.ts` (`recover`), `apps/core/src/compose-protocols.ts` (new, keeps `compose-regions.ts` under the size limit; timers in `compose-timers.ts`), `apps/core/src/main.ts` stop path | hypothalamus.md "Restart"; `docs/ARCHITECTURE.md` boot order | `protocols-recovery.e2e.test.ts` in `apps/core/src/`: run waiting 1 h, restart, advances; run mid-step, restart, no duplicate delivery; waiting `ask` keeps its deadline | recovery proven with a real SQLite file |
| P28.2.7 | Audit rows and brain events from the engine; register `protocol.*` kinds in `AUDIT_SUBJECT_FIELDS` and `registerMySummary`; add the `brain.hypothalamus.*` records to the activity feed table (P27.1.4) | `engine.ts`, `audit` port, `brain-events/emit.ts` use, `packages/contracts/src/audit.ts`, `apps/core/src/modules/audit/mine.ts`, `docs/specs/thalamus.md` | hypothalamus.md "Audit, events"; brain-events.md | every start, step, end writes `protocol.run.*` and the matching event; payloads parse; no message text in audit detail | rows and events asserted in `engine.test.ts` |
| P28.2.8 | Settings `protocols.tickMs` (5000 to 60000, default 15000, decided Nov 10: the same beat as the host scheduler and light on the laptop), `protocols.maxPerPerson` (default 20) and `protocols.maxPerPersonRunsPerDay` (default 20): schema with bounds and defaults, store in the settings repo; the engine tick (P28.2.6) and the caps (P28.3.1) read them, never a literal | `packages/contracts/src/protocols.ts` (`ProtocolSettingsSchema`), `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `apps/core/src/modules/hypothalamus/settings.ts`, `settings.test.ts` | hypothalamus.md "Audit, events, settings, errors" | `settings.test.ts`: defaults when unset, bounds refuse 4999 and 60001, a stored value is read by the tick without a restart of the repo | no limit of the engine is a literal |

`bun run check` passes; `bun run smoke` is not extended yet (no process surface).

### Phase 3 — Service, RPC, CLI

Goal: protocols can be created, versioned, paused and inspected through the same service from every surface.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.3.1 | Service: create, new version, enable, pause, delete, runs; pre-approval records; per-person caps (read from the `protocols.*` settings of P28.2.8); registers protocols, runs, proposals and agenda in the P26 removal registry | `modules/hypothalamus/service.ts`, `removal.ts`, `service.test.ts` | hypothalamus.md "Authoring", "Errors" | owner saves `act` with approval; a member's call on another person's protocol is `NOT_FOUND`; stale version is `CONFLICT`; cap reached refused; every change writes its audit row; removing a person keeps their protocols, runs and agenda 30 days, adds them to `people export` and purges them with the rest | service tests pass |
| P28.3.2 | Contract procedures and handlers, client methods | `packages/contracts/src/contract.ts`, `modules/hypothalamus/procedures.ts`, `packages/client/src/client.ts`, `apps/core/src/compose-protocols.ts` | hypothalamus.md "RPC"; permissions.md (no new capability; `chat` for own) | `procedures.test.ts`: member lists only own; owner lists own plus `keith`; unauthenticated refused; the contract walk test of `capabilities.test.ts` still passes | `bun test ./apps/core ./packages/contracts` passes |
| P28.3.3 | CLI `keith-core protocols` | `apps/core/src/cli/protocols-command.ts`, `program.ts`, `cli.test.ts` | core-cli.md (command list), cli.md | `list`, `show`, `pause`, `resume`, `delete`, `runs` print; a member id is refused for owner-only options | `--help` text lists the commands |
| P28.3.4 | Proposals: store, confirm (re-validated with the confirming person as author), dismiss, expiry in the prune tick | `service.ts`, `procedures.ts`, prune tick in `apps/core/src/compose-timers.ts` | hypothalamus.md "Proposals" | a proposal never becomes a protocol until confirmed; confirm by another person is `NOT_FOUND`; expired proposal cannot be confirmed | proven in `service.test.ts` |
| P28.3.5 | RPC and CLI for the protocol settings: `protocols.settings.get` (`settings.read`) and `protocols.settings.set` (`settings.manage`, owner, step-up), audit `settings.protocols.set` with `{ from, to }`; CLI `keith-core protocols settings [--tick-ms N] [--max-per-person N] [--max-runs-per-day N]`; client methods | `packages/contracts/src/contract.ts`, `modules/hypothalamus/procedures.ts`, `apps/core/src/cli/protocols-command.ts`, `packages/client/src/client.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | hypothalamus.md "RPC", core-cli.md, permissions.md (step-up matrix row) | `procedures.test.ts`: a member cannot set, owner without step-up gets `STEP_UP`, out-of-bound value is `BAD_REQUEST`, each change writes one audit row; `cli.test.ts` prints and sets | the limits can be read and changed by the owner and audited |
| P28.3.6 | Setting `approvals.pingBeforeHours` (default 2, 1 to below `approvals.ttlHours`): added to `admin.approvals.get/set` (P24.1.3), audited as `settings.approvals.set`, CLI `keith-core approvals ping-before [hours]`; the TTL setter refuses a TTL at or below the stored ping value | `packages/contracts/src/approvals.ts`, `apps/core/src/modules/amygdala/settings.ts`, `apps/core/src/cli/ops-commands.ts`, `apps/core/src/modules/admin/procedures.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`) | amygdala.md (Approval expiry: the ping setting), hypothalamus.md "Built-ins", core-cli.md | `settings.test.ts`: default 2, 0 and a value at or above `ttlHours` refused, a TTL change below the ping value refused; `cli.test.ts` get and set; one audit row per change | the owner can move the ping and the setting is read by P28.4.2 |

`bun run check` passes.

### Phase 4 — Agent tools, TUI, built-ins

Goal: a person can use protocols from the chat and the TUI, and the two built-ins protect the owner.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.4.1 | Agent tools `protocol_propose`, `protocol_list`, `protocol_pause`, `protocol_answer`; front instructions block | `modules/hypothalamus/tools.ts`, `modules/wernicke-broca/agent.ts`, `apps/core/src/compose-protocols.ts` | hypothalamus.md "Agent tools"; wernicke-broca.md | tool tests: runs as `ctx.principal`; `protocol_answer` of another person's run refused; propose writes a proposal and no protocol; a worker session has no such tools (tool list assertion); a room session has none (P30 test reuses it) | `apps/core/src/principal-hooks.test.ts` style test passes |
| P28.4.2 | Built-in `approval-stale` and `reminder-missed` (seed, definitions, doctor line) | `modules/hypothalamus/builtins.ts`, `builtins.test.ts`, `apps/core/src/cli/doctor/checks/protocols.ts` (new, listed in the table of `cli/doctor.ts`) | hypothalamus.md "Built-ins"; amygdala.md (a line: the ping before expiry) | scripted clock: approval pending for `ttl - 2h` gets one ping, answered approval gets none (guard), two pending get two; TTL changed while a run waits: no early or late ping; `approvals.pingBeforeHours` (P28.3.6) change applies to runs not yet started; failed reminder delivery gets the retry ladder once | built-ins are seeded once, re-seed is a no-op, an owner can pause them |
| P28.4.3 | TUI section `Apps > Protocols` (list, detail, pause, delete, proposals, reminder-ladder form) | `apps/tui/src/features/manage/protocols/{index.ts,use-protocols.ts,protocols-state.ts,protocols-actions.ts,protocols-state.test.ts}`, `sections.ts`, `apps/tui/src/features/home/menu-state.ts`, `packages/client/src/client.ts` | tui.md (Menu, Manage sections), tui-design.md | state tests: rows, tone of a paused protocol, a proposal row, the owner's settings rows (`Limits`: tick, per person, runs a day; `Ping before expiry`) that call `protocols.settings.set` and `admin.approvals.set` with a step-up replay; `menu-state.test.ts` shows `Protocols` under Apps for a member and the owner; actions call the client | PTY smoke of the screen is covered in phase 5 of `bun run smoke` step below |
| P28.4.4 | Answer card and banner: an `ask` shows in chat and Protocols; a pending proposal shows a one-line notice | `apps/tui/src/features/chat/` (data part renderer), `packages/client` | tui.md (chat data parts) | render test: card with options; answering calls `protocols.answer` | the card disappears after an answer |
| P28.4.5 | Smoke: owner creates a time protocol with `keith-core` (fake provider), it fires once, survives a restart, shows in the TUI list, a member sees only their own | `scripts/smoke/protocols.ts` (hooked from `scripts/smoke.ts`), `docs/manual-testing.md` (new scenario) | manual-testing.md | `bun run smoke` new block green | smoke passes |

`bun run check` and `bun run smoke` pass.

### Phase 5 — Agenda

Goal: Keith keeps a confirmed agenda per person and lets presence use it.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.5.1 | Agenda service and RPC (`agenda.*`), prune of old items, owner access audited | `modules/hypothalamus/agenda.ts`, `procedures.ts`, `packages/contracts/src/protocols.ts` | hypothalamus.md "Agenda"; sharing-and-privacy.md (agenda is personal data) | a member reads only own; the owner reading a member's agenda writes `acl.owner-access`; items 30 days after end are purged | tests pass |
| P28.5.2 | Agent tools `agenda_add`, `agenda_list`, `agenda_done` and the extraction rule in the front prompt (confirm when unsure) | `tools.ts`, `wernicke-broca/agent.ts` | wernicke-broca.md; hypothalamus.md "Agenda" | scripted model: "meeting at 9" with a clear time stores `confirmed`; vague "later" asks first and stores nothing before the answer; tool always writes for `ctx.principal` | prompt test with `scripted-providers.ts` |
| P28.5.3 | Proposal from an item (meeting gives "keep quiet" proposal) | `agenda.ts`, `service.ts` | hypothalamus.md "Proposals from the agenda" | one proposal per item; proposal has no `act`; confirm creates a `time` protocol; dismiss never re-proposes | tests pass |
| P28.5.4 | Register the agenda as a `PresenceOverlay` with `parietal.addOverlay` (`busyNow`, `noteFor`) | `agenda.ts`, `modules/hypothalamus/index.ts`, `apps/core/src/compose-regions.ts` (registration only; P27's compute is not edited) | hypothalamus.md "Presence feed"; the P27 spec (`parietal.md` "Ports") names the overlay interface | with an item 09:00 to 10:00: `busyNow` true at 09:30, `noteFor` "in a meeting until 10:00"; the other person's presence line never contains the agenda text beyond the disclosed note | leak test: another principal's model context contains only the disclosed line |
| P28.5.5 | Leak test across the plan: another person's protocols, runs, proposals and agenda never enter a model context | `apps/core/src/protocols-leak.e2e.test.ts` (style of `guests-leak.e2e.test.ts`) | ADR-0020 §2 | scripted model for person B whose context is captured: no text of A's protocol, run, proposal or agenda item | test passes |
| P28.5.6 | **Eval scenario `agenda` (R13, one of the four in P22 "Shared items").** Agenda extraction does not invent times: from a chat message the front agent stores only a time the person said. `apps/core/evals/agenda/` follows `apps/core/evals/news/`: `run.ts` with `--scripted` (offline, scripted model, no key, no cost) and the default real-model mode (`OPENROUTER_API_KEY`, `--max-usd` cost cap, report `data/evals/agenda-<date>.json`); `cases.ts` holds messages with a clear time (stored `confirmed`), a vague one ("later", "sometime next week": asks first, stores nothing) and one with no time at all (stores nothing), and a scorer that fails when an item carries a time the message did not contain; package.json scripts `eval:agenda` at the root and in `apps/core` through `bun pm pkg set` (as `eval:news`). The paid run belongs to P32.3.5. | `apps/core/evals/agenda/run.ts`, `cases.ts`, `run.test.ts`, `package.json` and `apps/core/package.json` (`bun pm pkg set scripts.eval:agenda=...`) | `docs/specs/evals.md` (every stored time appears in the message; zero invented times; exit 1 below it; report path) | `run.test.ts` runs `--scripted` offline: a scripted model that breaks the rule fails the run (exit 1), one that keeps it passes | the `--scripted` run passes inside `bun run check`; the real-model run is left to P32.3.5 |

`bun run check` and `bun run smoke` pass.

### Phase 6 — Reminders become protocols (ADR-0024 §5, final phase): P28.6.1 built, P28.6.2 to P28.6.4 NOT BUILT (ADR-0028)

Goal: a reminder is a `time` trigger with one `notify` or `wake` step inside; the plugin API, tools and TUI view do not change, and delivery stays exactly once.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P28.6.1 | Spec and host port: `docs/specs/plugins/reminders.md` "Internals" and a host port `k.protocols` in `packages/host` (`upsertTime({ key, owner, when (at or cron), step (notify or wake), text })`, `cancel(key)`, `onRunEnd(handler)`), implemented by the hypothalamus service (a plugin imports only `@keith/host`, so it cannot call the engine directly). The reminder text is stored as the fixed step text (the engine never templates it); texts over the step limit are refused when the reminder is created. | `docs/specs/plugins/reminders.md`, `docs/specs/plugins.md`, `packages/host/src/types.ts`, `packages/host/src/testing/memory-extras.ts`, `modules/hypothalamus/host-port.ts` | reminders.md, plugins.md (Context `k`) | `host.test.ts`: the memory host records `upsertTime` and `cancel`; the port refuses a step to another person unless the creator is the owner | port typed, fake exists |
| P28.6.2 (not built: ADR-0028) | The reminders plugin creates, updates and cancels reminders through `k.protocols`; the protocol run is the fire (run id = the P25 delivery key); `lastSlot`, the fires table and the 48 h counter are replaced by the run's unique `(protocol_id, trigger_ref)` and `maxRunsPerDay`; the plugin's row status follows `onRunEnd`; the owner's cancel (P24.6.5) and catch-up (P24.6.3) rules are kept by the same port | `plugins/reminders/operations/*.ts`, `plugins/reminders/fire.ts`, `plugins/reminders/store.ts`, `modules/hypothalamus/host-port.ts` | reminders.md (Operations, Restart, Limits) | the whole `reminders.test.ts` and `plugins-reminders.e2e.test.ts` suites unchanged and green (hard kill between claim and delivery: one message; two missed cron slots: one wake; owner cancel notice; catch-up after disable) | no behaviour change visible to a person |
| P28.6.3 (not built: ADR-0028) | Migrate existing reminders: a plugin migration step (or boot task, idempotent by trigger ref) creates the protocol of every `active` reminder and keeps its `last_slot` as the first trigger ref; the old fires table stays, unread (dropping it is not planned: P22 "Not planned", residue row in P32) | `plugins/reminders/migrations/` (generated), `modules/hypothalamus/host-port.ts`, `packages/db/src/migration-*.test.ts` style test | reminders.md, db.md (retention inventory) | a seeded database with active, done and cron reminders migrates (P26.1.4 drill): same next fire times, no duplicate fire after the first boot, done rows untouched | upgrade drill passes |
| P28.6.4 (not built: ADR-0028) | `reminder-missed` becomes the native retry ladder for reminder runs (P28.4.2 built-in re-pointed at the run's own failure); docs and roadmap | `modules/hypothalamus/builtins.ts`, `docs/specs/hypothalamus.md`, `docs/specs/plugins/reminders.md`, `docs/ARCHITECTURE.md` | hypothalamus.md "Built-ins" | a failed reminder run gets the ladder once; the reminder list shows the same status as before | reminders and protocols agree on one run per fire |

`bun run check` and `bun run smoke` pass.

## Exit criteria

- [x] No "Changes in P28" marker of this plan is left in `docs/specs` (`grep -rn "Changes in P28" docs`).
- [x] `docs/specs/hypothalamus.md` written; `brain-events.md`, `db.md`, `core-cli.md`, `tui.md`, `wernicke-broca.md`, `amygdala.md`, `permissions.md` (no change needed noted) updated in the steps that changed behaviour.
- [x] Contracts in `packages/contracts` (protocols, brain events), exports snapshot regenerated, no type outside contracts.
- [x] Migration `0017` generated by drizzle-kit and applied through `migrateWithBackup` (the P26 backup ran first; `upgrade-drill.test.ts` covers the previous shape); not tried on a copy of the owner's real database (P32).
- [x] Tests per phase green: engine recovery, authoring table, leak test, built-ins.
- [x] `bun run check` and `bun run smoke` pass.
- [ ] Manual scenario (Owner to run) executed once by the owner (Scenario 22 in `docs/manual-testing.md`; not done: see Not verified).
- [x] `docs/ARCHITECTURE.md` region table has `hypothalamus`; `docs/plans/active/P22-one-keith-foundations.md` rows marked done; plan moved to `docs/plans/done/` by the orchestrator at the end.

## Risks and mitigations

- **A protocol is a prompt-injection or privilege path.** Texts and instructions are fixed strings, never templated from data; `act` needs a stored pre-approval with the exact input hash; Keith can only propose; `notify` to another person is owner-only. Tests cover each.
- **Duplicate delivery after a crash.** Two guards: the run row's `(protocol_id, trigger_ref)` unique key and the delivery key `<runId>:<stepId>:<visit>`. The eharness `inject({ key })` dedupe is best effort across instances (`05-session-and-storage.md` 1044); the core is one process per data dir (`core.lock`), so the window is a crash between two writes and costs at most one repeated `wake`. Accepted and documented.
- **Dependency on P25 and P27 contracts.** Step P28.2.3 and P28.2.5 start by reading those specs and use the ports that P25 and P27 export (`deliver`, `lastSign`, `disclosedFor`) through thin adapters in `modules/hypothalamus/ports.ts`; no port is defined here except the agenda overlay this plan registers with P27 (`parietal.addOverlay`). If a port is missing in the owning spec, the first commit of this plan adds it there first (rule 1).
- **Tick cost on an M2 laptop.** The tick returns at once when nothing is due; no polling of models; the feed cursor reads only new rows. A test asserts zero queries beyond the due-run check on an idle engine.
- **Agenda extraction quality.** Model errors are possible; items are `tentative` unless the person confirmed, a tentative item never makes `busy`, and the person can list and dismiss items.
- **Clock and zones.** Quiet hours and `time.between` use the core's zone (the reminders limitation, doc gap 8 is not planned, ADR-0027 §29).

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0024 §1 (protocol as data, versioned) | P28.1.1, P28.1.2, P28.1.4, P28.1.5 |
| ADR-0024 §2 (deterministic engine, durable runs, audit and events) | P28.2.2, P28.2.5, P28.2.6, P28.2.7 |
| ADR-0024 §3 (authoring rules, pre-approval, Keith proposes) | P28.1.6, P28.2.4, P28.3.1, P28.3.4, P28.4.1 |
| ADR-0024 §4 (built-ins `approval-stale`, `reminder-missed`) | P28.4.2 |
| ADR-0024 §5 (reminders become protocols, plugin API kept) | P28.6.1 (the host port); the move itself is not built, see ADR-0028 (reminders keep their own scheduler) |
| ADR-0024 consequences (TUI `Apps > Protocols`, agent tools) | P28.4.1, P28.4.3, P28.4.4 |
| Removal registry part for protocols and agenda (ADR-0027 §26) | P28.3.1 |
| Agenda as a `PresenceOverlay` registered with P27 | P28.5.4 |
| ADR-0025 §2 (agenda, confirm when unsure, presence note) | P28.5.1, P28.5.2, P28.5.3, P28.5.4 |
| ADR-0027 §10 (the ping of `approval-stale` before the expiry, relative to `expiresAt`, TTL change safe) | P28.4.2 (the expiry itself is P24.1.4) |
| ADR-0027 §16 (a missed reminder is reported to its creator; delivery failure comes from P25) | P28.4.2 |
| F-009 (supports; owner P24) | P28.4.2 for the owner ping; expiry and age display are P24.1.3 to P24.1.5 |
| F-010 (supports; owner P25) | P28.4.2 (ladder); delivery report is P25 |
| ADR-0020 §2, §3 (isolation, one principal per turn) | P28.2.3, P28.5.5 |
| Not placed here: F-007 (stop cancels the parked approval, a final task never returns to `running`) | ADR-0027 §11 owns it; P22 M3 listed it by mistake |

## Owner to run

Use `bun run manual:setup`, `bun run manual:core` and `bun run manual:tui` as in `docs/manual-testing.md` (KEITH_HOME=.data/test; reset with `rm -rf .data/test`).

1. Sign in as the owner, open Home, `space`, `Apps`, `Protocols`. Expect the two built-ins (`approval-stale`, `reminder-missed`) listed as `keith`, enabled, `owner-absence` absent (P29).
2. In Protocols choose `new reminder ladder`: time in 2 minutes, text "stand up", repeat 2, ask "done?". Expect a `time` protocol; at the time a card appears in chat; answering `yes` ends the run (`done`), no answer for the timeout shows `timeout` in the run history.
3. Stop the core with the ladder waiting (`ctrl+c` in the core tab), start `bun run manual:core` again. Expect the run to continue and no second message for the step already sent; `keith-core protocols runs` shows each step once.
4. Add a member (`bun run manual:admin`), sign in as them in a second TUI. Expect their Protocols list to show only their own; the owner's protocols are absent. Try `keith-core protocols show <owner protocol id>` as the member: not found.
5. As the member say "I have a meeting tomorrow at 9 to 10". Expect Keith to answer and add an agenda item; a proposal "keep 09:00 to 10:00 quiet" appears in Protocols; `confirm` it and see a `time` protocol. As the owner, the member's presence line reads "busy" or the disclosed note only (P27 rules), never the agenda text.
6. Ask Keith as the member to "message the owner every hour". Expect Keith to decline or propose only a reminder to the member themselves (no step to another person); an `act` is never proposed.
7. Start a shell approval for a member (a node command), leave it. Expect the owner to get one ping before the expiry window (set `approvals.ttlHours` to 1 for the test); answering first cancels the ping.
8. `keith-core audit list` shows `protocol.*` rows; as the member, `audit.mine` shows the rows about their own protocols.

## Gate evidence (Nov 10, 2026)

- Commits 72744d8 (spec) to the timer fixes; `bun run check`: 3691 pass, 0 fail, check-imports, check-size, check-exports (19 entries) ok. `bun run smoke`: SMOKE PASS, 68 steps (block `scripts/smoke/protocols.ts`).
- Migration: core `0017` (`protocols`, `protocol_versions`, `protocol_runs`, `protocol_run_steps`, `protocol_proposals`, `agenda_items`), generated, on top of the P26 backup.
- **Phase 6 was not built (ADR-0028).** Only P28.6.1 (the host port `k.protocols`) exists. Seven conflicts between the protocol model and reminders (cross-person steps, billing, per-creator rate limit, caps, disabled plugin, names, the exactly-once tests). Exactly-once delivery is P25 and the retry ladder is the built-in `reminder-missed`.
- Decisions: `protocols.tickMs` default 15 s (range 5 to 60 s); the instance owner is read at use (a keith-owned run stores the owner found at its start); seeding a built-in writes no audit row; a protocol `act` step with an owner pre-approval of the exact input (hash of operation and input) runs without a live approval, only for owner-owned or keith-owned protocols, with an audit row per execution (ADR-0024 section 3 exception, written in `motor.md` and `amygdala.md`); operation names that touch transfer, owner, grant, secret, token, password, role or permission are refused for everyone.
- Deviations recorded by the implementers: run id is a digest of protocol id and trigger ref (a re-fire has the same id); `notify` is mode `note` (no model turn); `WAKE_COST_USD` 0.02 is an estimate; `protocols.save` creates (no id) or versions (id); the approval ping follows `approvals.pingBeforeHours` without rewriting the stored definition (a ping raised so the due time moves earlier fires late, not early); the ping default 2 h means a TTL of 1 or 2 h is refused; built-in `approval-stale` runs per approval (`approval:<id>` ref); agenda: `agenda.cancel` replaces `agenda.update`, tentative items have no promotion path; the answered state of an `ask` card lives per view (the RPC refuses a second answer with CONFLICT).
- Fixed by the orchestrator after the agent reports: a corrupted shared git index after overlapping agent commits (reset to HEAD, two damaged files restored); an empty stray file; seeding wrote audit rows that six audit tests counted; the smoke harness did not acknowledge the privacy panel and used the old owner PIN; `home-login` and the view teardown test failed in the full run because the protocol timer read `protocols.tickMs` from a closed database inside a promise `finally`: it now falls back to the default and stops after three unreadable reads.

## Not verified

- The manual scenarios of "Owner to run" (Scenario 22) by eye on a real terminal and a real core: the Protocols section, the reminder ladder, an `ask` card answered from chat, the member's agenda proposal, the approval ping.
- The eval `agenda` real-model mode (`--scripted` only).
- A pre-approved `act` on a real node (tested with fakes).
- Idle cost measured on the real laptop (tested with counting fakes: an idle tick is `claimDue` plus one feed `lastSeq` when the built-ins are enabled).
- The migration on a copy of the owner's real database (P32 phase 3).
