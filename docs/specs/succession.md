# Succession

Module: `apps/core/src/modules/hypothalamus` (`succession.ts`, `succession-procedures.ts`, `sign-of-life.ts`,
`builtins-succession.ts`, from P29.2 on); people transfer in `apps/core/src/modules/people/people.ts` (`succeed`).
Contracts: `packages/contracts/src/succession.ts`. Storage: table `succession_state` (`db.md`), settings keys below.
Decision: ADR-0022 §3 and §4, ADR-0024 §3 and §4, ADR-0027 §6 and §26. Plan: `docs/plans/done/P29-owner-absence-and-succession.md`.

## Purpose

If the owner is gone, Keith neither falls into the wrong hands nor stays orphaned. The owner names one **heir** in advance. Keith
notices the silence, checks in with the owner on every channel, starts a visible **grace period**, tells both people, and lets the
heir **claim** ownership with their own credential and a step-up once the grace has ended. Any sign of life from the owner stops
the run at any moment. The previous owner stays in Keith as a suspended member, and none of their secrets is ever shown.

Nothing moves automatically. The only way ownership changes without the owner acting is this protocol, and its last step is the
heir's own claim (ADR-0022 §2 and §3). Recovery stays offline: `keith-core token recover` on the host (ADR-0008, ADR-0022 §4).

## Settings

Stored in the `settings` table (JSON values, `settingsRepo`). Changing one needs the capability `succession.manage` (owner only),
a step-up over TCP, and an audit row.

| Key | Value | Default (absent key) |
| --- | --- | --- |
| `succession.heir` | the person id of an active member who can sign in; the key is deleted when there is no heir | none: the protocol is off |
| `succession.windowDays` | integer 7 to 90 | 14 |
| `succession.pausedUntil` | epoch ms, at most 180 days after the moment it is set | none |

The grace period is fixed at **7 days** (ADR-0022 §3) and is not a setting. A heir is valid only when all of these hold at the
moment it is set: the person exists, `role` is `member`, `status` is `active`, `can_login` is on, and the person has a password or a
PIN (F-013). The owner cannot be the heir. Removing or suspending the heir clears the setting, and that is audited as
`owner.heir.clear`. The hook is the people service's identity change (`identity.changed` reasons `suspend` and `remove`, read by
`compose-protocols.ts`), so `people.ts` needs no edit: the succession service is one listener of it.

## States

`succession_state` has one row (`id = 1`). Its `state` moves only in the order below; every move is a compare-and-set on the
current state (the repo refuses a move from another state, so two writers cannot both win).

| State | Meaning | Entered by |
| --- | --- | --- |
| `idle` | no run; the protocol is off or waiting for the owner's silence | start, cancel, expiry |
| `check-in` | the owner has been silent for the first day; check-ins run until the window ends | a run of `owner-absence` starts (`runStarted`, called by the trigger's start in `compose-protocols.ts`) |
| `grace` | the window ended with no sign; the 7-day grace runs | `succession.begin-grace` |
| `claimable` | the grace ended with no sign; the heir may claim | `succession.open-claim` |
| `claimed` | the heir claimed; the run is `done` and the heir is the owner | the claim (below) |

Row fields: `state`, `run_id` (the P28 run), `heir` (the person id when the run started), `started_at`, `grace_started_at`,
`claimable_at`, `last_sign_at` (the sign of life that was read when the run started), `updated_at`. A new run starts from `idle` or
`claimed` only: `claimed` stays as the last outcome until the next run starts. A second start while a run is active is refused.
`check-in` to `grace` to `claimable` happens once each. Any active state (`check-in`, `grace`, `claimable`) moves back to `idle` on a
cancel, and the cancel keeps the audit.

The three `system` steps (`succession-steps.ts`) are idempotent on their state: a replay of a step whose state is already the one it
wants answers `ok` and writes nothing. A step that finds another state fails (`failed:<reason>`) and writes
`owner.succession.refused`. The engine's `cancelWhen` ends a run of a sign of the owner, and its `onCancel` runs `succession.cancel`.
A cancel the service makes itself (a pause, a heir changed, cleared, suspended or removed) ends the run row as `cancelled` through
the run repo, with no `onCancel`: the engine no longer watches or drives it.

## Sign of life

A **sign** is one of:

- an authenticated action of the owner on any client: a message, an approval answer, an admin change, a TUI key that P27 reports as
  `client.active` (the P27 signal `activity`);
- a presence signal of the owner's own devices: `client.connected` after a sign-in (`device.location` is not a sign of life: no client reports it yet, and `SIGN_OF_LIFE_SIGNALS` in `sign-of-life.ts` lists only `activity`, `client.active` and `client.connected`). The actor of
  every signal is its person, so no separate "made by the owner" flag exists;
- an answered check-in: a `protocols.answer` on the `ask` of this protocol.

Not signs:

- passive polling (the list `isUserActivity` in `apps/core/src/modules/auth/local-activity.ts` excludes);
- a node heartbeat, an automatic reconnect;
- any action by another person on the owner's account (a delegate cannot act on the owner, ADR-0022 §1);
- `keith-core token recover` or any offline command. The host's break-glass is not the owner being present. It does reset the
  clock on purpose (see the risk in the plan).

Reading: `lastSign(personId)` is the port that P27 exports (its spec owns it, `parietal.md`); this design adds no second tracker.
The sign of life of the owner is `max(lastSign(owner), succession.pausedUntil)`: a pause counts as a sign until it ends, and the count
restarts from its end.
The adapter is `createSignOfLife` (`sign-of-life.ts`), wired in `compose-protocols.ts` into the conditions (`signal.since`,
`signal.sinceRunStart`) and the triggers (`absence`), so every read of the owner's sign sees the pause.

## The protocol (`owner-absence`)

A built-in protocol, owner `keith`, generated from the settings (`builtins-succession.ts`). Its enabled flag is the heir: it is
**on exactly while an heir is set**, for every window from 7 to 90 days. `syncOwnerAbsence` runs on every change of the heir or
the window (the `onChanged` of the succession service, `compose-protocols.ts`) and once at boot after the built-ins are seeded.
It is idempotent. A change of the window or the heir saves a new version (the version row is the audit of the change); a running
run keeps the version it started with. The owner cannot switch it off, pause it, edit it or delete it through the protocol
procedures: `protocols.setEnabled`, `protocols.pause`, `protocols.save` and `protocols.delete` refuse it with `FORBIDDEN` and the
message `use keith-core succession` (`service.ts`). A pause for a trip is `admin.succession.pause`. The protocol runs as `keith`
(the self layer): it makes **no model turn** (no `wake`), so no prompt can be injected into it and no budget is spent.

The ladder (W is the window in days; the check-in blocks are `ceil((W - 1) / 7)`):

1. Trigger `absence { person: owner, afterMs: 24 h }`.
2. `limits.cancelWhen = signal.sinceRunStart(owner)`: any sign after the run started cancels it in every state up to the claim.
   `limits.onCancel = stop`. The other limits are the contract defaults (`maxSteps` 100, `maxVisits` 30).
3. **Check-in blocks** `check-in-1` to `check-in-N`. Each is one `ask` a day to the owner on every channel (`channels: 'all'`,
   option `I am here`, `timeoutMs` 24 h), which loops on itself (`next`). A block holds seven passes and then hands over to the
   next block. The timeout's condition branches are tested in order:
   a. `not(signal.since(owner, W x 24 h - 1 h))`: the owner has been silent for the whole window, so the grace begins
      (`begin-grace`);
   b. for every block but the last, `not(signal.since(owner, k x 7 x 24 h + 12 h))`: the next block starts (`check-in-(k+1)`);
   then `next`. The answer `I am here` ends the run `done`.
   The passes are `W - 1`: 6 for 7 days, 13 for 14, 89 for 90. The block exits test silence, not a counter (the contract has none),
   and the half day of slack keeps a late tick from moving an exit onto the timeout before it.
4. `system succession.begin-grace`: state `grace`, `grace_started_at`, audit `owner.succession.start`.
5. `notify` to the heir on every channel, and `notify` to the owner on every channel ("Ownership will move to your heir after a
   7-day grace period unless you use Keith. Any sign from you cancels it."). Both are left out for the heir while none is set.
6. `wait 7 d` (`grace-wait`): the grace period.
7. `system succession.open-claim`: state `claimable`, audit `owner.succession.claimable`; `notify` to the heir ("You may claim now:
   /succession claim") and to the owner. The run then ends `done` (see "As built").
8. `onCancel` `stop`: `system succession.cancel` (state `idle`, audit `owner.succession.cancel` with the reason and the sign that
   cancelled), then `notify` to the heir ("The owner is back; the succession protocol stopped.") and to the owner.

Texts are fixed strings. The delivery layer resolves names from ids at send time; the engine never interpolates data into text (P28
rule). The timeline is driven by the engine's injected clock, so no test sleeps.

### Run budget

Every step execution counts into the run's `maxSteps` (100). A daily check-in as an `ask` is one execution, so a 90-day window
makes 89 asks and 96 executions in all (7 days: 6 asks and 13 executions). A `notify` plus a one-day `wait` per day would make
178 executions for 90 days and end the run `failed` (`limit`) near day 50, with the owner unprotected; that is why the check-in is
an `ask`. `builtins-succession.test.ts` walks every window from 7 to 90 through the ladder on a clock and checks the passes, the grace
start, the visits (at most 7 per step) and the executions (at most 100).

### As built (P29.2.3 follow-up, `builtins-succession.ts`)

The ladder above is the build. These are the points where the build departs from the first design, and why:

- **Check-in in weekly blocks, one ask a day.** The first build ran the check-in as a two-step loop of 30 visits at most, so a window
  above 31 days could not be represented and stayed disabled. Blocks of seven passes keep each step under 30 visits, and the definition
  stays under the 40-step cap for every window (23 steps at 90 days with an heir).
- **Daily ask on every channel.** `ask` gains an optional `channels: 'best' | 'all'` (default `best`), with the meaning it has on
  `notify` (`needs.fanout`). It is the one contract change of this step. The daily nudge is an ask because the ask is itself the wait:
  a notify and a wait each day would cost two executions (see "Run budget").
- **Grace: one 7-day wait, no daily notes.** The seven daily notes of the first build cost 14 executions; with them a 90-day run would
  pass 100. The owner is told when the grace begins and when the claim opens.
- **Not built: the weekly claim reminder.** It needs executions after `open-claim`, and the run's budget is already spent by the
  check-ins before it (96 of 100 for a 90-day window). The heir is told once, when the claim opens, and the cancel row is the one
  message they get if the owner returns.
- **The claim phase is reconciled, not run (P29.3.2).** The run ends `done` after `open-claim`, so no engine `cancelWhen` watches
  the claim phase. Instead `reconcileClaimable()` (`succession.ts`) runs lazily: on `status`, on `claim`, at boot and at each
  protocol tick, and it reads the state row only while the state is `claimable`. An owner's sign newer than `claimableAt` moves
  the state to `idle` with `owner.succession.cancel` (reason `owner-sign`), which the heir can read in `audit.mine`. 52 weeks
  (`CLAIM_EXPIRY_MS`) after `claimableAt` with no claim, the state moves to `idle` with the same cancel row, reason `expired`. Ownership stays safe on top of that: the claim re-reads the owner's sign inside its transaction.
- **Enabled rule.** `syncOwnerAbsence` sets `enabled` to "an heir is set" on every call, so an heir change re-enables it and clearing
  the heir disables it. It writes no audit row: the version row is the audit, and the service audits the setting change.
- **`onCancel`** (`stop`) runs `succession.cancel`, then tells the heir and the owner.
- **A core that was down catches up at its first ticks.** The engine drives a due run until it waits, so an overdue check-in
  timeout is judged against the silence with the real clock in the same tick: a core down 9 days in a 7-day window reaches
  `grace` in that tick and tells both people (`succession.e2e.test.ts`, scenario (i)). The grace is recorded when the core first
  sees the silence, not backdated to the missed timeout: the owner's seven days of notice run from the notice they actually got,
  so a 16-day downtime reaches `grace` at once and `claimable` seven days after the restart (scenario (j)).
- **The protocol procedures refuse it** (`service.ts`, see "The protocol"), so the enabled rule cannot be overridden by the owner's
  own procedures.

### Extensions to the P28 contracts (built-ins only)

- `StepSchema` gains `system { action: 'succession.begin-grace' | 'succession.open-claim' | 'succession.cancel' }`.
  `authoring.ts` rejects any `system` step unless the definition's `built_in` is `owner-absence`. The engine dispatches it to the
  succession service, never to a plugin or a node. This is the coded path of ADR-0024 §3.
- `notify` and `ask` gain `channels: 'best' | 'all'` (default `best`), mapped to the P25 `needs.fanout` field: `all` is every route the
  planner returns (every connected client of the person, queued clients for their next connection, and the front session).
- `ConditionSchema` gains `signal.sinceRunStart { person }`; `LimitsSchema` gains `onCancel` (a step id run once when `cancelWhen`
  cancels the run, before the run ends).

These land with their tests in `docs/specs/hypothalamus.md` in the same commit (P29.2.1).

## The claim

`admin.succession.claim` (capability `authenticated`, `stepUp: true`; the handler decides). Checked in this order, and a refusal
changes nothing:

1. The caller is the stored heir (`succession_state.heir` and the `succession.heir` setting both equal the caller). The session came
   from a credential: `via` is not `local`. The local socket serves the implicit owner (`auth.md`), so a claim over it is `FORBIDDEN`.
   The caller is a member with `status = active` and a password or a PIN, checked again (F-013).
2. `state = claimable` and `now >= grace_started_at + 7 days`. Otherwise `PRECONDITION_FAILED` with the reason `not-started`,
   `grace-not-over` or `cancelled`.
3. The step-up of the caller's own PIN or password (`stepUpDenial`, `apps/core/src/modules/auth/capabilities.ts`). Its failures count
   in the same `auth_attempts` limiter, so a thief of the heir's bearer cannot guess the PIN.
4. One `BEGIN IMMEDIATE` transaction, the store's `succeed` (`person-store.ts`). The people swap runs first (the role swap and the
   previous owner's `suspended`), then the sync part given as `inside` runs in the same transaction: it re-checks the state row
   (`claimable`, same run), re-reads the owner's last sign synchronously (`signals.newest`, the same types as `lastSign`); a sign
   newer than `claimableAt` throws `owner-returned`, and the caller then ends the run (`owner.succession.cancel`, reason
   `owner-sign`) outside the rolled-back transaction. Otherwise `succession_state` becomes `claimed`, the setting
   `succession.heir` is cleared, and the audit row is written. The `owner-absence` protocol is disabled through the sync of the
   built-in (`onChanged`), since the heir is gone; the P28 run is already `done`.
5. Audit `owner.succession` (actor: the heir, `via`, detail `owner` and `previousOwner` (the previous owner), `heir`, `startedAt`,
   `graceStartedAt`, `claimedAt`, `lastSignAt`), in the same transaction as the transfer. If the audit insert fails, the transfer
   rolls back: there is no ownership change without its row.
6. Both people lose their sessions (`revokeSessions(…, 'transfer', …)`, the same as a hand-over). The heir signs in again as owner.

A second claim after a successful one answers `CONFLICT` (the state is `claimed`).

`PeopleService.succeed(heirId, proof, by, inside)` (`modules/people/people.ts`) is not an RPC procedure and not reachable from the
CLI. `proof` is a `SuccessionProof` (`modules/people/succession-proof.ts`) that only `mintSuccessionProof` makes, and only
`modules/hypothalamus/succession.ts` calls it: the type is re-exported by the people index, because a cross-module import goes
through that index (the module-public-api rule), so the restriction is a test (`people-guard.test.ts` pins the importers), not
the type system alone. The heir must be active, able to sign in and hold a secret (F-013), checked again here. It uses the store's
`succeed`, which reuses the swap of `transferOwner` and in the same transaction sets `status: suspended` on the previous owner;
`inside` runs in that transaction. `transferOwner` keeps its checks (`callerIsOwner`, the target has a secret and is active, the
target is not already the owner) for a hand-over.

## What the heir gets (and does not)

- The heir becomes the owner with all owner rights over Keith's self layer: nodes, plugins, settings, providers, budget, and the
  protocols of `keith`.
- The previous owner stays a person with role `member` and status `suspended`. They cannot sign in until the new owner reactivates
  them or hands ownership back. Their conversations, memory, workspace and resources are neither deleted nor re-owned.
- **Never revealed:** their password and PIN hashes (no API returns them), their credentials (revoked), the provider keys Keith holds
  (they are Keith's, not the person's; no API displays a key, ADR-0014), and anything in their personal layer beyond what the owner
  role already reads. The new owner reads the previous owner's personal data only the way any owner reads a member's: audited as
  `acl.owner-access`, and visible to the previous owner through `audit.mine` once they can sign in (ADR-0015, ADR-0027 §6).
- The heir's own conversations, memory and agenda stay theirs.

## Pause

`admin.succession.pause` sets `succession.pausedUntil`. The engine reads it as a sign of life (see "Sign of life"). A pause during an
active run cancels it with the reason `paused` at once, through the service's own cancel (the run row ends `cancelled`, the state
goes `idle`, `owner.succession.cancel` is written with the owner's sign before the pause). When the pause ends, the count restarts from that end, so check-ins begin again one day
later. A pause of more than 180 days is refused (`BAD_REQUEST`). `resume` clears the setting.

## Audit

| Kind | Written when | Detail |
| --- | --- | --- |
| `owner.heir.set` | the heir is set | `{ previousHeir, heir, owner }` (person ids; subjects: `owner`, `heir`) |
| `owner.heir.clear` | the heir is cleared by the owner, or removed or suspended | `{ heir, reason: owner \| removed \| suspended, owner }` (subjects: `owner`, `heir`) |
| `owner.succession.window` | the window changes | `{ from, to, owner }` (days; subject `owner`) |
| `owner.succession.pause` | a pause is set | `{ until, owner }` (subject `owner`) |
| `owner.succession.resume` | a pause is ended early | `{ owner }` (subject `owner`) |
| `owner.succession.start` | `begin-grace` runs | `{ heir, startedAt, graceStartedAt, owner }` (subjects: `owner`, `heir`) |
| `owner.succession.claimable` | `open-claim` runs | `{ heir, claimableAt, owner }` (subjects: `owner`, `heir`) |
| `owner.succession.cancel` | a run is cancelled | `{ reason: owner-sign \| paused \| heir-changed \| heir-cleared \| heir-suspended \| heir-removed \| expired, sign, owner, heir }`; `sign` is the owner's newest sign (ms) or null (subjects: `owner`, `heir`). `owner-sign` also names a claim refused by a sign (`owner-returned`) |
| `owner.succession.refused` | a system step of the protocol is refused (`open-claim` in `idle`, `begin-grace` out of `check-in`) | `{ action, state, reason }`; no subject, so only the owner's audit reads it |
| `owner.succession` | the claim | see "The claim" |

Rows name people by id and never carry a secret. `audit.mine` shows the owner and the heir the rows where they are the subject
(ADR-0027 §6). The engine's own `protocol.*` rows and `brain.hypothalamus.*` events cover each step (P28); a succession start also emits
`brain.hypothalamus.fire` with the protocol name.

## Errors

| Code | When |
| --- | --- |
| `FORBIDDEN` | the caller is not the heir (claim), not the owner (settings), or the claim came over the local socket |
| `NOT_FOUND` | `admin.succession.get` for anyone who is neither the owner nor the heir |
| `PRECONDITION_FAILED` | the claim before the grace ended, in the wrong state, or after a cancel. `reason`: `not-started`, `grace-not-over`, `cancelled`, `owner-returned`, `heir-invalid` |
| `BAD_REQUEST` | the heir is the owner, suspended, cannot sign in, or has no secret; the window is out of 7 to 90; a pause is longer than 180 days |
| `CONFLICT` | the claim was already processed |

## RPC

Handlers in `modules/hypothalamus/succession-procedures.ts`; contracts in `packages/contracts/src/succession.ts`; procedures under
`admin.succession` in `packages/contracts/src/contract.ts`.

| Procedure | Capability | Step-up | Input | Output |
| --- | --- | --- | --- | --- |
| `admin.succession.get` | `authenticated` (the handler decides) | no | - | owner view, or heir view `{ role: 'heir', state, claimableAt, claimOpensAt }` for the heir; `NOT_FOUND` otherwise |
| `admin.succession.setHeir` | `succession.manage` | yes | `{ person }` | owner view |
| `admin.succession.clearHeir` | `succession.manage` | yes | - | owner view |
| `admin.succession.setWindow` | `succession.manage` | yes | `{ days }` (7 to 90) | owner view |
| `admin.succession.pause` | `succession.manage` | yes | `{ until }` (epoch ms, after now and at most 180 days ahead) | owner view |
| `admin.succession.resume` | `succession.manage` | yes | - | owner view |
| `admin.succession.claim` | `authenticated` (the handler decides) | yes | `{}` (no field) | `{ owner, previousOwner }` (the transfer result) |

The owner view: `{ role: 'owner', state, heir: { id, name } | null, windowDays, pausedUntil, lastSignAt, runId, startedAt,
graceStartedAt, claimableAt }`. It never includes a secret.

The heir view: `{ role: 'heir', state, claimableAt, claimOpensAt }`. `claimOpensAt` is when the claim opens: `graceStartedAt` plus
the grace length (`GRACE_MS`, the constant the ladder waits for) in `grace`, `claimableAt` in `claimable`, null in every other
state. It is the only time the heir learns beyond the state; it reveals no owner's sign and no presence.

The reads of the owner view (`get`) are the handler's decision, not the gate's: the heir has no `succession.manage`.

## CLI and TUI

Planned in P29.1.6 and P29.3.5. CLI (built in P29.1.6, `apps/core/src/cli/succession-command.ts`): `keith-core succession status`, `heir set <username>` and
`heir clear` (both ask y/N; `--yes` skips it, and outside a terminal without `--yes` they exit 2), `window <days>`, `pause <days>`
or `pause <time>` (ISO 8601 or epoch ms), and `resume`. Every subcommand is one `admin.succession.*` call over the owner socket;
the CLI adds no rule, the core answers the refusals. `status` reads the owner view and needs a running core (the socket), not the
database: it does not run offline. `keith succession claim` for the heir over a credential session is P29.3.5. Doctor line
(`cli/doctor/checks/succession.ts`, read only): `!` `no heir: if you are gone nobody can take over Keith` when no heir is set; `!`
when the owner-absence protocol is missing or switched off; otherwise `✓` with `armed (heir: <name>, window N days)`, or
`grace until <date>` / `claimable since <date>` during a run. TUI: a `Succession` section for the owner (`read: succession.manage`,
in the `People & access` group); `/succession` and a Home caption for the heir during `grace` or `claimable`.

## Invariants

- Ownership moves only by hand-over (`transferOwner`) or by a claim under this spec (ADR-0022 §2).
- The claim re-reads the last sign inside its transaction; a sign after the run started always wins.
- No `succession.manage` for a member, and the service checks the owner role as well (a delegate cannot name themselves heir).
- The claim never runs over the local socket.
- A removed or suspended heir clears the heir; a heir who cannot sign in cannot claim.
- The owner-absence protocol is switched, paused, edited and deleted only through `succession`; the protocol procedures refuse it
  (`use keith-core succession`).
- No API or CLI output carries the previous owner's password hash, PIN hash, credential secret or a sealed value.

## Tests (built in P29)

`modules/hypothalamus/succession.test.ts` (settings and their refusals), `sign-of-life.test.ts`, `builtins-succession.test.ts`
(the ladder for every window 7 to 90 on a clock, the sync rules), `succession-guard.test.ts` (the procedures refuse the built-in),
`succession-procedures.test.ts` (per role), `modules/people/people-guard.test.ts` (`succeed`),
`apps/core/src/succession.e2e.test.ts` (the timeline with a scripted clock), `apps/core/src/succession-secrecy.e2e.test.ts`. Contracts:
`packages/contracts/src/succession.test.ts`. Migration: `packages/db/src/migration-0018.test.ts`.
