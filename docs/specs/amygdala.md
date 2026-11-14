# Amygdala

Code: `apps/core/src/modules/amygdala/{attention,pending}.ts`. Tests: `amygdala.test.ts`,
`apps/core/src/node-pairing.e2e.test.ts`.

## Purpose

What waits for the owner. Workers run in park mode, so an approval they need ends their turn; the
amygdala makes those waits visible (`/attention`, `brain.amygdala.wait`) and answerable. Decisions
by policy are in `cortex.md` and `motor.md`; `brain.amygdala.decide` is `brain-events.md`.

## Public API (`index.ts`)

- `attentionOptions({ lead, cortex, tasks, people, store, lock? })` returns the `attention` option of
  `createHarnessHttp` (type `AttentionOptions`).
- `watchPending(store, warn?)` returns an `ActivityStore` that wraps another one.

## `/attention`

Mounted by thalamus (`thalamus.md`), behind a token whose person has `approvals.answer`
(`permissions.md`). Served by `eharness/http`:
`GET /attention` lists the items; `POST /attention/:id/answer` takes `{ sessionId, answer: { kind:
'approval', approved, reason?, note?, remember? } }` (`remember: 'session'` is allowed:
`allowRemember: true`). Answers: `resumed`, `recorded`, `already-answered`; unknown item is 404.

- `roots`: a member: `[front:<personId>]`; the owner: their own front session plus the front session
  of every other active person. Children (workers) are walked through the child index.
- `peek(sessionId, { agent?, parentSessionId })`: the front agent for the root; for a worker the
  agent of the catalog key (`info.agent`, else the `agent` of the task row), via `cortex.worker`.
  Unknown agent: no handle (the item is skipped).
- `open(sessionId)`: the live session on the agent that runs it: the front agent with the shared
  `lock` for the root, `worker.session(id)` for a task; an unknown worker session throws.
- `canAnswer`: see "Who answers" below. A session or item that is not the caller's to answer is a 404.
- `store`: the activity store, so every answer appends `attention-answered`; `agentId`: `front` or
  the task's catalog key.

An item carries the tool call as the model made it: for `motor_remote` that is `input.node`,
`input.capability` and `input.input.command`, plus `agent`, `sessionId` (the task id), `risk`
(`external`), `toolCallId` and `createdAt`. The TUI renders from that.

### Who answers (P9 step 3)

Which person owns a session is read from the id alone, never from live state: `front:<personId>`, or
for a worker the front session of its task's `parentSessionId`. Whether the owner answers an item is
`ownerAnswers(toolName, input, capabilities)` of motor (`motor.md`): a `motor_remote` call that asks
anyone (a capability whose risk for that input is not `read` and not `approval: 'never'` at `write`
or below, `shell.exec` on a node or on `core` included), or one that cannot be read. `capabilities` is
the core's registry (the attention deps carry it). Everything else (a member's
workspace writes, web calls) stays with the person whose session it is.

| Item | In the asker's list | In the owner's list | Answer |
| --- | --- | --- | --- |
| The owner's own | yes | yes | the owner; from a remote client `shell.exec` needs a step-up |
| A member's, owner-routed | yes, `extra.waitingFor = 'owner'` | yes, with `extra.askedBy` (username), `askedByName`, `node`, `capability`, `command` | the owner only; the member gets `403 KEITH_WAITING_FOR_OWNER`; remote owner needs a step-up |
| A member's, other | yes | no (`decorate` hides it) | the member |

- **Privacy exception.** The owner does not see members' messages or other items, but sees who asked,
  the node and the command of an owner-routed item: the owner is the one who runs the risk.
- `decorate` adds the `extra` above (and hides what is not for the caller). An approval item also carries `ageMs` and `expiresAt` (epoch ms, the creation plus `approvals.ttlMs()`; absent when the item has no readable creation time or no lifetime is configured) for the TUI's age line, and `scopable`: `true` for the caller's own item, `false` for a member's request the owner answers and for a member's own item that waits for the owner (ADR-0027 §14: such an answer never sets a grant, so the TUI offers no "allow for task"). `canAnswer` finds the
  item in the session's stored pending state; a member answering another person's session is `404`.
- **Expiry (ADR-0027 §10, §11).** A pending approval is denied after `approvals.ttlHours` (see "Approval lifetime" below); the sweeper is `expiry.ts`, run by `compose.ts` at boot and on every reconcile tick (60 s). It walks the attention queue of the front session of every person that `peopleFor('recover')` counts (active and suspended; `platform/sessions.ts`, the same rule as boot recovery; `listAttention`, no waits), and for each approval whose age (the attention item's `createdAt`, the UUIDv7 time of its message) reached the lifetime it answers `approved: false` with reason `this request expired after <N> hours; ask again if it is still needed` through `answerAttention`, the path the TUI uses. The parked worker resumes with that text. Each denial writes `approval.expired` (`{ sessionId, approvalId, ageHours, capability }`, no command text, actor `system`) and emits `brain.amygdala.expired`; a second sweep finds nothing to do. An approval whose age cannot be read is left alone. Stopping a task cancels its parked approval (ADR-0027 §11): every pending approval of the worker is answered denied with reason `the task was stopped` through `respond({ endTurn: 'after-answers' })`, so the command never reaches a node and the worker's turn ends without a model call (`Cortex.cancelPending`).
- **Step-up on answers.** From a remote principal that is not elevated, answering an owner-routed
  item is `403` with `{ error: { code: 'KEITH_STEP_UP_REQUIRED' } }` (denying needs one too: the
  answer body is not read before the check). The local socket is always elevated; a legacy token
  never is. Streams and listing never ask for it.
- The audit trail (`AttentionTrail`): `describeApproval(sessionId, attentionId)` reads the approval while it still waits (node, capability, driver, redacted command capped at 200 characters); `appliedRemember(sessionId, attentionId)` returns the remember scope that `parseAnswer` applied (`once` when none is kept). The audit of `/attention/:id/answer` reads both (`approval.answered`, auth.md).
- `parseAnswer` drops `remember: 'session'` from an owner's answer to a member's owner-routed item:
  the member's next command asks again.
- Routing is by `/attention` only: the activity feed still carries `brain.amygdala.wait` for every
  person until P9 step 4 filters it per person.

The authorize hook of thalamus sees no `sessionId` on attention routes (the session is in the
body), so only the token is checked there and `canAnswer` does the per-session check.

## Approval lifetime (`settings.ts`, ADR-0027 §10)

The setting `approvals.ttlHours` (settings repo; integer 1 to 168, default 24) is read by `createApprovalSettings`: a missing or invalid stored value reads as 24, a value outside the bounds is refused on write (`RangeError`). Owner-facing: `admin.approvals.get` (`settings.read`, every person) and `admin.approvals.set` (`settings.manage`, step-up from a remote caller), audited as `settings.approvals.set` with `{ from, to }`; CLI `keith-core approvals ttl [hours]`. The sweeper that uses it is described under Expiry above.

The ping (`approvals.pingBeforeHours`, ADR-0027 §10, P28.3.6): a whole number 1 up to below the lifetime, default 2, read by the same `createApprovalSettings` (`pingBeforeHours()`). It is the hours before expiry at which the owner is told a request waits (the `approval-stale` built-in of `hypothalamus.md`). The built-in pings at `expiresAt` minus this setting, read live at each evaluation of its trigger (`hypothalamus.md`, "Triggers" and "Built-ins"); a change applies to approvals that start waiting after it, and a pending ping moves at its wake time. The ping never answers or expires the approval. The lifetime and the ping are checked as one pair: a lifetime at or below the stored ping is refused, and a ping at or above the lifetime is refused. `admin.approvals.set` takes `ttlHours`, `pingBeforeHours` or both (at least one; a refusal is `BAD_REQUEST` and writes neither), and `admin.approvals.get` returns the ping with its default. Each value given writes one `settings.approvals.set` row with `{ key, from, to }`. CLI `keith-core approvals ping-before [hours]`.

## `brain.amygdala.wait`

`watchPending(inner, warn, { ttlMs, now })` is the store every module appends to (compose builds it first). Appends pass
through; for a `pending-changed` event (written by the library `activity()` plugin when a turn ends
waiting) it adds `brain.amygdala.wait` for every approval in the snapshot that was not already
announced for that session: `{ region: 'amygdala', toolName, sessionId, count, approvalId, expiresAt }`
with `count` = approvals pending now across all sessions, `approvalId` the attention item id, and
`expiresAt` = the wait start plus the lifetime in force then (a later change of the setting does not
move it; P28's `approval-stale` pings relative to it). A row written before P24 has neither field.
The record's `sessionId` and `agentId` are set as before.
The payload is validated with `parseBrainEvent` before it is written (a bad one is dropped with a
warning). Tracking is in memory: per session the set of approval ids last seen; an empty snapshot
forgets the session, so the same id waiting again is announced again. Client tools and external
waits are ignored. A failure inside the watch never fails the append.

`brain.amygdala.expired` `{ region: 'amygdala', sessionId, approvalId }` is written by the sweeper for each
approval it denied (see Expiry above).

`brain.amygdala.decide` (the answer) comes from `brainEvents` on the `approval.decided` hook:
`by: 'user'` for an owner answer.

## Invariants

- An owner-routed approval is never answered by a member, in any session.
- The activity feed follows the same rule: the owner receives `brain.amygdala.wait` of a member's
  owner-routed item (tool name and count only), nothing else of the member (`thalamus.md`).
- A person never sees or answers another person's items, except the owner's view of owner-routed items.
- A protocol `act` with its owner's stored pre-approval runs without a `user-approval` item, so it never appears here (the one
  exception to the approval rule, ADR-0024 §3; `motor.md` "Invariants"). Its audit row is `protocol.act`.

## Tests

`amygdala.test.ts`: wait events (payload, dedupe, count across sessions, re-announce, ignored kinds,
bad snapshots, pass-through), roots, peek/open routing, `canAnswer`, audit agent id.
`member-shell.e2e.test.ts`: a member's `shell.exec` waits for the owner (member sees
`waitingFor`, answers `403 KEITH_WAITING_FOR_OWNER`; owner sees asker, node and command; a cold owner
session needs the step-up, then answers; another member gets `404`).
`node-pairing.e2e.test.ts`: the denied and approved flows read and answer `/attention` over HTTP and check the
events in the feed.
