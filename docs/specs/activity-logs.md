# Activity logs (model-call log per session)

Status: **built (P36, Nov 11, 2026).** Decision: ADR-0032. Plan: `docs/plans/done/P36-activity-logs.md`. Harness: eharness 0.12.0, spec 12 §7.
Code: `apps/core/src/modules/audit/activity-logs/` (`capture.ts`, `redact.ts`, `truncate.ts`, `pack.ts`, `queue.ts`, `settings.ts`,
`observe.ts`, `rights.ts`, `removal.ts`, `procedures.ts`, `coverage.test.ts`, `index.ts`), `apps/core/src/cli/logs-command.ts`,
`packages/contracts/src/session-kinds.ts`, `packages/contracts/src/activity-logs.ts`, `packages/db/src/schema/activity-logs.ts`,
`packages/db/src/activity-logs-repo.ts`, `packages/client/src/activity-logs.ts`, `apps/tui/src/features/manage/logs/`. Region: none new (ADR-0004);
the capture is a core plugin next to the budget, the store sits beside `modules/audit`.

Every rule below is the contract the code must meet. A section the code does not meet yet carries a **Changes in P36.x.y** marker; the step that
lands the code deletes its marker in the same commit.

## Purpose

The owner (and each person for their own data) can read everything Keith sent to an AI: a list of sessions with their date range, kind, app,
primary model, provider and cost; a session drawer with its generations; and a generation drawer with latency, throughput, tokens in and out,
cost, finish reason, streaming, fallbacks, the messages sent, the raw request and the raw response. A session has a **registered kind** (`chat`,
`task`, `room`, `guest`, `dream`, `aux`), so readers stop parsing id prefixes. Nobody reads another person's log except the owner, through an
audited path (ADR-0020 §4). The log holds personal data (prompts carry messages, memory and tool results), so the rights model is part of the
first version, not a later addition.

The log is informational. The budget ledger (`eh_budget_*`, `budget.md`) stays the source of truth for money. Nothing here changes a call, a
turn or a budget charge.

## Session kinds (ADR-0032 §2)

`packages/contracts/src/session-kinds.ts` holds `SESSION_KINDS`, a frozen list of rows `{ kind, label, app, matches(id), owner(id) }`, and the pure
helpers `sessionKindOf(id)`, `sessionOwnerOf(id)` and `sessionRefOf(id)` (`{ kind, personId?, roomId?, generation?, parent? }`).
`apps/core/src/platform/sessions.ts` keeps its exports (`frontSessionId`, `generationOfSession`, `personOfSession`, `rootSessionOf`,
`isGuestSession`) and implements them with the registry, so no call site changes. Existing ids do not change.

| Kind | App label | Id rule | Person (owner) | Room | Generation | Parent |
| --- | --- | --- | --- | --- | --- | --- |
| `task` (checked first) | Worker | `front:<person>[:g<n>]:agent:<task>` (contains `:agent:`) | the person of the root | none | the root's `g<n>` | the root front session |
| `chat` | Front | `front:<person>` or `front:<person>:g<n>` | `<person>` | none | `n`, 0 without the suffix | none |
| `room` | Room | `room:<roomId>:g<n>` | none (the room owns it) | `<roomId>` | `n` | none |
| `guest` | Guest | `guest:<random>` | none (guests are not people, ADR-0017) | none | none | none |
| `dream` | Dreaming | `dream-judge:<uuid>` | not in the id: stored from `ctx.principal` at the first call (`llm_sessions.person_id`); null when the principal is missing | none | none | none |
| `aux` | Helper | `aux:<name>:<personId>`, `<name>` matches `[a-z0-9-]+` | `<personId>` | none | none | none |

Rules:

- A test fails when two rows match one id, and when an id written by `platform/sessions.ts` or by `corpus-callosum` (`room:`), `guests`
  (`guest:`), `hippocampus/dream/judge.ts` (`dream-judge:`) or `aux` matches no row.
- An id that matches no row is **not captured**: the hook records nothing for it and counts it in `logs.status` as `unmatched`. An unowned log
  would have no reader.
- Heartbeat and protocol runs are turns of a front session, so they are not kinds. The turn kind is stored per call (`trigger`, below).
- The kind is also stored in `llm_sessions.kind`, computed at the first call. Listing and filtering read the column, and a later change of an id
  rule never moves an old row to another kind.
- Adding a kind is one registry row, its id rule, and the matching `CHECK` value in a migration.

The registry and the helper delegation. The `task` kind is checked before `chat`, because a worker id starts with `front:`.

### Call kinds and turn kinds

`call_kind` is the eharness `ModelCallKind` (`step`, `compaction`, `flush`, `other`) plus `embedding`, which is reserved and written by nothing
today (the core makes no embeddings). `trigger` is the eharness `TurnKind` of the turn that made the call: `send`, `respond`, `regenerate`,
`edit` or `wake`; `none` when the call has no turn. ADR-0032 §2 names the values `user`, `wake` and `respond`; the harness type has no `user`
(see "Harness check"), so the stored value is `send`.

## Capture (ADR-0032 §1, §4, §5)

**Hook.** The core plugin `activity-logs` (`modules/audit/activity-logs/capture.ts`) registers the `model.call` hook. It maps each
`ModelCallEvent` to one call row and its session row:

- session kind and person from the registry and `ctx.principal` (the principal is the person of the session, ADR-0069);
- room from the id, speaker from the room turn (`speaker_id`, rooms only, one per call);
- cost and `cost_source` from `costUsd` and `costSource` (`provider` or `estimate`); absent cost stays null;
- `upstreamProvider` as `upstream_provider` and `provider` as the provider of the record;
- fallbacks, error name and message from the record.

The hook never awaits the stream and never throws. eharness fires it after the call ends and does not await it (`W_HOOK_FAILED` on a throw, with no
effect on the call). Capture charges no budget.

**Queue.** `queue.ts` is a bounded in-memory queue. A writer drains it in batches: one transaction per batch inserts the calls, their bodies and
the session upserts (the totals of `llm_sessions` move in the same transaction as the call insert). On overflow the **oldest** event is dropped and
the drop counter rises; `logs.status` reports it. A store error is logged and swallowed. `flush()` drains the queue on core stop. The queue
capacity and the batch size are constants in `queue.ts`, not settings.

**Aux calls (outside a turn).** A model call made outside an agent turn uses `ctx.observeModel(model, { kind })` when a tool has the context, or
`observeModel(model, report)` (eharness) otherwise, with the session it belongs to. The web search call (`cortex/web-search.ts`, `generateText`
with `searchModel`) is recorded as `aux:web-search:<person>`, the person who asked: eharness 0.13.0 passes the session context to the search
function (`options.ctx.principal`), and a worker's principal is the delegating turn's person. A search without a principal is recorded as
`aux:web-search:unknown`. Call kind `other`. The
permission classifier (`modelClassifier`, `onModelCall`) is not wired today; when it is, it uses the same path. A model passed to `observeModel`
must be a local model object: a plain gateway string is resolved through `AI_SDK_DEFAULT_PROVIDER` or the AI Gateway, and an unresolvable one is
not observed at all (eharness rule 7).

`observe.ts` exports `observeAux(name, personId, model, deps)` (eharness `observeModel`; each report is built by the
same `toRecord` as a turn's call, with `kind: 'other'` and the session `aux:<name>:<personId>`) and `auxSessionId`. `ActivityCapture.observeAux`
binds the queue and the settings; the workers' `webSearch` gets the observed search model (`WorkerDeps.observeAux`). An empty name matches no
kind and its row is dropped. Cost of an aux call is null (no catalog price is passed). Tests: `observe.test.ts`. The search is attributed to the
person who asked (`cortex/web-search.test.ts`).

**What each agent adds.** Every `defineHarnessAgent(` site in `apps/core/src` lists the plugin; `coverage.test.ts` scans the sources and fails on a
site without it. Audit F16 (`docs/research/inference-cost-audit.md`, section 6) found no rows for workers, rooms, guests, web search and wake
turns in its sample. The wiring is in place (front: `compose-regions.ts`; workers: `createCortex` in `compose-regions.ts`, `workers.ts`;
rooms: `compose.ts` and `compose-rooms.ts`; guests: `compose-regions.ts` and `compose-guests.ts`; web search: `observeAux` in `workers.ts`), and
`activity-logs-agents.e2e.test.ts` now runs one worker turn, one room turn and one guest turn on a real core and reads each row back: the
worker is a `task` session of its person with a `step` call, the room a `room` session with the speaker and no person, the guest a `guest`
session with no person and no room. The empty sample predates those rows, or had no such traffic. Web search is recorded as
`aux:web-search:<person>` (test: `cortex/web-search.test.ts`): the search function gets `ctx` from eharness 0.13.0, so the row names the person
who asked; `unknown` only without a principal. Wake turns are front turns (`trigger` `wake`), recorded by the front plugin.

| Agent | Where | Session kind | Adds |
| --- | --- | --- | --- |
| Front | `modules/wernicke-broca/agent.ts` (`createFrontAgent`) | `chat` | steps, compaction and flush calls; turns `send`, `respond`, `wake` (protocol and heartbeat turns are front turns) |
| Room | `modules/corpus-callosum/agent.ts` (`createRoomAgent`) | `room` | `speaker_id` on each call; the session belongs to the room, not to a member |
| Worker | `modules/cortex/workers.ts` | `task` | parent session on the row; the worker's own calls |
| Guest | `modules/guests/guest-agent.ts` | `guest` | figures always; bodies only when `guestBodies` is on |
| Dream judge | `modules/hippocampus/dream/judge.ts` (P35) | `dream` | one judge call per run, call kind `other` |

The four agents record their calls. The dream judge (P36.3.4) takes an optional `activityLogs` plugin in `JudgeDeps`, appended to its
plugins; the coverage test has no exemption left. Open: no composition builds `JudgeDeps` yet (P35's run wiring), so the caller passes the
plugin when it lands.

## Data model (ADR-0032 §3; one additive migration)

Three tables, generated by Drizzle (never edited by hand), with **no foreign keys** (as `front_generations`). The migration is taken after a backup
(`migrateWithBackup`, `db.md`). The number is the next free one at generation time (`0022_parched_cardiac.sql` is the last one today). Costs are
integer micro-dollars (`cost_micro` = USD x 1 000 000, rounded). Times are ISO 8601 text in UTC with milliseconds.

**`llm_sessions`** (one row per session): `id` (PK, the session id), `kind` (CHECK: `chat`, `task`, `room`, `guest`, `dream`, `aux`), `person_id`
(nullable), `room_id` (nullable), `app` (the label), `first_at`, `last_at`, `calls` (integer), `cost_micro` (integer), `primary_model`,
`primary_provider` (the model with the most calls), `bodies_off` (1 when the session holds no bodies). Indexes: `(person_id, last_at)`,
`(room_id, last_at)`, `(last_at)`.

**`llm_calls`** (one row per call): `id` (PK, UUIDv7 from eharness), `session_id`, `call_kind` (CHECK: `step`, `compaction`, `flush`, `other`,
`embedding`), `trigger` (CHECK: `send`, `respond`, `regenerate`, `edit`, `wake`, `none`), `turn_id` (nullable), `step_index` (nullable),
`message_id` (nullable), `started_at`, `duration_ms`, `first_chunk_ms` (nullable), `status` (CHECK: `ok`, `error`, `aborted`), `finish_reason`
(nullable), `model_id`, `provider`, `upstream_provider` (nullable), `tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `reasoning` (integers,
nullable when unreported), `cost_micro` (nullable), `cost_source` (CHECK: `provider`, `estimate`, null), `fallbacks` (nullable text), `error_name`,
`error_message` (nullable), `request_bytes`, `response_bytes` (integers, the size before gzip), `body_state` (CHECK: `stored`, `truncated`, `off`,
`purged`), `speaker_id` (nullable, rooms). Indexes: `(session_id, started_at)`, `(started_at)`.

**`llm_bodies`** (one row per call that holds bodies): `call_id` (PK), `request`, `response`, `output` (BLOB, gzip of the redacted JSON, `Bun.gzipSync`).
Bodies sit in their own table so retention can purge them without touching the figures.

`body_state` values: `stored` (all three blobs kept), `truncated` (kept, but cut by the size rule), `off` (not captured: `captureBodies` off, or a
guest with `guestBodies` off), `purged` (removed by retention; the row keeps its figures).

Schema, migration and repo: `insertCalls(batch)`, `listSessions`, `getSession`, `listCalls`, `getCall`, `getBodies`,
`purgeBodiesBefore`, `purgeBefore`, `purgePerson`, `exportPerson`, `status`.

## Redaction (ADR-0032 §4)

Redaction happens **before** the write, in `redact.ts`, on every body and every header, at any depth:

- a key that matches `authorization`, `api key` (`api[-_ ]?key`), `token`, `secret`, `cookie`, `credential` or `password` (case-insensitive) is
  replaced by `"[redacted]"`;
- headers are kept only from a short allow list set in `redact.ts`; every other header is dropped;
- every string for which `looksLikeSecret` (`modules/hippocampus/secret-guard.ts`) is true is replaced by `"[redacted:secret]"`.

eharness already removes provider keys from `request.options` and `response.headers` (spec 12 §7 rule 3); the walker is the second line. The
test `redact.test.ts` builds fake keys at runtime (gitleaks would flag key-shaped literals), puts them in a header, a nested key, a free-text
field and a tool result, and asserts none reaches a row or a blob. Redaction runs before truncation: a secret cut in half would escape the
detector.

## Size limits (ADR-0032 §5)

- A string field over **64 KB** is cut and marked `[truncated N bytes]`.
- A body (request, response or output of one call) over `maxBodyBytes` (default 512 KB, before gzip) is cut by dropping its longest string
  fields first, until it fits. `body_state` becomes `truncated`.
- Blobs are gzip (`Bun.gzipSync`). A busy day holds a few MB per active person after gzip.
- The raw view on the wire is capped at `MAX_RAW_WIRE_BYTES` (contracts). A larger body answers with its head and `truncated: true`.

Files `truncate.ts` and `pack.ts`.

## Settings (ADR-0032 §6)

Instance-wide, stored in the existing settings store under `logs.*` keys (`packages/db/src/schema/settings.ts`). Read at write time, so a change
applies to the next call. Changing a setting is audited (`logs.settings`).

| Key | Default | Bounds (set in `contracts`, P36.1.2) | Meaning |
| --- | --- | --- | --- |
| `captureBodies` | on | boolean | off stores figures only (`body_state` `off`) |
| `guestBodies` | off | boolean | guest agents keep their text only when on; figures are kept either way |
| `bodyRetentionDays` | 14 | 1 to 90 | bodies older than this are purged |
| `metaRetentionDays` | 365 | 30 to 3650 | figures (`llm_calls`, `llm_sessions`) older than this are deleted |
| `maxBodyBytes` | 524 288 | 65 536 to 4 194 304 | the body size cap before gzip |

The bounds are decided here and checked by the contract schema; an out-of-bound value is refused and nothing is written.

## Retention (ADR-0032 §7)

The existing prune tick (`platform/retention.ts`, `pruneRetention`) cleans the three tables with the days of the owner's settings, read at each
run: `bodyRetentionDays` (default 14) and `metaRetentionDays` (default 365). They are not rows of `RETENTION_PERIODS`, because the owner sets them;
until the settings are wired the defaults apply (`ACTIVITY_RETENTION_DEFAULTS`). Each deletion is audited as `data.pruned { table, count }`, one row
per table per tick, no id and no text (`llm_bodies`, `llm_calls`, `llm_sessions`).

- **Bodies:** `llm_bodies` rows whose call started before the body period are deleted, and their `llm_calls.body_state` becomes `purged`.
- **Figures:** `llm_calls` rows older than the meta period are deleted; a `llm_sessions` row is deleted when its `last_at` is older than the
  meta period and it has no call left.

A running call is never pruned (its row is written only when the call ends).

## Removal (ADR-0027 §26, ADR-0032 §7)

The part `modules/audit/activity-logs/removal.ts` is registered in the removal registry (`modules/people/removal-registry.ts`), like the dreaming
part (`people.md`, Rules).

- **keep:** nothing moves. The person's rows stay in the database and expire by their periods above. A room session is not the person's: it stays
  with its room (its `speaker_id` is cleared at purge, below).
- **export:** `admin.people.export` (`people.md`) adds `activity-logs.json` to the archive, written from the live rows: the person's sessions, their
  calls (including the room calls where they spoke) and the bodies decoded when they are stored. A person with no rows writes no file. Bodies are
  redacted at write time, so no secret is in the file.
- **purge:** at `purgeAt` (30 days after the removal, the same moment as the kept folder, `people.md`), the part deletes the person's sessions, their
  calls and their bodies. A room call of the person stays with its room, its body stays until the body period, and its `speaker_id` is set to null.
  It audits `data.pruned { table, count }` for each table with a count (`llm_bodies`, `llm_calls`, `llm_sessions`).

The choice of 30 days for the purge is this spec's reading of ADR-0032 §7 ("purges them on a hard purge"): the hard purge is the folder purge.

## Rights (ADR-0032 §8)

One function, `canReadSession(reader, session)` in `rights.ts`, returns `allowed`, `owner-path` or `deny`. Every procedure calls it for each
row, so a list cannot leak a row the detail would refuse. It re-checks at every call: a removed room membership or a suspension takes effect at
once.

Capabilities: `logs.mine` (own sessions; every role holds it) and `logs.read` (owner only, `OWNER_ONLY_CAPABILITIES`, see `permissions.md`).

| Reader | `chat` | `task` | `dream` | `aux` | `room` | `guest` |
| --- | --- | --- | --- | --- | --- | --- |
| The session's person, active | allowed | allowed | allowed | allowed | allowed while a member with `r` on the room | deny |
| Another active member | deny | deny | deny | deny | allowed while a member with `r`, else deny | deny |
| A suspended person, or a member no longer in the room | deny | deny | deny | deny | deny | deny |
| Owner, on the owner's own sessions | allowed | allowed | allowed | allowed | allowed while a member with `r`, else owner-path | owner-path |
| Owner, on another person's session | owner-path | owner-path | owner-path | owner-path | owner-path (allowed as a member) | owner-path |

`allowed` writes no audit row. `owner-path` writes the audit rows below, so the person finds them under `audit.mine`:

- a **list** (`logs.sessions` with `scope: everyone`): one `logs.owner-read` and one `acl.owner-access` per person per window (10 minutes, as
  `acl.owner-access` in `auth.md`), with no count (the rights decide per row);
- a **session** or **call** detail: once per session per window. A subjectless list (the guest sessions) is one row per window for the
  reader, whatever the number of sessions listed; a detail of one guest session keeps its own window;
- a **raw** read (`logs.raw`): every time, never deduplicated.

For a room session the owner-path rows name the room and the subject of each active member of the room, since the room is the owner of the
session. A guest session is read only through the owner path. Nobody else reads anything: a member's token with `logs.read` does not exist.

The list never returns content (no message text, no body). The detail returns the messages sent and the tool calls. The raw JSON is a separate
call. Another person's logs never appear in a response to a member, in a prompt, in the activity feed, or in `audit.mine` beyond the
`logs.owner-read` summary.

`rights.ts`: `createLogRights` returns `canReadSession` (pure) and `authorize` (the owner path, writes the rows). A guest session names no person, so its `logs.owner-read` row has no `subject` and no `acl.owner-access` is written; a room session writes one row per active member (`subject`, `room`). The `logs.owner-read` detail (`LogsOwnerReadAuditDetailSchema`) takes `room` and an optional `subject` for that. The room `logs.owner-read` rows are shown to each member by `audit.mine`. A member's `logs.mine` is also needed for a room session. A list of one person's sessions in a window is one `acl.owner-access` row (resource `list:<person>`), a detail is one per session (room: per member), a raw read writes its rows every time. The list row carries no count (the rights decide per row).

## RPC (ADR-0032 §9)

Area `logs` of the Keith contract (`packages/contracts/src/contract.ts`, `activity-logs.ts`). Procedures live in `modules/audit/activity-logs/procedures.ts`, built by `activityLogsProcedures(deps)` and wired in `compose-regions.ts` with the rights of `createLogRights`. Where an earlier draft of this table named other fields, the contract wins: the names and shapes below are the contract's.

The reader is the caller. `isOwner` is the `logs.read` capability (owner only). A session the reader may not see answers `NOT_FOUND`, the same as a missing one; a person the reader may not name answers `FORBIDDEN` when the person exists and `NOT_FOUND` when not.

| Procedure | Input | Output | Capability and rule |
| --- | --- | --- | --- |
| `logs.status` | none | `{ queued, dropped, sessions, calls, bodyBytes }` | `logs.mine`. The owner gets the queue (`queued`, `dropped`) and the store totals. A member gets the totals of their own sessions and zero for the queue, which is the instance's. |
| `logs.settings.get` | none | the settings | `logs.read` (owner) |
| `logs.settings.set` | a partial settings object, at least one field | the new settings | `logs.read` with step-up over TCP (contract `sensitive`). A refused value is `BAD_REQUEST` and writes nothing. Audited `logs.settings { changed }`: the names of the fields that changed, never a value. No audit row when nothing changed. |
| `logs.sessions` | `kind`, `person`, `model`, `from`, `to`, `q` (text at the start of the id), `limit` (1 to 100), `cursor` | `{ sessions, nextCursor }`, figures only | `logs.mine`. A member lists their own sessions and the room sessions of the rooms they are active in; `person` may only be the caller. The owner lists their own by default, any person with `person`, and every session with `person: 'everyone'`. The rows of each person are authorized with purpose `list` (the owner path is audited, once per window); a denied row is left out. The trigger filter of ADR-0032 §9 is not in the contract, so it is not offered; the TUI's `t` filter needs a contract field first (P36.5). |
| `logs.session` | `{ id }` | `{ session, generations, more }`; generations oldest first, at most 200 | `logs.mine`, rights decision `detail` (owner path audited once per window). `more` is true when the session holds more calls than it lists. |
| `logs.call` | `{ id }` | the figures, `messages` (role and text; binary parts as placeholders), `toolCalls`, `outputText`, `reasoning`, `truncated` | `logs.mine`, rights decision `detail`. A call whose bodies are `off` or `purged` has its figures and no messages; `call.bodyState` says which. The wire budget is `MAX_RAW_WIRE_BYTES` across the texts of the answer. |
| `logs.raw` | `{ callId }` | `{ callId, bodyState, request, response, truncated }`: the request and response JSON, pretty-printed, each cut to `MAX_RAW_WIRE_BYTES`; `null` when the part is not kept | `logs.mine`, rights decision `raw`. The owner path is audited on every call and never folded into a window. |
| `logs.purge` | `{ mode: 'bodies' or 'all', person? }` | `{ bodies, calls, sessions }` | `logs.mine` with step-up (contract `sensitive`). `bodies` removes the bodies of the person's own sessions and keeps the figures; `all` removes their sessions, calls and bodies; the room calls where they spoke stay with the room (they hold other people's words) and lose their `speaker_id`, as in the removal purge. A member purges their own; the owner may name any person (the same `FORBIDDEN` and `NOT_FOUND` rules). Audited `logs.purge { subject, mode, bodies, calls, sessions }`, counts only. |

## CLI (ADR-0032 §10)

`keith-core logs` (`core-cli.md`): `logs list [--kind k] [--person u|everyone] [--model m] [--since d] [--limit n] [--json]`, `logs show <sessionId>`,
`logs call <callId>`, `logs raw <callId> [--part request|response]`, `logs settings [--capture-bodies on|off] [--guest-bodies on|off] [--body-days n]
[--meta-days n] [--max-body-bytes n]` (no flag prints them), `logs prune`. The reads and the settings go over the owner's local socket through
`rpc.logs.*`, so each owner read of another person is audited by the same procedure as the TUI (actor: the local owner). `--person` takes a
username and is resolved to the person id first. `--since` takes `12h`, `7d` or a date. A settings change is checked against the contract
bounds and the bodies-figures rule before it is sent; a refused value writes nothing. `--help` lists them through the command registry.

`prune` is the one exception to the socket: no RPC runs the retention now, so it opens the database with the core stopped (`requireOffline`,
as `db migrate`). It applies the owner's periods to the three tables (`llm_bodies`, `llm_calls`, `llm_sessions`) with the same queries as the
prune tick, and audits `data.pruned` per table with a count. It does not run the other retention parts (`pruneRetention` in
`platform/retention.ts` covers them all, the tick does that while core runs). The `--bodies` form of the earlier draft is not built: `purge`
over the RPC removes a person's bodies (`logs.purge`).

Built in P36.5.1 (`apps/core/src/cli/logs-command.ts`, `logs-command.test.ts`).

## TUI (ADR-0032 §10)

A `Logs` section under Manage (`tui.md`, "Manage"), visible with `logs.mine` (`read: ['logs.mine']`). The owner sees a `Scope` toggle, mine or
everyone. It uses the Manage host (rows, actions, legend) and the `packages/ui` tokens, with the btop-style panels of the other sections.

Four levels, drawn one at a time in the section's pane:

1. **Sessions**: time (UTC), kind, app, id (shortened), primary model, provider, calls, cost. Newest first.
2. **Session**: the overview lines (requests, cost, models, span, app, start, input tokens, cache hit with the cached tokens), then the generations:
   time, model, tokens in and out, cache hit (the cached share of the input in percent and the cached tokens; `—` when the provider reported
   none), cost, status. The cache hit is derived in the view (`features/manage/logs/cache-hit.ts`, `cacheHitRatio` = cached / input, `cacheTotals`
   over a session's calls that reported a figure); nothing is stored for it and the contract is unchanged (`cacheRead`, `tokensIn`). A call
   after the first of its session whose hit is below 50% is marked `↓` in its cache cell, and the session overview then shows the legend
   `↓ low cache hit: under 50% of the input cached, after the first call`. The generation figures show the ratio beside the cached tokens.
3. **Generation**: the figures (status and finish reason, start, call kind, trigger and step, model, provider and upstream provider, latency,
   first chunk, streaming, speed in output tokens per second, tokens, cost and its source, fallbacks, error), the messages sent role by role
   (each cut to its first 12 lines), the tool calls, and the response.
4. **Raw**: the request, then the response, pretty printed, read-only and scrollable in one view (no tabs). A cut body is flagged at its top.

Keys: `↑↓` select a row or scroll a body, `Enter` drill in, `Esc` up one level (on the sessions level it closes the screen), `/` filters by the
start of a session id (`Enter` applies, `Esc` cancels), `f` the next kind filter, `s` scope (owner only), `r` reads the level again, and at a
generation it opens the raw JSON; `PgUp` `PgDn` page a list (past its last row or before its first, the next or previous page of sessions) and
scroll a body by a page. There is no trigger filter and no purge key in this view. The legend names the keys of the focused level and drops
pairs when the terminal is narrow. A body that is `off` or `purged` says so at the top of its view; it never shows an empty JSON.

State: `logs-state.ts`, `use-logs.ts`. Views, legend and section registration.

## Audit kinds (ADR-0032 §8)

| Kind | When | Subject | Recorded by |
| --- | --- | --- | --- |
| `logs.owner-read` | the owner read another person's sessions (`scope`: `list`, `session`, `call` or `raw`; `person`; `room` for a room session; `sessionId` or `callId`) | the person | `rights.ts` owner path |
| `acl.owner-access` | the same read, with `reason: logs`, so the person sees it with the other owner accesses | the person | `rights.ts` owner path |
| `logs.purge` | a purge (`mode`, `subject`, `bodies`, `calls`, `sessions`) | the person purged | `logs.purge` |
| `logs.settings` | a setting changed (`changed`: the field names) | none | `logs.settings.set` |
| `data.pruned` | the prune tick deleted rows, or the removal purge of a person's logs did (`table` `llm_sessions`, `llm_calls` or `llm_bodies`; `count`) | none | `platform/retention.ts`, the removal part |

The person's `audit.mine` view shows `logs.owner-read` as "the owner read your model-call log" (`registerMySummary`, a summary with a subject).

The summary and the removal part.

## Harness check (eharness 0.12.0, spec 12 §7)

Checked on 2026-11-11 against `.ref/eharness/docs/specs/12-models-and-cost.md` §7 and the installed package
`node_modules/.bun/eharness@0.12.0+e07269bd254aeda8/node_modules/eharness/dist/index.d.ts` (and `index-Cuh0HG6B.d.ts`, where the types are
declared). Docs only: no test was run.

- **Exports confirmed:** `ModelCallEvent`, `ModelCallRecord`, `ModelCallKind`, `ModelCallToolCall` and `observeModel` are exported from the package
  index. The hook `model.call` is typed as `"model.call"?(ctx, e: ModelCallEvent)` in the plugin hooks.
- **Rule 1 (one event per call, after the call, not awaited, errors swallowed):** the `observeModel` doc comment says the report "runs after the
  call ended (success, error or abort), is never awaited by the call and cannot affect it: errors it throws are swallowed". Confirmed on the
  doc level. The `W_HOOK_FAILED` path for the hook is not re-checked here.
- **Rule 2 (`aborted`, `error`):** `status` is `ok | error | aborted`, and `error` is `{ name, message }`. Confirmed.
- **Rule 3 (redaction of options, headers):** the record comments say `response.headers` drops `set-cookie` and credential-like headers. The
  options are provider-agnostic; the walker of this spec is the second line. Confirmed.
- **Rule 4 (kinds):** `ModelCallKind = "step" | "compaction" | "flush" | "other"`. `ctx.observeModel(model, options?: { kind? })` is on the
  context. Confirmed. The `other` kind covers the shared judge of `guard`.
- **Rule 5 (no listener, no wrap):** spec only; not re-checked in the package.
- **Rule 6 (size):** spec only; this is the design reason for `body_state`, the gzip and the cap.
- **Rule 7 (gateway string):** spec only. Consequence: aux calls pass a local model object (see "Capture").
- **Fields not in the spec that the plan uses:** `ModelCallEvent.turnId` is optional, so a compaction or flush call may have no turn id;
  the open verification of the plan (P36.3.1) records what the event holds. `costUsd` is absent when the model has no pricing.
- **Turn kinds:** `TurnKind = "send" | "respond" | "regenerate" | "edit" | "wake"`. ADR-0032 §2 names `user`, which does not exist. Stored
  as `send`. The owner should correct ADR-0032 §2 (not changed in this step).

Harness check status: recorded. No eharness change is needed; no ADR-0011 path.

## Tests (planned)

- `packages/contracts/src/session-kinds.test.ts`: one kind per id, no id matched twice, `task` before `chat`, `sessionRefOf` parses generation and
  parent; every id built by `platform/sessions.ts` and the other builders has a kind.
- `packages/db/src/activity-logs-repo.test.ts`: insert and read round trip, session totals equal the sum of calls, CHECK constraints, stable paging.
- `redact.test.ts`, `truncate.test.ts`, `pack.test.ts`: runtime-built fake keys never survive; the 2 MB body is cut and flagged; a normal body
  round-trips byte-equal after redaction.
- `queue.test.ts`: a throwing store does not reject the caller; overflow drops the oldest and counts; `flush` drains; bodies off stores figures only.
- `capture.test.ts`: a scripted front turn writes one session and N calls with figures; a throwing store does not fail the turn.
- `coverage.test.ts`: every `defineHarnessAgent(` in `apps/core/src` lists the plugin.
- `removal.test.ts`, `retention.test.ts`, `retention-inventory.test.ts`: removal keep, export, purge; bodies purged at their age while figures stay.
- `rights.test.ts`: own, room member, ex-member, other member, owner on a member's session (audited), owner on own (no audit), suspended person,
  guest (owner only).
- `activity-logs-leak.e2e.test.ts`: two members and the owner, sessions of several kinds; no content of A in B's responses, prompts, feed or
  `audit.mine` rows beyond the summary; a secret typed in a message is redacted in `logs.raw`.
- `logs.pty.test.ts` (TUI): Manage, Logs, drill to a generation and to the raw JSON, with a real core and a scripted provider.

## Open points

- The purge at 30 days (Removal) is this spec's reading of ADR-0032 §7; confirm before P36.2.4.
- The room owner-path audit names every active member as subject (Rights); confirm the wording with the owner.
- The queue capacity and batch size are constants; they are not exposed as settings.
