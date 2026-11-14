# P36 — Activity logs: every model call, per session, with a registered session kind (audit module, `activity-logs`)

Nov 11, 2026 · status: **done (gates below)** · depends on: P26 (migrations with backup, removal registry, prune tick), P30 (rooms and room ACL), P34 (front generations), P35 (dream judge sessions; P36 does not touch its files) · ADR: 0032, 0020 §2 and §4, 0027 §3 and §26, 0030, 0031 · region: none new (ADR-0004); a core plugin plus a store beside `modules/audit`

## Goal

The owner (and each person for their own data) can open a Logs view and see everything that was sent to an AI: a list of sessions (date range, id, kind and
app, primary model, provider, cost), a session drawer (requests, cost, models, overview, generations) and a generation drawer (provider latency,
throughput, tokens in and out, cost, model id, finish reason, streaming, fallbacks, the messages sent, the raw request, the raw response). A session has a
registered kind (`chat`, `task`, `room`, `guest`, `dream`, `aux`) instead of an id-prefix convention. Nobody reads another person's logs except the owner,
through an audited path.

## Why

- ADR-0032 §1: eharness 0.12.0 `model.call` already reports every provider call with request, response, usage, cost and timing; Keith stores none of it.
- ADR-0032 §2: the kind of a session is read in five places by prefix; a registry makes the next kind one row.
- ADR-0032 §8 and ADR-0020 §4: a prompt holds a person's messages and memory. The first version must have the rights model, not add it later.

Evidence from the code (each row names the file a step uses):

- Agents to hook: `apps/core/src/modules/wernicke-broca/agent.ts` (`createFrontAgent`), `corpus-callosum/agent.ts` (`createRoomAgent`), `cortex/workers.ts`
  (worker agents), `hippocampus/dream/judge.ts` (P35, a one-line addition in its own phase 5 step only after P35 lands), `guests/guest-agent.ts`
  (`plugins: [guestLimits(...), ...]`). Model-calling code outside an agent turn: `cortex/web-search.ts` (`generateText` with `searchModel`).
- Session ids: `apps/core/src/platform/sessions.ts` (`frontSessionId`, `personOfSession`, `generationOfSession`, `rootSessionOf`, `isGuestSession`),
  `room:<roomId>:g<n>` (`corpus-callosum`), `front:<person>:agent:<task>` (cortex workers), `dream-judge:<uuid>`.
- Rights: `modules/corpus-callosum/acl.ts` (the room read and `acl.owner-access` pattern), `modules/audit/mine.ts` (`registerMySummary`, a kind with a
  subject needs a summary), `packages/contracts/src/capabilities.ts`, `docs/specs/permissions.md`.
- Persistence: `packages/db/src/schema/*.ts` (one file per area, re-exported), `packages/db/drizzle/` (last migration `0022_parched_cardiac.sql`, P35's;
  take the next free number at generation time), `apps/core/src/platform/retention.ts` (`RETENTION_PERIODS`, `pruneRetention`), `modules/people/removal-registry.ts`
  and `compose-prefrontal.ts` (the removal registration pattern), `modules/hippocampus/secret-guard.ts` (`looksLikeSecret`).
- RPC and clients: `packages/contracts/src/contract.ts`, `modules/budget/procedures.ts` (the procedure pattern), `packages/client`, TUI sections in
  `apps/tui/src/features/manage/` (`sections.ts`, `audit/`), `packages/ui/AGENTS.md`, `docs/specs/tui-design.md`, `core-cli.md`.
- eharness 0.12.0: `.ref/eharness/docs/specs/12-models-and-cost.md` §7 (event shape, rules 1 to 7), `01-agent-and-plugins.md` §5 (hook, `ctx.observeModel`).
  Installed package: `node_modules/.bun/eharness@0.12.0+…/node_modules/eharness` exports `ModelCallEvent`, `ModelCallRecord`, `observeModel`.

## Scope

In: spec `docs/specs/activity-logs.md`; contracts (`session-kinds.ts`, `activity-logs.ts`, capabilities, audit kinds, `logs` RPC area); three tables and a
generated migration; redaction, truncation, gzip, queue and writer; the plugin on every agent and the aux calls; settings; retention and removal; the
rights function and RPC; client methods; TUI Logs section; `keith-core logs`; leak and rights tests; smoke step; amendments to `permissions.md`, `db.md`,
`people.md`, `core-cli.md`, `tui.md`, `audit` summaries.

Out: export to external tools, replay, body search, cost correction of the budget ledger, embeddings (reserved call kind only), changing any session id.

## Design

### Session kinds (ADR-0032 §2)

`packages/contracts/src/session-kinds.ts`: `SESSION_KINDS` (frozen list of `{ kind, label, app, matches, owner }`), `sessionKindOf`, `sessionRefOf`
(`{ kind, personId?, roomId?, generation?, parent? }`). The `task` rule is checked before `chat` (an id with `:agent:`). `platform/sessions.ts` keeps its
exports and implements them with the registry. The Logs app label: `chat` Front, `task` Worker, `room` Room, `guest` Guest, `dream` Dreaming, `aux` Helper.

### Tables (ADR-0032 §3; one additive migration)

`llm_sessions(id pk, kind, person_id null, room_id null, app, first_at, last_at, calls, cost_micro, primary_model, primary_provider, bodies_off)` indexed
on `(person_id, last_at)`, `(room_id, last_at)`, `(last_at)`.
`llm_calls(id pk uuidv7, session_id, call_kind, trigger, turn_id, step_index, message_id, started_at, duration_ms, first_chunk_ms, status, finish_reason,
model_id, provider, upstream_provider, tokens_in, tokens_out, cache_read, cache_write, reasoning, cost_micro, cost_source, fallbacks, error_name,
error_message, request_bytes, response_bytes, body_state, speaker_id null)` indexed on `(session_id, started_at)`, `(started_at)`.
`llm_bodies(call_id pk, request blob, response blob, output blob)`. Cost is stored as integer micro-dollars. CHECK constraints for the closed sets.

### Capture (ADR-0032 §1, §4, §5)

`modules/audit/activity-logs/`: `capture.ts` (the plugin: `model.call` hook mapping `ModelCallEvent` to a record, session kind from the registry, person
from `ctx.principal`, room from the id, trigger from `ctx.turn?.kind`), `redact.ts`, `truncate.ts`, `queue.ts` (bounded queue, batch insert in one
transaction, drop counter, `flush()` on stop), `observe.ts` (`observeAux(name, person, model)` for non-session calls). The plugin reads the settings at
write time (so a change applies to the next call).

### Rights (ADR-0032 §8)

`rights.ts`: `canReadSession(reader, session)` returns `own | room | owner-path | deny`. Every RPC calls it per row. The owner path audits through
`logs.owner-read` and `acl.owner-access` (`owner` = the session's person). The list returns figures only.

### RPC, CLI, TUI (ADR-0032 §9, §10)

See the ADR. The TUI section reuses the Manage section host (`use` hook, legend, dialogs) and the `packages/ui` tokens; the raw JSON view is a scrollable,
read-only code panel; keys: Enter drill in, Esc up, `/` filter, `f` kind filter, `r` raw, `s` scope (owner).

## Phases

### Phase 1 — Spec, session kind registry, contracts

Goal: the rules are written and typed before any storage or capture uses them.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.1.1 | Session kind registry and helpers; `platform/sessions.ts` delegates its parsing to it (exports unchanged) | `packages/contracts/src/session-kinds.ts` (new), `session-kinds.test.ts` (new), `packages/contracts/src/index.ts`, `apps/core/src/platform/sessions.ts` | ADR-0032 §2 | every id built by `frontSessionId`, `roomSession…`, worker, guest, judge, aux maps to one kind; no id matches two rules; `task` before `chat`; `sessionRefOf` parses generation and parent; `platform/sessions.test.ts` still passes | existing session tests pass unchanged; a test names the registry row to add for a new kind |
| P36.1.2 | Contracts: call and session record schemas, filters, `logs` RPC area (inputs and outputs), capabilities `logs.mine` and `logs.read`, audit kinds, settings schema and bounds, `MAX_RAW_WIRE_BYTES` | `packages/contracts/src/activity-logs.ts` (new), `activity-logs.test.ts` (new), `capabilities.ts`, `audit.ts`, `contract.ts`, `index.ts`, `scripts/exports.snapshot.json` | ADR-0032 §3, §6, §8, §9 | schemas strict; defaults parse; roles table: every role has `logs.mine`, only owner `logs.read` | snapshot regenerated; capability tests updated |
| P36.1.3 | Spec and amendments | `docs/specs/activity-logs.md` (new), `docs/specs/README.md`, `permissions.md`, `db.md`, `people.md`, `core-cli.md`, `tui.md`, `docs/specs/audit` summary in `auth.md` | ADR-0032 | none (doc) | every rule of ADR-0032 has a section naming the code path of this plan; the harness check (eharness spec 12 §7 rules 1 to 7, package exports confirmed) is recorded |

`bun run check` passes.

### Phase 2 — Store: tables, redaction, truncation, queue, settings, retention, removal

Goal: a call record can be written and read back safely, and expires, before any agent is hooked.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.2.1 | Schema (new schema file, re-exported), generated migration (never edited; backup first through `migrateWithBackup`), repo: `insertCalls(batch)` (calls, bodies, session upsert in one transaction), `listSessions`, `getSession`, `listCalls`, `getCall`, `getBodies`, `purgeBodiesBefore`, `purgeBefore`, `purgePerson`, `exportPerson`, `status` | `packages/db/src/schema/activity-logs.ts` (new), `schema/index.ts`, `packages/db/src/activity-logs-repo.ts` (new) + test, `packages/db/drizzle/<next>_*.sql` (generated) | `db.md`, ADR-0032 §3 | insert and read round trip; session totals equal the sum of its calls; CHECK constraints reject unknown kinds; paging is stable | migration generated and applied on a copy; `db.md` lists the tables |
| P36.2.2 | Redaction, truncation and gzip: `redact(value)`, `truncateBody(value, limits)`, `pack`/`unpack` (`Bun.gzipSync`) | `modules/audit/activity-logs/redact.ts`, `truncate.ts`, `pack.ts` + tests | ADR-0032 §4, §5 | fake keys built at runtime in header, nested key, free text and tool result never survive; a 2 MB body is cut to the cap and flagged; round trip of a normal body is byte-equal after redaction | no test builds a key-shaped literal (gitleaks) |
| P36.2.3 | Queue and writer: bounded queue, batch size and interval, drop-oldest counter, `flush()`, errors logged and swallowed; settings read (`captureBodies`, `guestBodies`, `bodyRetentionDays`, `metaRetentionDays`, `maxBodyBytes`) with defaults | `modules/audit/activity-logs/queue.ts`, `settings.ts` + tests, `modules/audit/activity-logs/index.ts` | ADR-0032 §1, §6 | a throwing store never rejects the caller; overflow drops the oldest and counts; `flush` drains; bodies off stores figures only; guest bodies off by default | none |
| P36.2.4 | Retention and removal: `activityLogsMs` and `activityBodiesMs` rows in `RETENTION_PERIODS` (days from settings), prune calls the repo, one `data.pruned` per table; removal part (keep, export, purge) registered like the dreaming part | `platform/retention.ts`, `retention.test.ts`, `retention-inventory.test.ts`, `modules/audit/activity-logs/removal.ts` + test, `compose-prefrontal.ts` (or the compose file where parts are registered) | ADR-0032 §7, ADR-0027 §26 | bodies purged at their age while figures stay; rows purged at theirs; export writes the person's rows only; purge removes them; audit row has counts and no ids | inventory test lists the new tables |

`bun run check` passes.

### Phase 3 — Capture on every model call

Goal: every call of every session kind is recorded, and a failing logger changes nothing.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.3.1 | The `activity-logs` plugin: `model.call` hook to record (session kind and person from the registry and `ctx.principal`, room from the id, trigger from the turn kind, speaker for rooms, cost and source, upstream provider as provider, fallbacks) | `modules/audit/activity-logs/capture.ts` + test | ADR-0032 §1 | scripted-model turn in a front session writes one session and N call rows with figures; a throwing store does not fail the turn; the hook adds no await to the stream | `capture.test.ts` runs a real `defineHarnessAgent` with a scripted model |
| P36.3.2 | Add the plugin to every agent: front, room, worker, guest; `compose` passes the writer. A source-scan test lists every `defineHarnessAgent(` in `apps/core/src` and fails if its plugin list lacks `activityLogs` (the dream judge is covered in P36.3.4 after P35 lands) | `wernicke-broca/agent.ts`, `corpus-callosum/agent.ts`, `cortex/workers.ts`, `guests/guest-agent.ts`, the compose files, `activity-logs/coverage.test.ts` | ADR-0032 §1 | front, worker, room and guest turns each produce rows of the right kind; compaction and flush calls produce `call_kind` `compaction` and `flush` | agent tests still pass |
| P36.3.3 | Calls outside a turn: web search through `observeModel` with the calling session (else `aux:web-search:<person>`) | `cortex/web-search.ts`, `activity-logs/observe.ts` + tests | ADR-0032 §1 | a web search writes a call row attributed to the person | none |
| P36.3.4 | Dream judge: add the plugin to `dream/judge.ts` (the session is `dream-judge:<uuid>`, kind `dream`, person from the principal). Start only when P35 has committed its judge steps | `hippocampus/dream/judge.ts`, `judge.test.ts` (one case) | ADR-0032 §1 | a judge run writes a `dream` session owned by the person | coverage test passes with no exemption |

`bun run check` passes.

### Phase 4 — Rights, RPC, audit, leak tests

Goal: the read paths exist, and no response ever holds another person's log.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.4.1 | `canReadSession` and the owner path (audit `logs.owner-read`, `acl.owner-access`, `registerMySummary` for both kinds) | `modules/audit/activity-logs/rights.ts`, `mine.ts` registration + tests | ADR-0032 §8 | own, member of room, ex-member, other member, owner on a member's session (audited), owner on own session (no audit), suspended person, guest session (owner only) | the `audit.mine` test lists the new kinds |
| P36.4.2 | Procedures: `logs.status`, `settings.get|set` (owner, audited), `sessions` (filters, cursor), `session`, `call`, `raw` (wire cap, redaction already applied), `purge` | `modules/audit/activity-logs/procedures.ts` + test, `compose-regions.ts` (wiring) | ADR-0032 §9 | list returns figures only; detail returns the messages sent; raw is audited every time on the owner path; a member passing another `person` gets `FORBIDDEN` | contract test: every procedure has a handler |
| P36.4.3 | Typed client methods | `packages/client/src/…` + test | ADR-0032 §9 | one call per method against a test core | exports snapshot regenerated |
| P36.4.4 | Leak and rights e2e: two members and the owner; each has sessions of several kinds; assert no content of A in any response to B, in B's prompt, in the activity feed or in B's `audit.mine` rows beyond the owner-read summary; room rights after leaving; a secret typed in a message is redacted in `logs.raw`; the e2e closes its core in `afterAll` | `apps/core/src/activity-logs-leak.e2e.test.ts` | ADR-0032 §8 | the test fails if `canReadSession` is bypassed in any procedure | none |

`bun run check` passes.

### Phase 5 — CLI and TUI

Goal: the owner can use it from the terminal and the TUI, in the existing style.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.5.1 | `keith-core logs list|show|call|raw|settings|prune` through the command registry (`--help`, `--json`) | `apps/core/src/cli/logs-command.ts` + test, `cli.ts` | `core-cli.md` | output of list and show; the owner-local read writes the audited row | `--help` lists the commands |
| P36.5.2 | TUI state and hooks: `use-logs.ts`, `logs-state.ts` (levels, filter, scope, cursor, raw scroll) | `apps/tui/src/features/manage/logs/` | `tui.md`, `tui-design.md` | state tests: drill in and out, filter, paging, scope toggle for the owner only | none |
| P36.5.3 | TUI views: session list, session detail (overview and generations), generation detail (figures, messages sent, tool calls), raw JSON panel; section registered with `read: ['logs.mine']`; legend entries | `…/manage/logs/*.tsx`, `sections.ts`, `legend.ts` + tests | `tui.md` | ink-testing-library render at 100 columns for each level; empty and error states | compact, no tips, uses `packages/ui` tokens |
| P36.5.4 | PTY test: open Manage, Logs, drill from the list to a generation and to raw JSON, with a real core and scripted provider | `apps/tui/src/logs.pty.test.ts` (as `cli.pty.test.ts`: `Bun.spawn({ terminal })`, `pressUntil`, `CI*` stripped) | `tui.md` | sees a session id, a model name, a cost and a JSON key | closes its core and child |

`bun run check` passes.

### Phase 6 — Smoke, docs, gates

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P36.6.1 | Smoke step: after the existing chat step, `keith-core logs list` shows the session with the fake provider, a member sees only their own, the owner read of the member's session writes the audit row | `scripts/smoke.ts` (new step only; `test(repo)`) | `docs/manual-testing.md` | `bun run smoke` | runs ~40 s plus a few |
| P36.6.2 | Docs: `docs/manual-testing.md` Logs scenario, `docs/ARCHITECTURE.md` mention, indexes (`decisions/README.md`, `plans/active/README.md`), changeset if the repo uses one for apps | docs | none | none | links resolve |
| P36.6.3 | Gates: `bun run check`, `bun run smoke`, the PTY test; record the evidence below; move the plan to `docs/plans/done/` and update the indexes | this file | none | all gates | evidence recorded |

## Exit criteria

- [ ] `docs/specs/activity-logs.md` written with the harness check; `permissions.md`, `db.md`, `people.md`, `core-cli.md`, `tui.md` amended in the same commits as their code.
- [ ] Contracts in `packages/contracts`; exports snapshot regenerated; no id format changed.
- [ ] Migration generated (not edited) and applied after a backup.
- [ ] Every agent has the plugin (coverage test, no exemptions); calls of kinds `chat`, `task`, `room`, `guest`, `dream`, `aux` and call kinds `step`, `compaction`, `flush` are tested.
- [ ] Rights and leak test P36.4.4 passes: another person's logs never appear in any response, prompt, feed or `audit.mine` row; the owner path is audited.
- [ ] No secret in any stored row (redaction test); retention and removal tests pass.
- [x] `bun run check`, `bun run smoke` and the PTY test pass. (evidence: `bun run check` green (5908 pass, 0 fail) and smoke 110 steps on Nov 14, 2026, eharness 0.14.1)
- [ ] Manual scenario (Owner to run) executed.

## Risks and mitigations

- **Personal data in one table.** Prompts hold messages and memory. Mitigation: one `canReadSession`, owner path audited, content never in lists, raw audited every time, bodies off by setting, 14-day default, person purge, removal part.
- **A secret reaches a row.** Mitigation: eharness redacts headers; the walker redacts keys and `looksLikeSecret` strings; a runtime-built key test; truncation never keeps a cut secret (redact first, cut second).
- **Disk growth.** A prompt repeats every step. Mitigation: gzip, 512 KB cap, 14-day bodies, figures kept for a year, `logs.status` shows size.
- **Logger slows or breaks a turn.** Mitigation: eharness fires the hook off the stream path; a bounded queue with drop-oldest and a counter; the store error is swallowed.
- **A new agent forgets the plugin.** Mitigation: the source-scan coverage test.
- **Room logs leak between members.** Mitigation: the session belongs to the room, read only with `r` on the room, re-checked per call; leave removes access at once.
- **Conflicts with P35 (same tree).** Mitigation: Phase 3.4 waits for P35's judge; migration number is taken at generation time; contracts index and the exports snapshot are re-generated at commit, staged by path.
- **Work tree.** The owner's edits in `apps/tui/src/cli.tsx` and `scripts/manual.ts` stay untouched; smoke is edited only in `scripts/smoke.ts`.

## Traceability

| Id | Closed by step |
| --- | --- |
| ADR-0032 §1 (capture at the provider boundary) | P36.3.1, P36.3.2, P36.3.3, P36.3.4 |
| ADR-0032 §2 (session kind registry) | P36.1.1 |
| ADR-0032 §3 (tables, migration) | P36.2.1 |
| ADR-0032 §4, §5 (redaction, size) | P36.2.2 |
| ADR-0032 §6 (settings) | P36.2.3, P36.4.2 |
| ADR-0032 §7 (retention, removal) | P36.2.4 |
| ADR-0032 §8 (rights, owner path) | P36.4.1, P36.4.4 |
| ADR-0032 §9 (RPC, client) | P36.1.2, P36.4.2, P36.4.3 |
| ADR-0032 §10 (CLI, TUI) | P36.5.1 to P36.5.4 |
| ADR-0020 §2, §4 | P36.4.1, P36.4.4 |
| ADR-0027 §3, §26 | P36.2.1, P36.2.4 |

## Gate evidence

Nov 11, 2026. Migration `0023_material_thunderball.sql` (generated; applied through `migrateWithBackup` and by the migration test on a fresh DB).

- Build: P36.1.1 to P36.6.2 are committed on main (registry 64812d5, contracts 6923a52, spec 7ccab4a, tables and repo 568e60e, redaction 005cce2, queue and settings 38d31e5, retention and removal f4e280a, capture 7e57250, wiring f99821e and 701f2b4, judge 65a2a0c, rights 56b7dbd, client 8ee891a, procedures 8fd9f48, leak e2e 26dabd4, CLI 48b04ba, TUI state 8a88847 and views f738c62, PTY f9af692, smoke 1eee7de, docs e69e9e7).
- `bun run smoke`: the three Logs steps pass (owner chat session in `logs list --json`; a member sees only their own and gets NOT_FOUND for the owner's session; the owner read of a member's session writes `logs.owner-read`). The one full run at HEAD failed only in P35's `p35 propose` step (a real P35 bug, fixed by P35 in 58de406). A first run failed at `p29 check-in` with `database is locked` while other sessions ran heavy jobs; it did not repeat in two later runs.
- PTY: `apps/tui/src/logs.pty.test.ts` passes (Manage > Logs, session, generation, raw JSON), about 56 s.
- Leak and rights: `apps/core/src/activity-logs-leak.e2e.test.ts` 13 pass; `rights.test.ts` 20 pass; `procedures.test.ts` 17 pass.
- `bun run check`: four full runs in a shared tree under load. Failures changed each run and none is in P36 code: manage-protocols and succession fixtures pinned to 2026-11-10 (fixed, 1a0dfa5), tests of P34 and P35 that pass alone, `packages/host` Ink unmount timer test (known flaky under load; 3 of 3 pass alone) and unhandled "connection dropped" errors of the TUI fake core. The final run is recorded below.

## Final check run

Last full run (Nov 11): 5551 pass, 1 fail: `packages/host/src/tui/spike.test.tsx` "unmount leaves no timer…" (the known load flake of the brief; it passes alone 3 of 3 and together with every P36 test file, 0 fail in 2 runs). Biome, tsc of every package, check-imports, check-size and check-exports passed in that run. All other tests pass.

## Owner to run

Use `bun run manual:setup`, `manual:core`, `manual:tui` and a second TUI with its own `KEITH_CLIENT_CONFIG` for a member (`docs/manual-testing.md`).

1. Owner TUI: chat twice. Manage > Logs: the session appears with kind Front, model, provider and cost; Enter shows the generations; Enter on one shows
   latency, tokens, finish reason and the messages sent; `r` shows the raw request and response JSON.
2. Type a fake secret in a message. Open the raw view: it shows `[redacted:secret]`.
3. Member TUI: chat, open Logs: only the member's sessions. Owner TUI: `s` to everyone, open the member's session; then the member's Privacy section lists
   that the owner read it.
4. Delegate a task (worker session), `/compact`, and run `/dream now`: sessions of kind Worker, Front (compaction call) and Dreaming appear.
5. `keith-core logs settings` to turn bodies off; chat; the new call has figures and no raw body.
6. `keith-core logs prune` and `keith-core audit list`: a `data.pruned` row with counts only.

## Open verifications

- Whether `ctx.turn?.kind` is reachable inside a `model.call` hook for compaction and flush calls (P36.3.1 records what the event holds and falls back to `step`'s turn id).
- Whether the web search call can reach `ctx` (a tool) so it attaches to the calling session (P36.3.3); otherwise it uses `aux:`.
- Where instance settings live (`packages/db/src/schema/settings.ts`): P36.2.3 follows the existing pattern.
