# P24 — Runtime, nodes, guests and money fixes

Nov 10, 2026 · status: **done Nov 10, 2026** (Haiku implementers, orchestrated by Sonnet; `bun run check` 3022 pass and `bun run smoke` 59 steps pass) · depends on: P21 (done), P23 and P26 (P22 order: P26 ships first, so the prune tick, `db migrate` lock and removal registry exist); coordinates with P25 (delivery service moves `plugins/wake.ts`; this plan only adds a recipient check there first) · ADR: 0027 §9 to §15 and §17 to §24 (builds on 0017, 0020, 0021) · closes: F-004, F-007, F-008, F-009, F-012, F-016, F-017, F-022, F-023, F-024, F-025, F-032, F-033, F-034, F-036, F-037, F-038, F-039, F-040, F-041, F-042, F-043, F-048, F-049, F-052 (verified), F-053 (test titles), F-054 (verified), F-055, F-056 (verified), REQ-186, REQ-187, Q-009, Q-010, Q-012, Q-015, FD10-02 (guest peek half; the rest is P23.1.11), FD10-03, FD10-04, FD11-06, doc gap 2b (guest listener limits table), doc gap 7 (evals threshold, cli.md rules)

## Goal

What the owner approved, stopped or switched off stays that way: an approval cannot be answered after it expired, a stopped task never resumes, a killed guest chat cannot reappear, and one broken person no longer stops repairs for the others. Money has no silent hole (a model with no price is shown and priced by hand), nodes and the core shell obey the same confinement, and the written rules match the code.

## Why

- ADR-0027 §9 (nodes are Keith's self layer), §10 (approval expiry), §11 (stop cancels the parked approval), §12 (core shell confined), §13 (node daemon, join), §14 (TUI scope key), §15 (runtime per person), §17 to §20 (reminder catch-up, owner cancel, notes and reviews, guest dead letters), §21 to §24 (trusted proxy, guest entry races, unpriced models, setup money).
- Findings: F-007 and F-009 are the two Medium runtime risks (a stopped task resumes; a stale shell approval can be answered days later), F-004 (unpriced model spends outside every control), F-008 (one person blocks reconcile), F-012 (shared guest window behind a proxy), F-016 and F-022 (reminders), then the Low items listed in the header.
- Requirements and rows (recon d3, d4, d6, d7, d9): REQ-132, REQ-139, REQ-143, REQ-150 and OWN-008, REQ-158, REQ-095, REQ-097, REQ-107, REQ-168, REQ-170, REQ-172, REQ-160, REQ-180, REQ-188, REQ-213.

## Scope

In: the phases below. Specs changed in the same steps: `tasks.md`, `amygdala.md`, `motor.md`, `nodes.md`, `node.md`, `cortex.md`, `budget.md`, `providers.md`, `guests.md`, `thalamus.md`, `tui.md`, `core-cli.md`, `logging.md`, `acl.md`, `people.md`, `hippocampus.md`, `permissions.md`, `plugins.md`, `plugins/notes.md`, `plugins/reminders.md`, `brain-events.md`; also `docs/ARCHITECTURE.md`, `SECURITY.md`, `README.md` where they still say guests do not exist.

Out (and where it goes):

| Item | Where |
| --- | --- |
| Delivery service, exactly-once reminders, `lastSlot` transaction, boot tick latest slot, fire counter prune, undelivered report (F-010, F-019, F-020, F-021, ADR-0027 §16; REQ-198) | P25 |
| Migrations with backup, `core.lock` for `db migrate`, atomic stale lock, backup and restore (F-011, F-026, F-027, REQ-115, REQ-109, ADR-0027 §3, §25) | P26 |
| Removed person's data, `left` status, `people login`, node token rotation and per-node rate limit (ADR-0027 §26 to §28) | P26 (P26.3.1 to P26.3.4 for §26 and §27, P26.4.x for §28) |
| The `approval-stale` protocol that pings before expiry | P28 (protocol engine); this plan only makes expiry happen and puts `approvalId` and `expiresAt` on the wait event so P28 can ping relative to the expiry |
| A per-node owner field and filtered node lists (Q-010 option B) | not planned: ADR-0027 §9 chose all household nodes |
| Delegate takeover (F-001), shared worker workspace (F-002), lost secret key (F-003) | done in P21 |

## Design

### Settings and contracts (`packages/contracts`)

- `approvals.ttlHours` (settings repo): integer 1 to 168, default 24. Contract `admin.approvals.get` (`settings.read`) and `admin.approvals.set` (`settings.manage`, step-up), new file `approvals.ts`. The attention item gains `ageMs` and `expiresAt` (read side only, computed in the core). The event `brain.amygdala.wait` gains `approvalId` (the attention item id) and `expiresAt` in `AmygdalaWaitPayloadSchema` (`packages/contracts/src/brain.ts:121-130`); `brain.amygdala.expired` carries `approvalId` too. P28's `approval-stale` pings relative to `expiresAt` (default 2 h before, a setting), so a later TTL change never breaks it.
- `BudgetStatusSchema` gains `unpriced: string[]` (model refs that spent without a price since boot). Contract `models.price.list` (`settings.read`) and `models.price.set` / `models.price.clear` (the owner, step-up; names and caller as ADR-0027 §23); `ModelPriceSchema = { ref, inputPerMTokUsd, outputPerMTokUsd }`. A manual price is stored in the settings repo key `models.prices` (JSON map) and applied as an overlay on the provider catalog, so eharness sees an ordinary `ModelInfo.pricing`.
- `GuestSettingsSchema` (strict) gains `trustedProxy: 'none' | 'cloudflare' | 'x-forwarded-for'` (default `none`) and `proxyAddrs: string[]` (CIDRs or IPs, max 16; required non-empty when `trustedProxy != 'none'`).
- `GuestEndReason` already lists `turn-cap`; no change.

### Audit kinds and events

| Name | When | Detail |
| --- | --- | --- |
| `approval.expired` | sweeper denies an overdue approval | `{ sessionId, approvalId, ageHours, capability }` (no command text) |
| `settings.approvals.set` | TTL changed | `{ from, to }` |
| `settings.model.price` | manual price set or cleared | `{ ref, inputPerMTokUsd, outputPerMTokUsd }` |
| `plugin.reminders.cancelled` plus `acl.owner-access` | owner cancels another person's reminder | `{ reminder, creator, recipient }`, `resourceOwner` = recipient |
| `brain.amygdala.expired` (event) | sweeper | `{ region: 'amygdala', sessionId, approvalId }` |
| `brain.amygdala.wait` (event, payload extended) | an approval starts waiting | adds `approvalId`, `expiresAt` to `{ region, personId?, toolName, sessionId, count }` |

### The one rule for "which people count" (ADR-0027 §15)

One table in `apps/core/src/platform/sessions.ts`, written once and used by every path:

| Purpose | People who count | Used by |
| --- | --- | --- |
| `route` | `active` | reconcile, dead-letter notice, wake, owner attention roots, feed, approvals, reminder fire |
| `recover` | `active` and `suspended` | boot recovery, graceful stop |

`peopleFor(purpose, people)` and `countsFor(purpose, status)` replace the five inline checks. A suspended person's worker rows are repaired by boot recovery; they are reconciled again when the person is reactivated (this is now written in `tasks.md`).

### Approval expiry (how it works)

A sweeper (`modules/amygdala/expiry.ts`) runs on the existing 60-second reconcile timer in `compose-timers.ts`. For each root session it reads `peek(id).pending()`, and for each approval older than `approvals.ttlHours` it answers the parked tool call as denied with reason `expired` through the same `respond` path the TUI uses (eharness spec 11 §3.6), writes `approval.expired`, and emits the event. The item's age comes from the attention item (eharness `createdAt`; verify the exact field in `.ref/eharness/docs/specs/26-http.md` before coding, and if the attention list does not expose it, read it from the approval message `metadata.eharness.createdAt`). No eharness change is needed.

### Node daemon stop signal (F-033)

A Bun `WebSocket` does not expose the HTTP status of a failed upgrade. The daemon therefore reads the close code (4003 = revoked, stop) and, for a connection that never opened, makes one plain `GET` of the same URL with the bearer header: the gateway answers 401 for an unknown or revoked token (`gateway.ts` already does), and the daemon stops with state `revoked` and exit code 3 instead of retrying.

### Unpriced models (how it works)

The eharness `W_MODEL_UNPRICED` warning (once per model, `details.model`) arrives through the harness logger. A new `modules/budget/unpriced.ts` keeps the set of refs, the logger routes the warning there and to the log; `budget.get` returns it; `keith-core doctor` prints "no price for <ref>: spend is not counted; set one with `keith-core models price set`". The guest role already refuses an unpriced model (`providers.rolePricing`); a manual price makes it priced.

### Trusted proxy for guests

Client address for the per-IP window, bearer bind and `ipHash` is computed in `thalamus/guest-http.ts` by `clientAddress(peer, headers, settings)`: the TCP peer unless the peer is inside `proxyAddrs`; then `cloudflare` reads `CF-Connecting-IP`, `x-forwarded-for` takes the right-most entry that is not itself in `proxyAddrs`. The zone is still decided from the TCP peer and the existing forwarding-header rule (a proxied visitor is `public`). Without it nothing changes, and `guests.md` states that behind a proxy all visitors share one window.

## Phases

### Phase 1 — Approvals and tasks (stale or resumed work)

Goal: no approval outlives its meaning, and a stopped or finished task never reopens.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.1.0 | Size headroom, no behaviour change: split `apps/core/src/compose.ts` (605 lines; this plan and P25 to P30 add timers and wiring) by region into `compose-timers.ts` (reconcile, prune, delivery tick) and `compose-regions.ts` (region wiring), keeping `createCore` as the only export of `compose.ts`. Later plans add to the split files. | `apps/core/src/compose.ts`, `apps/core/src/compose-timers.ts`, `apps/core/src/compose-regions.ts` | thalamus.md (boot order paragraph names the files) | every existing core test unchanged; `bun scripts/check-size.ts` shows `compose.ts` well under 400 lines | `bun run check` and `bun run smoke` green with no diff in behaviour |
| P24.1.1 | A task row in a final state (`done`, `failed`, `stopped`) is never written back to `running`: the `turn.start` upsert in the board reads the row and returns when it is final; the repo `upsert` refuses a status regress as a second guard. | `apps/core/src/modules/tasks/board.ts`, `packages/db/src/repos/tasks.ts` | tasks.md taskBoard, Invariants; REQ-168 | `tasks.test.ts`: a stopped row stays `stopped` after a later `turn.start`; same for `done` | the row cannot reopen |
| P24.1.2 | `tasks.stop` cancels the parked approval of the worker: after `abort('stopped')`, every pending approval of that session is answered denied with reason `stopped` through `session.respond`, then the row is marked. | `apps/core/src/compose-regions.ts` (`stop` wiring), `apps/core/src/modules/tasks/procedures.ts`, `apps/core/src/modules/cortex/` (a `cancelPending(taskId)` on the cortex port) | tasks.md oRPC, amygdala.md; ADR-0027 §11 | `tasks.test.ts` plus an e2e in `apps/core/src/motor.e2e.test.ts`: stop a task parked on a `shell.exec` approval, answer nothing: the approval is gone, the node never gets the command, the row stays `stopped` | stopping a waiting task really stops it |
| P24.1.3 | Setting and contract (also `scripts/exports.snapshot.json`, `bun scripts/check-exports.ts --write`): `approvals.ttlHours` (1 to 168, default 24) with `admin.approvals.get/set`, audit `settings.approvals.set`, CLI `keith-core approvals ttl [hours]`. | `packages/contracts/src/approvals.ts`, `contract.ts`, `apps/core/src/modules/amygdala/settings.ts` (new), `apps/core/src/modules/admin/procedures.ts`, `apps/core/src/platform/rpc.ts` (AUDITED), `apps/core/src/cli/ops-commands.ts` | core-cli.md Settings keys; amygdala.md; permissions.md | `amygdala.test.ts`: bounds, default; RPC audit test | owner can read and set the TTL |
| P24.1.4 | The expiry sweeper (see Design): denies overdue approvals with reason `expired`, audits and emits; runs at boot and on the 60 s timer; a worker that was waiting resumes the turn with the denial text ("this request expired after N hours"). | `apps/core/src/modules/amygdala/expiry.ts` (new), `apps/core/src/modules/amygdala/index.ts`, `apps/core/src/compose-timers.ts`, `packages/contracts/src/brain.ts` (wait and expired payloads, `approvalId`, `expiresAt`), `scripts/exports.snapshot.json`, `docs/specs/brain-events.md` | amygdala.md (Expiry), motor.md Approval, tasks.md; ADR-0027 §10 | `amygdala.test.ts` with a fake clock: approval 25 h old is denied, 23 h old is untouched; a member's parked worker gets the `expired` result; an expired item cannot be answered later (404); `brain.test.ts`: the wait event carries `approvalId` and `expiresAt`, the expired event `approvalId` | an old shell approval cannot run a command |
| P24.1.5 | TUI shows the age of each approval ("asked 3 h ago", amber in the last 2 h before expiry) and, for an expired one, a toast "request expired". | `apps/tui/src/features/approvals/approval-dialog.tsx`, `approval-state.ts`, `use-attention.ts` | tui.md Approval dialog; client attention item (`packages/client`) | `approvals.test.tsx`, `approval-state.test.ts` (age text, expiry ordering) | the owner sees how stale a request is |
| P24.1.6 | "Allow for task" (`a`) is offered only where the caller may scope it: the item says `scopable` (false for an owner answering a member's item; the core already drops `remember` there). | `apps/tui/src/features/approvals/approval-dialog.tsx`, `approval-state.ts`, `apps/core/src/modules/amygdala/attention.ts` (adds the flag to the list item), `packages/client/src/client.ts` (attention item type) | tui.md Approval dialog; amygdala.md Who answers; ADR-0027 §14 | `approval-state.test.ts` (key hidden), `amygdala.test.ts` (flag) | no key that the core silently ignores |

`bun run check` passes; `bun run smoke` (shell approval path).

### Phase 2 — Nodes and shell

Goal: the core shell is as confined as a node, and joining and revoking behave as written.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.2.1 | Core shell confinement (owner of F-032 and ADR-0027 §12; P31.1.1 only verifies it): realpath containment of `cwd` against the workdir (same answer as a node: `refused-by-policy`), and `SHELL_ENV_KEYS` reduced to `PATH, HOME, LANG` (the 8-key list stays only for the dev launcher if one needs it; none found). | `apps/core/src/modules/nodes/core-node.ts`, `apps/core/src/platform/config.ts` (`SHELL_ENV_KEYS`, `shellEnv`) | nodes.md The node `core`, motor.md; ADR-0021, ADR-0027 §12; REQ-139 | `core-node.test.ts`: `cwd: '/'`, `../..` and a symlink out are refused; env has exactly three keys; parity cases copied from `apps/node/src/executor/executor.test.ts` | core and node refuse the same cwd |
| P24.2.2 | Daemon stops on close code 4003 and on a 401 at connect; state `revoked`, one clear log line, exit code 3 for `keith-node run`; no reconnect. | `apps/node/src/connection.ts`, `apps/node/src/run.ts`, `apps/core/src/modules/nodes/gateway.ts` (confirm 401 body) | node.md Connection and exit codes; nodes.md Connection; ADR-0027 §13 | `apps/node/src/connection.test.ts`: close 4003 stops, no timer; failed open then probe 401 stops; probe 5xx still backs off; `run.test.ts` exit code; the node config written by the interactive `keith-node setup` path is mode 0600 too | a revoked node daemon goes quiet |
| P24.2.3 | Join is one transaction: validate the code first (no name probing without a code), then name check, consume with `usedByNode`, create node, all in one repo call; a 409 counts as a failure for the guard; `pairing.purgeExpired` runs on the prune tick (this step wires the call; the 1 day value comes from `CoreTiming.retention`, recorded by P26.5.1). | `apps/core/src/modules/nodes/pairing.ts`, `packages/db/src/repos/pairing.ts`, `packages/db/src/repos/nodes.ts`, `apps/core/src/compose-timers.ts` (prune) | nodes.md Pairing; REQ-143; ADR-0027 §13 | `pairing.test.ts`: unknown code plus taken name answers the code error, never 409; two concurrent joins with the same name and two codes: one succeeds, the other code is not spent; `usedByNode` is stored; 5 bad tries including 409 lock the client | joining is atomic and does not leak names |
| P24.2.4 | Members read all nodes (Q-010): document it, keep `nodes.read` in the member role, and pin it with tests (list, `nodes_status`, `node-changed` activity events reach members; per-person data such as tasks does not). OWN-008's "their own" is limited to activity and tasks. | `apps/core/src/modules/nodes/procedures.ts` (comment and contract doc), `apps/core/src/modules/thalamus/activity-filter.test.ts`, `docs/ARCHITECTURE.md` | permissions.md (`nodes.read`), nodes.md oRPC, ARCHITECTURE self layer; ADR-0020, ADR-0027 §9 | `activity-filter.test.ts` (node events pass), nodes procedure test (member lists all) | the rule is written once and tested |

`bun run check` passes; `bun run smoke` (node join, shell, revoke).

### Phase 3 — Runtime per person

Goal: a failure or a status change of one person never changes what happens to another.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.3.1 | Reconcile catches per person: one `try` per person, a warning with the id, the loop continues. | `apps/core/src/compose-sessions.ts` | tasks.md Timers in compose, Reconcile; REQ-170; ADR-0027 §15 | `compose-sessions.test.ts`: person 2 throws, person 3 is still repaired, a warning names person 2 | one bad person does not stop the rest |
| P24.3.2 | One rule for "which people count": `peopleFor` and `countsFor` in `platform/sessions.ts` (table in Design); `compose-sessions.ts`, `amygdala/attention.ts` roots and the reminder fire use them. | `apps/core/src/platform/sessions.ts`, `apps/core/src/compose-sessions.ts`, `apps/core/src/modules/amygdala/attention.ts`, `plugins/reminders/fire.ts` (reads `active` through the same host `person()` fact), `docs/specs/people.md` (the hardcoded `front:owner` / `OWNER_SCOPE` sentence was deleted in the docs pass of Nov 10: a grep finds only test files; re-run the grep and name the file if one appears) | people.md Rules (the routing sentence), tasks.md Per person, resume.md; REQ-172 | `sessions.test.ts` (new) table test per purpose; `compose-sessions.test.ts` | five inline checks become one |
| P24.3.3 | Plugin wake checks the recipient: `createWake.deliver` returns `{ delivered: false, reason: 'recipient-gone' }` when the recipient is not `active` (through an injected `isActive`). P25 later moves this into the delivery service and keeps the check. | `apps/core/src/modules/plugins/wake.ts`, `apps/core/src/compose-regions.ts` (inject), `packages/host/src/schedule.ts` (`WakeResult.reason` adds `recipient-gone`), `docs/specs/plugins.md` Schedules and wake | plugins.md; REQ-179, REQ-199; ADR-0027 §15 | `host.test.ts` / a new `wake.test.ts`: suspended recipient is not woken, active one is | any plugin is safe, not only reminders |
| P24.3.4 | Worker budget text cites the worker cap: `budgetText` detects a worker session (`includes(':agent:')`) and names `WORKER_BUDGET.maxTurnUsd` (1 USD) instead of the front's 0.5. | `apps/core/src/modules/budget/budget.ts`, `apps/core/src/modules/cortex/index.ts` (constant import via the budget port, not a reverse import) | budget.md Stop notice; REQ-160 | `budget.test.ts`: front id says 0.5, worker id says 1 | the notice names the real cap |
| P24.3.5 | Dead letters of guest sessions are only logged: `personOfSession` is undefined for `guest:*`; `onDeadLetter` checks `isGuestSession(id)` and logs without any inject. TST-079 is rewritten; no guest id ever reaches the owner. | `apps/core/src/compose-sessions.ts`, `apps/core/src/platform/sessions.ts` (`isGuestSession`), `apps/core/src/compose-sessions.test.ts` | acl.md Dead letters, people.md, logging.md Dead letters; Q-012, ADR-0027 §20 | `compose-sessions.test.ts`: `guest:abc` item is logged, the owner's front session gets nothing; empty id still reaches the owner | guest text never reaches the owner by a dead letter |

`bun run check` passes.

### Phase 4 — Money

Goal: no spend is invisible, and setup never changes a money rule behind the owner's back.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.4.1 | Setup keeps a removed (null) budget limit: the headless path reads `budget.seeded` as the interactive path does and writes `current` as is; the literal 20 exists once (`DEFAULT_MONTHLY_LIMIT_USD`). | `apps/core/src/cli/setup.ts`, `apps/core/src/cli/setup-steps.ts`, `apps/core/src/modules/budget/budget.ts` | budget.md Ledger (a removed limit stays removed); REQ-158; ADR-0027 §24 | `setup-owner.test.ts` (or `cli.test.ts`): set none, re-run headless setup, limit stays none | re-running setup is safe |
| P24.4.2 | Setup renames the current owner, not the id `owner`: `saveOwnerName` uses `tokens.owner().id`. | `apps/core/src/cli/setup-steps.ts`, `packages/db/src/repos/tokens.ts` (call site only) | core-cli.md Setup; ADR-0027 §24 | `setup-owner.test.ts`: owner transferred to a person with another id, setup renames that person | the right person is renamed |
| P24.4.3 | Unpriced registry (also `scripts/exports.snapshot.json`): harness logger routes `W_MODEL_UNPRICED` to the log and `modules/budget/unpriced.ts`; `budget.get` returns `unpriced`; `doctor` prints it. | `apps/core/src/modules/budget/unpriced.ts` (new), `apps/core/src/modules/budget/procedures.ts`, `packages/contracts/src/budget.ts`, `apps/core/src/compose-regions.ts` (`harnessLogger`), `apps/core/src/cli/doctor/checks/unpriced.ts` (new, listed in the table of `cli/doctor.ts`) | budget.md Ledger and oRPC; providers.md; ADR-0027 §23; REQ-163 | `budget.test.ts`: a warning with `details.model` lands in `budget.get`; a second one does not duplicate | the owner can see a model that spends uncounted |
| P24.4.4 | Manual price per model (also `scripts/exports.snapshot.json`): `models.price.list/set/clear` (owner, step-up, ADR-0027 §23), overlay on the catalog in the provider service (both `catalog()` and `rolePricing`), audit `settings.model.price`, CLI `keith-core models price set <ref> --in <usd> --out <usd>` and `clear`; the TUI model panel shows "price: manual". | `packages/contracts/src/models.ts`, `contract.ts`, `apps/core/src/modules/providers/service.ts`, `router.ts`, `apps/core/src/platform/rpc.ts`, `apps/core/src/cli/ops-commands.ts`, `apps/tui/src/features/manage/providers/` | providers.md (Service, oRPC), budget.md; guests.md Model role (a manual price makes a guest model priced) | `service.test.ts`: overlay gives pricing, `rolePricing('guest')` becomes priced, clear removes it; contract test for step-up | an unpriced model can be priced by hand |
| P24.4.5 | **FD10-03.** Setup re-run keeps and changes the owner's username through the people service: the prompt defaults to the owner's current username (not the fixed `owner`), `saveOwnerUsername` calls the people service rename (`username()`, `taken()`, store update with actor) and records `person.renamed` with `via: 'offline'`; `USERNAME_RE` and `usernameProblem` are imported from `@keith/contracts` (hard rule 2; the copy in `setup-steps.ts:276` goes). The check runs at the start of the owner step, before name, provider, models, budget and access are saved, and a taken name is a `UsageError`, never a raw SQLite error. `--owner-username` goes the same way. | `apps/core/src/cli/setup-owner.ts:52`, `apps/core/src/cli/setup-steps.ts:276-291`, `apps/core/src/modules/people/people.ts` (rename, called through the offline admin), `apps/core/src/modules/admin/offline.ts` | core-cli.md Setup (re-runnable: current values are the defaults), people.md (rename is audited whoever calls it); ADR-0027 §7, §24 | `setup-owner.test.ts`: owner renamed to `viandwi24`, Enter at every prompt keeps `viandwi24`; after `transferOwner` the former owner keeps `owner` and a re-run as the new owner with the same name answers a clear usage error and changes nothing; `--owner-username` to a taken name refused; an audit row with `via: offline` | re-running setup never renames or collides the owner |
| P24.4.6 | **FD10-04.** One budget amount parser, in contracts: `parseUsdLimit(text)` in `packages/contracts/src/budget.ts` returns a number (0 to 10000, plain decimal with at most two places) or `null` for `none`, and a sentence otherwise; an empty or blank string, `0x10`, `1e3`, `NaN`, `-1` and `unlimited` are errors (the CLI no longer accepts `unlimited`; the message names `none`). `parseBudget` and `budgetFlag` (CLI) and `parseUsd` (TUI) call it, so `budget set ""` and `setup --budget ""` stop. | `packages/contracts/src/budget.ts`, `scripts/exports.snapshot.json` (`bun scripts/check-exports.ts --write`), `apps/core/src/cli/prompt-helpers.ts:8`, `apps/core/src/cli/admin-commands.ts:309,323`, `apps/tui/src/features/manage/budget/budget-state.ts:6` | core-cli.md budget rows, budget.md (the amount rule), tui.md Manage budget | `budget.test.ts` (contracts): the table of accepted and refused texts above; `cli.test.ts`: `budget set ""` exits 2 and the limit is unchanged; `budget-state.test.ts` same table | `LIMIT=` unset in a script cannot set the limit to 0 |

`bun run check` passes.

### Phase 5 — Guests

Goal: a guest cannot slip past a kill switch, the open status route costs nothing, and the audit reason is exact.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.5.1 | `registry.open` rechecks the kill switch and `enabled` after its await, before inserting; a late start answers `killed` or `disabled`. | `apps/core/src/modules/guests/registry.ts`, `gate.ts` (exports `recheck()`) | guests.md Settings, Invariants; REQ-095 | `registry.test.ts`: hold `rolePricing` open, run `endAll`, release: the open fails and the registry is empty | no session outlives a kill |
| P24.5.2 | `GET /guest/status` reads limits without seeding the ledger (a read-only `gate.peek()`), and has a per-IP limiter (30 a minute, own bucket in `guest-limiter.ts`), 429 with the generic body. | `apps/core/src/modules/thalamus/guest-app.ts`, `guest-limiter.ts`, `apps/core/src/modules/guests/gate.ts`, `guest-budget.ts` | thalamus.md The guest listener, guests.md Guest HTTP and a "Limits" table that lists every limiter (start per IP, status per IP, chat, `/health` unlimited and data-free) and the tombstone retention and size limits (doc gap 2b); F-040 | `guest-listener.test.ts`: status never writes a ledger limit; the 31st call in a minute is 429 | status is cheap and read-only |
| P24.5.3 | The TUI lets the server end the session at the turn cap: on `turnsLeft === 0` it shows the end text and waits for the core's 410 (grace 3 s) instead of calling `end()`, so the audit reason is `turn-cap`. | `apps/tui/src/features/guest/use-guest-chat.ts`, `guest-text.ts` | guests.md Recording and audit, tui.md Guest mode; REQ-107; F-041 | `guest-screen.test.tsx`, `cli.guest.pty.test.ts`: last message ends with `turn-cap` in the audit row | the cap shows up in the audit |
| P24.5.4 | Trusted proxy for the guest listener (Q-009 option B; also `scripts/exports.snapshot.json`): settings, `clientAddress()`, used for window, bearer bind and `ipHash`; `keith-core guests set --trusted-proxy <value> --proxy-addr <cidr...>` (value is one of `none`, `cloudflare`, `x-forwarded-for`) (step-up, audited with before and after); doctor warns when zones include `public` and the setting is `none`. | `packages/contracts/src/guests.ts`, `apps/core/src/modules/guests/settings.ts`, `apps/core/src/modules/thalamus/guest-http.ts`, `guest-app.ts`, `apps/core/src/cli/guests-command.ts`, `apps/core/src/cli/doctor/checks/guests-proxy.ts` (new, listed in the table of `cli/doctor.ts`) | guests.md Settings and Who is a guest (warning text), thalamus.md; ADR-0027 §21 | `guest-listener.test.ts`: header ignored when the peer is not a trusted proxy; two visitors behind a trusted proxy get separate windows; spoofed header from an untrusted peer ignored; `settings.test.ts` (strict, non-empty list) | a public deployment has per-visitor limits |
| P24.5.5 | **FD10-02, guest half.** The owner's peek of a visitor's words is inert: `peekMessageOf` strips control and escape sequences from `text` and tool names with `stripControl` of `@keith/cli` (P23.1.11; same table of cases) and keeps `\n`; `keith-core guests peek` prints continuation lines of a message indented, so a visitor line that starts with `keith:` cannot forge a speaker. The stored message is not changed (the TUI and any other renderer strip at render, P23.1.11). | `apps/core/src/modules/guests/guest-peek.ts`, `guest-peek.test.ts`, `apps/core/src/cli/guests-command.ts:116`, `apps/core/src/cli/guests-command.test.ts` | guests.md (peek: the owner reads stripped text) | `guest-peek.test.ts`: OSC 52, `ESC [ 2 J`, C1 and U+202E removed, a forged `keith:` line stays one indented block; `guests-command.test.ts`: the printed lines never contain a byte below 0x20 other than `\n` | a stranger's text cannot write to the owner's terminal |

`bun run check` passes; `bun run smoke` (guest section: kill switch, caps, audit row).

### Phase 6 — Plugins and reminders

Goal: plugin data stays consistent and the owner's stop power over reminders is exactly what ADR-0020 says.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.6.0 | Verify and record (half a step): do the ACL store and plugin storage share one SQLite connection? Write the answer into plugins.md (Context `k`) and pick one design for P24.6.1: a shared transaction, or ordered compensation plus a startup orphan sweep. | `docs/specs/plugins.md`, `apps/core/src/modules/plugins/adapter.ts` (read) | plugins.md Context `k` | none (a note in the spec) | P24.6.1 has one design |
| P24.6.1 | Notes create and delete are atomic: the host offers `k.transaction(fn)` over the core database (plugin tables live there, `plugins/<id>/migrations`), or the compensation design that P24.6.0 recorded. Notes `create` and `delete` use it. | `packages/host/src/types.ts`, `ctx.ts`, `plugins/notes/operations/write.ts`, `apps/core/src/modules/plugins/adapter.ts` | plugins.md Context `k`; notes.md Operations; ADR-0027 §19 | `plugins/notes/notes.test.ts` (or the nearest test): a failing insert leaves no ACL resource; a failing delete leaves both | no resource without content |
| P24.6.2 | Decided owner reviews are purged 30 days after the decision in the prune tick, the payload included; pending and just-decided rows stay. | `apps/core/src/modules/plugins/reviews.ts` (`purgeDecided`), `packages/db/src/repos/reviews.ts` (`purge` is called), `apps/core/src/compose-timers.ts` | plugins.md Owner review queue; db.md; ADR-0027 §19 | `reviews.test.ts` and `packages/db/src/repos/reviews.test.ts`: a row decided 31 days ago is gone, 29 days stays, pending stays | the table stops growing |
| P24.6.3 | A once reminder that fell due while its plugin was off fires once when the plugin is enabled again: the host keeps the declined slot (`plugins.catchup.<pluginId>`, capped at 100, in the settings repo, no migration) and replays the latest per schedule on enable with `late: true`; if `.ref/eharness/docs/specs/29-scheduler.md` shows the scheduler can leave a slot unconsumed, use that instead and drop the list. | `apps/core/src/modules/plugins/schedule.ts`, `apps/core/src/modules/plugins/admin.ts` (enable hook) | plugins.md Schedules and wake, reminders.md Restart; ADR-0027 §17 | `schedule.test.ts`: disable, let a once slot pass, enable: one fire, status `done`; a cron schedule replays only the latest | nothing stays `active` with no timer |
| P24.6.4 | `reminders_cancel` refuses rows that are already `done` or `ended` (NOT_FOUND-like CONFLICT "already finished") and never rewrites them. | `plugins/reminders/operations/manage.ts`, `plugins/reminders/store.ts` | reminders.md Operations | `plugins/reminders/reminders.test.ts`: cancel of a done row is a no-op error, audit row not duplicated | finished rows stay finished |
| P24.6.5 | The owner may cancel a member's reminder and is told so in the audit: the cancel writes `acl.owner-access` (resource owner = recipient) through `k.audit.ownerAccess`, emits the plugin event `cancelled-by-owner` to creator and recipient (declared in the manifest), and the owner's `list` shows another person's reminder as a line (time, status, first 80 characters of the text) while `get` of someone else's text is refused for a non-participant owner. Notes delete stays creator only. | `plugins/reminders/operations/manage.ts`, `plugins/reminders/plugin.ts` (event), `packages/host/src/ctx.ts` (event audience check), `plugins/reminders/tui/reminders-view.tsx` (shows the event as a notice), `packages/contracts/src/audit.ts` (register `plugin.reminders.cancelled` and `acl.owner-access` subjects: creator, recipient) and `apps/core/src/modules/audit/mine.ts` (summary line: "the owner cancelled your reminder") | reminders.md Operations and Limits (REQ-213 reworded: the owner may cancel, never edit; `update` is creator only), acl.md Audit, plugins/notes.md The instance owner; Q-015, ADR-0027 §18 | `reminders.test.ts`: owner cancel by role works, both people get the event, `acl.owner-access` row exists; owner `get` of a member reminder text refused; member cancel of the owner's reminder unchanged | the member hears about it and the owner cannot read it |

`bun run check` passes.

### Phase 7 — Wording and documentation (last)

Goal: the written rules say what the code does.

| Step | Task | Files | Spec / contract | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| P24.7.1 | `SECRET_REFUSAL` no longer says "tell the owner": new text "Refused: this memory content looks like a secret (token, API key, private key, or a long random string). Keith does not store secrets in memory. Say that it was not saved, and keep the secret out of the chat." The spec says English (AGENTS.md), not Indonesian. | `apps/core/src/modules/hippocampus/secret-guard.ts`, `docs/specs/hippocampus.md` | hippocampus.md Who writes, and the secret guard; REQ-180, REQ-181; F-055 | `secret-guard.test.ts` (asserts the new text) | no static text assumes who the person is |
| P24.7.2 | The access.ts comment about tool approval is corrected: a tool approval never counts as confirmation; a chat turn is not elevated; a model-driven widening ends in `STEP_UP` mapped to `FORBIDDEN`. The `notes_share` tool description says wide shares need the owner at the TUI. | `apps/core/src/modules/acl/access.ts` (comment), `plugins/notes/operations/share.ts` (description), `docs/specs/plugins/notes.md` | notes.md, acl.md; F-048, REQ-205 | none (comment and text); `adapter.test.ts` already asserts the behaviour | the prompt text is honest |
| P24.7.3 | Verify-only for `tool.approve` and the registry (F-052): the docs pass already says in `motor.md`, `permissions.md` and the AGENTS.md gotcha that the hook decides from input and static tables with one deny-only exception; edit only if they drifted. Code half (F-053): rename the e2e titles so the three output caps (node 30 000, core node 20 000 head + 10 000 tail, agent `toolOutput`) are named as in the motor.md table. | `apps/core/src/motor.e2e.test.ts` (titles); `docs/specs/motor.md`, `docs/specs/nodes.md` only if the table drifted | REQ-132, REQ-138 | renamed tests still pass | the spec lists what the code does |
| P24.7.4 | Verify-only for the stale statements the docs pass fixed (F-054: guests exist in `people.md`, `permissions.md`, `SECURITY.md`, ARCHITECTURE, README; F-056: `logging.md` Dead letters); edit only if they drifted. Code-related halves stay: `guests.md` documents `trustedProxy` and the shared window behind a proxy (with P24.5.4), reminders.md REQ-213 wording (with P24.6.5), nodes self layer in ARCHITECTURE (with P24.2.4). The four "Changes in P25" pointers of acl.md, plugins.md, plugins/notes.md and plugins/reminders.md were corrected to P24 in the doc-pointer fix of Nov 10; the grep `grep -rn "Changes in P2" docs` must agree with the plan table. | `docs/specs/people.md`, `permissions.md`, `logging.md`, `guests.md`, `plugins/reminders.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `README.md` | ADR-0027 §1 (newest source wins), ADR-0017 | none | no document says guests do not exist |
| P24.7.5 | Mark the P24 row done in the P22 roadmap table and add the P24 changes to `docs/manual-testing.md` (approval expiry, trusted proxy, manual price). | `docs/plans/active/P22-one-keith-foundations.md`, `docs/manual-testing.md` | n/a | none | roadmap and manual match |
| P24.7.6 | Docs only (doc gap 7): `docs/specs/evals.md` gets the acceptance threshold per scenario (`guest`, `presence`, `agenda`, `room`), exit code and report path (the scenarios are built by P24.7.9, P27.4.4, P28.5.6 and P30.3.8, each to the threshold written here); `docs/specs/cli.md` gets a Rules section from `packages/cli` (command registry, generated `--help`, exit codes, output helpers, no env reads outside `platform/config.ts`). If the owner prefers not to, record both as non-goals in P22 "Not planned". | `docs/specs/evals.md`, `docs/specs/cli.md`, `packages/cli/src/` (read) | evals.md, cli.md | none | both specs exist and say what the code does |
| P24.7.7 | Log hygiene (REQ-186, REQ-187): extend `SECRET_KEY` in `platform/logger.ts` to the names `pin`, `code`, `passphrase`, `cookie` and `session`; a test that every log call added by P24 to P31 goes through `redact` (a lint-style test over `logger.warn`/`info` call sites that pass objects); cite the existing guest-logger and 14-day retention tests. | `apps/core/src/platform/logger.ts`, `logger.test.ts` | logging.md (redaction, guest log, retention) | redaction of the new keys; guest log carries no ip or text; retention prune | REQ-186 and REQ-187 trace to tests |
| P24.7.8 | **FD11-06.** A crash leaves a log line, and shutdown has a failure path. `installCrashHandlers(logger)` (called from `main.ts` and the `start` command) handles `uncaughtException` and `unhandledRejection`: log the error (through `redact`) at `error`, `await logger.flush()` capped at 2 s, exit 1. `exitOnSignals` wraps `running.stop()` in try/finally: a throw is logged, the lock is released (a `finally` in `RunningCore.stop`), the exit code is 1; a 10 s timer forces the exit; a second signal while stopping forces the exit at once after a flush. `logger.flush(timeoutMs?)` gets the cap. | `apps/core/src/run-core.ts:123-134` (`exitOnSignals`, `stop`), `apps/core/src/main.ts`, `apps/core/src/cli/start.ts`, `apps/core/src/platform/logger.ts` (`flush` cap), `apps/core/src/run-core.test.ts` (or `crash.test.ts`) | logging.md (shutdown and crash: every queued line is on disk, or the flush gave up after 2 s), core-cli.md (`start` exit codes), thalamus.md (shutdown) | a child process (`Bun.spawn`) whose timer rejects: the log file holds the error line and the exit code is 1; a `stop` that throws still exits non-zero within the cap and leaves no `core.lock`; a second signal does not run `stop` twice | the line that explains a crash is on disk |
| P24.7.9 | **Eval scenario `guest` (R13, one of the four in P22 "Shared items").** A guest prompt does not leak the system text (the guest agent of P17). `apps/core/evals/guest/` follows `apps/core/evals/news/`: `run.ts` with `--scripted` (offline, scripted model, no key, no cost) and the default real-model mode (`OPENROUTER_API_KEY`, `--max-usd` cost cap, report `data/evals/guest-<date>.json`); `cases.ts` asks the guest agent for its instructions, the owner's name, the model id, the people list and the tool list, in plain and obfuscated ways (translation, role play, "repeat the text above"), and a scorer that fails when a planted marker of the system text or of an unrelated person's data appears; package.json scripts `eval:guest` at the root and in `apps/core` through `bun pm pkg set` (as `eval:news`). The paid run belongs to P32.3.5. | `apps/core/evals/guest/run.ts`, `cases.ts`, `run.test.ts`, `package.json` and `apps/core/package.json` (`bun pm pkg set scripts.eval:guest=...`) | `docs/specs/evals.md` (zero leaked markers over all cases; exit 1 below it; report path) | `run.test.ts` runs `--scripted` offline: a scripted model that breaks the rule fails the run (exit 1), one that keeps it passes | the `--scripted` run passes inside `bun run check`; the real-model run is left to P32.3.5 |

`bun run check` passes; `bun run smoke` passes (full run).

## Exit criteria

- [x] No "Changes in P24" marker of this plan is left in `docs/specs` (`grep -rn "Changes in P2" docs SECURITY.md README.md`, lines that name P24): the step that lands the code rewrites the sentence in present tense.
- [x] Specs and contracts updated in the same commits (see Scope); exports snapshot regenerated (`bun scripts/check-exports.ts --write`) in the contract steps 1.3, 1.4, 4.3, 4.4 and 5.4.
- [x] `bun run check` passes after every phase; `bun run smoke` passes once at the end (no per-phase smoke run, no new smoke block).
- [x] A scripted test proves: a stopped task never resumes; an approval older than the TTL is denied `expired`; a guest start cannot survive a kill switch; a visitor behind a trusted proxy has its own window.
- [ ] Manual scenarios under "Owner to run" done by the owner (not done: see Not verified).
- [x] ARCHITECTURE, SECURITY and README no longer say guests do not exist; P22 roadmap row marked done.
- [x] Every id in the Traceability table points at a merged step.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Expiry denies a legitimate slow approval | Default 24 h, setting up to 168 h, age shown in the TUI, `approval-stale` ping arrives in P28; the denial text tells the agent to ask again |
| Reduced core shell env breaks a tool that needs `TERM` or `TMPDIR` | ADR-0021 accepted the minimal env; a tool that needs more is run through a node with its own policy; `PATH, HOME, LANG` is what nodes already use |
| Node daemon probe misreads a core restart as a revoke | Only a 401 or code 4003 stops it; any other failure keeps the backoff |
| `X-Forwarded-For` spoofing when `proxyAddrs` is too wide | The header counts only when the TCP peer is inside the list; the right-most non-proxy entry is used; doctor prints the list |
| Manual price is wrong and under-counts | The price is the owner's own choice, shown in `budget.get` as `manual`; the guest caps still apply; a catalog price returns when the manual one is cleared |
| Two plans edit `plugins/wake.ts` and the prune tick | P24 changes only the recipient check and adds calls to the tick; P25 and P26 rebase on those lines (named in their plans) |
| `k.transaction` cannot span ACL and plugin tables | Step 6.1 starts by verifying; fallback is ordered compensation plus an orphan sweep, written in plugins.md |

## Traceability

| Id | Closed by step |
| --- | --- |
| F-007, REQ-168 | P24.1.1, P24.1.2 |
| F-009, ADR-0027 §10 | P24.1.3, P24.1.4, P24.1.5 |
| F-036, ADR-0027 §14 | P24.1.6 |
| F-032, REQ-139, ADR-0027 §12 | P24.2.1 |
| F-033, ADR-0027 §13 (daemon) | P24.2.2 |
| F-034, REQ-143, ADR-0027 §13 (join, purge) | P24.2.3 |
| F-017, Q-010, REQ-150, OWN-008, ADR-0027 §9 | P24.2.4 |
| F-008, REQ-170 | P24.3.1 |
| F-038, REQ-172, ADR-0027 §15 (rule once) | P24.3.2 |
| F-037, ADR-0027 §15 (wake) | P24.3.3 |
| F-039, REQ-160, ADR-0027 §15 (budget text) | P24.3.4 |
| F-049, Q-012, ADR-0027 §20 | P24.3.5 |
| F-024, REQ-158, ADR-0027 §24 (limit) | P24.4.1 |
| F-025, ADR-0027 §24 (owner rename) | P24.4.2 |
| F-004, ADR-0027 §23 (warning routed, doctor, `budget.get`) | P24.4.3 |
| F-004, ADR-0027 §23 (manual price, guest refusal) | P24.4.4 |
| F-023, REQ-095 | P24.5.1 |
| F-040 | P24.5.2 |
| F-041, REQ-107 | P24.5.3 |
| F-012, Q-009, REQ-097, ADR-0027 §21 | P24.5.4 |
| F-042, ADR-0027 §19 (notes) | P24.6.0 (verify), P24.6.1 |
| F-043, ADR-0027 §19 (reviews) | P24.6.2 |
| F-022, ADR-0027 §17 (catch-up) | P24.6.3 |
| F-022 (cancel finished rows) | P24.6.4 |
| F-016, Q-015, REQ-213, REQ-073 and REQ-086 (reminders half), ADR-0027 §18 | P24.6.5 |
| F-055, REQ-180 | P24.7.1 |
| F-048, ADR-0027 §19 (comment) | P24.7.2 |
| F-052 (verified), F-053 (test titles), REQ-132 | P24.7.3 |
| F-054 (verified), F-056 (verified), REQ-188, ADR-0027 §1 | P24.7.4 |
| REQ-186, REQ-187 (log hygiene) | P24.7.7 |
| FD10-03 (setup username through raw SQL) | P24.4.5 |
| FD10-04 (empty budget text sets 0; two parsers) | P24.4.6 |
| FD10-02 (guest peek half; the device-label and render half is P23.1.11) | P24.5.5 |
| FD11-06 (crash handlers, shutdown failure path; REQ-186 and REQ-187 verified by P24.7.7) | P24.7.8 |
| Doc gap 7 (evals threshold, cli.md rules) | P24.7.6 |
| Doc gap 2b (guest listener limits table) | P24.5.2 |
| Size gate for `compose.ts` | P24.1.0 |
| Approval event contract for P28 (`approvalId`, `expiresAt`) | P24.1.4 |
| ADR-0027 §11 | P24.1.2 |
| ADR-0027 §22 | P24.5.1, P24.5.2, P24.5.3 |
| Recon rows not placed here | REQ-198 (P25), REQ-115 and REQ-109 (P26), REQ-165 and REQ-153 (P21) |

## Owner to run

Use `bun run manual:setup`, `manual:core`, `manual:admin`, `manual:tui`, `manual:node` (KEITH_HOME=.data/test, docs/manual-testing.md).

1. Stop a waiting task: ask a member's agent to run a shell command on a node, leave the approval pending, stop the task from the member's TUI. Answer nothing: the approval disappears and the task stays stopped.
2. Approval expiry: `keith-core approvals ttl 1`, create an approval, change the system clock or wait; after the sweep the item shows as expired and the agent is told. Restore `ttl 24`.
3. Approval age and scope key: open an owner TUI with a member's pending shell approval: the age is shown and the "allow for task" key is absent.
4. Core shell: ask the agent to run `pwd` with `cwd: /` on the core node: refused. `env` shows only `PATH`, `HOME`, `LANG`.
5. Revoked node: `bun run manual:node`, revoke the node in the TUI: the daemon prints "revoked" and exits with code 3 instead of retrying.
6. Join: try `keith-node join --code <bad> --name nas` against a taken name: the answer is the code error, not "name taken".
7. Unpriced model: pick a role model with no catalog price, send a message: `keith-core doctor` and the budget panel list the model; `keith-core models price set <ref> --in 1 --out 2` and the line disappears; the next turn counts cost.
8. Setup: run `keith-core setup` after removing the budget limit in the TUI: the limit stays none; the owner name changes on the current owner after a transfer.
9. Guests behind a proxy: enable guests with zone `public`, set `--trusted-proxy x-forwarded-for --proxy-addr 127.0.0.1`, start six sessions with different forwarded addresses: all start; the same address six times: the sixth is refused. Kill switch during a start never leaves a session in `keith-core guests list`.
10. Guest cap: `keith --guest`, send the last allowed message: the audit row says `turn-cap`.
11. Reminders: as a member create a reminder for yourself; as the owner cancel it: the member sees a notice, Manage > Privacy shows the owner's action, the owner cannot read the full text. Disable the reminders plugin, let a once reminder pass, enable it: it fires once.
12. Wording: ask the agent to remember a fake API key; the refusal does not mention the owner.
13. Setup username (FD10-03): rename yourself with `keith-core people rename`, re-run `keith-core setup` and press Enter at every prompt: the username is unchanged.
14. Budget text (FD10-04): `keith-core budget set ""` and `keith-core budget set 0x10` are refused and the limit does not move.
15. Guest peek (FD10-02): as a guest send `ESC[2J` and a second line that starts with `keith:`; `keith-core guests peek <id>` clears nothing and shows one indented block.
16. Crash log (FD11-06): `kill -TERM` a running core: the log ends with `stopped`; with a deliberately failing stop (test build) the exit code is 1 and `core.lock` is gone.

## Gate evidence (Nov 10, 2026)

- Commits b273254 (P24.1.0 compose split) to the test follow-ups of the gate; `bun run check`: 3022 pass, 0 fail, check-imports, check-size, check-exports (19 entries) ok; `bun run smoke`: SMOKE PASS, 59 steps.
- Deviations recorded by the implementers: P24.1.2 marks the task row `stopped` before it touches the worker so a late `turn.end` cannot record `done`; `approvals.ttlHours` CLI registered in `program.ts`; the CLI group is `keith-core model price` (not `models`); `clientAddress` lives in `thalamus/guest-address.ts` and proxy helpers in `guests/proxy-addrs.ts` (import cycle); `budget.get` shows the unpriced list to members too; setup rename audits as `person.update` via offline; the owner-cancel audit kind is `cancelled-by-owner` and the plugin event `cancelled_by_owner` (host needs snake_case); the `acl.owner-access` row of an owner cancel names the ACL owner (the creator), not the recipient (that is how ctx computes it); notes create and delete are atomic through a new host primitive `k.transaction` (the ACL store and plugin storage share one SQLite handle); the scheduler consumes declined slots, so the latest per timer is kept in settings `plugins.catchup.<id>` and replayed once at boot; reminders fire and the plugin people port keep their own `active` check; log hygiene redacts `pin`, `session` and `code` as whole keys only and keeps error codes (`W_`, `EH_`, `GUEST_`); the eval `guest` real mode also needs `--guest-model` (the guest role has no default).
- Tests updated by the orchestrator because the decisions changed their meaning: guest peek strips a whole C1 CSI sequence; `node-changed` reaches every person (ADR-0027 section 9); the budget form shows the parser's sentence.

## Not verified

- The manual scenarios of "Owner to run" (Scenario 19 in `docs/manual-testing.md`), by eye on a real terminal: approval age and amber, the expired toast, the trusted proxy behind a real tunnel, a manual price, a revoked node daemon exiting, the owner cancelling a member's reminder.
- The eval `guest` real-model mode was never run (costs money, needs `--guest-model`).
- No new smoke block for P24; the approval expiry, trusted proxy and kill switch are covered by unit and e2e tests only.
- Rate limit and 429 of `GET /guest/status` and the proxy window behind a real Funnel were tested with fakes.
