# Brain events

Code: `apps/core/src/modules/brain-events/{emit,plugin}.ts`, `thalamus/app.ts` (routed), the board
(`tasks/board.ts`) and `ras/proactive.ts` (their own events). Types: `packages/contracts/src/brain.ts`.
Tests: `brain-events.test.ts`, `apps/core/src/delegation.e2e.test.ts`.

## Purpose

`brain.<region>.<phase>` records in the eharness activity feed (table `events`, `db.md`), so a UI
can light up the active regions. The feed is served at `/activity` (`thalamus.md`).

## Events

The payload of each is a zod schema in `packages/contracts/src/brain.ts` (`BrainEventSchema`,
`parseBrainEvent(record)` returns a typed event or `undefined`, never throws).

| Event | When | Source |
| --- | --- | --- |
| `brain.thalamus.routed` | a new message of a person passed auth | thalamus `chat.validate` (`kind: 'send'`) |
| `brain.wernicke.start` | a front turn starts with owner input (`kind: 'send'` only) | `brainEvents` front, `turn.start` |
| `brain.broca.start` | a front turn starts (any kind, `wake` included) | `brainEvents` front, `turn.start` |
| `brain.broca.end` | a front turn ends (`stop` = the eharness stop reason) | `brainEvents` front, `turn.end` |
| `brain.cortex.start` | a worker turn starts and the task was not already running | `taskBoard`, `turn.start` |
| `brain.cortex.step` | a worker finished a step (`stepIndex`) | `taskBoard`, `step.end` |
| `brain.cortex.end` | a worker task finished (`status`, `summary` up to 200) | `taskBoard`, `turn.end` |
| `brain.motor.act` | an action tool ran (`toolName`, `ok`, `taskId` in a worker) | `brainEvents`, `step.end` `toolResults` |
| `brain.amygdala.decide` | an approval was decided (`approved`, `by`: `policy`, `risk`, `grant`, `user`, `plugin:<name>`) | `brainEvents`, `approval.decided` |
| `brain.amygdala.wait` | an approval started waiting for the owner (`toolName`, `sessionId`, `count` pending now, `approvalId`, `expiresAt`) | `watchPending` on `pending-changed` (`amygdala.md`) |
| `brain.amygdala.expired` | an approval was denied as expired (`sessionId`, `approvalId`) | the expiry sweeper (`amygdala.md`, Expiry) |
| `brain.ras.deliver` | a worker report was delivered by a wake turn | `proactive`, `turn.end` (`ras.md`) |
| `brain.hippocampus.dream` | a dream run started (`phase: start`, counts zero) and ended (`phase: end`: counts, `applied`), with `trigger` `schedule` or `manual` | the dreaming service, on the person's front session (`dreaming.md`, Rule 8) |
| `brain.hippocampus.write` | a memory file was changed (`op`, `path`, `taskId` in a worker) | `memory({ onWrite })` (`hippocampus.md`) |
| `brain.hippocampus.recall` | `memory_view` returned (`path`, `taskId` in a worker) | `brainEvents`, `step.end` |
| `brain.parietal.presence` | a person's computed presence changed (`personId`, `state`, `previous`: null on the first computation) | `parietal` recompute on a signal or every minute (`parietal.md`, Signals and computation) |
| `brain.parietal.deliver` | a client was asked to do a capability for a delivery (`clientId`, `deliveryId`, `capability`, `name`) | `parietal.callClient` (`parietal.md`, Client capability registry and route) |
| `brain.parietal.workspace` | Keith's `workspace` tool acted on the person's workspace (`action`, `ok`; no titles) | the `workspace` tool, on the turn's session (`workspace.md`, Keith) |
| `brain.hypothalamus.fire` | a protocol run started (`protocolId`, `runId`, `trigger`: `time`, `absence`, `signal`, `event`) | the protocol engine (`hypothalamus.md`, Engine; built in P28.2) |
| `brain.hypothalamus.step` | a step of a run got its outcome (`runId`, `step`, `kind`, `outcome`) | the protocol engine (`hypothalamus.md`, Engine) |
| `brain.hypothalamus.wait` | a run waits until `wakeAt` (a `wait`, an `ask` deadline, a delayed event) | the protocol engine (`hypothalamus.md`, Engine) |
| `brain.hypothalamus.end` | a run ended (`runId`, `status`: `done`, `cancelled`, `failed`, `skipped`, `expired`) | the protocol engine (`hypothalamus.md`, Engine) |
| `brain.corpus-callosum.invite` | a person was invited to a shared room (`roomId`; no text), on the invitee's front session, so the TUI reads the invitation again | the room service, when the invitation row is written (`corpus-callosum.md`, Events; P30.5.4) |
| `brain.corpus-callosum.join` | a person joined a shared room (`roomId`; the room's text never leaves the room) | the room service, on accept (`corpus-callosum.md`, Events; built in P30.2) |
| `brain.corpus-callosum.turn` | a room turn ended for its speaker (`roomId`, `speakerId`, `stop`: the eharness stop reason, absent when no model ran) | the room turn pipeline (`corpus-callosum.md`, Events; built in P30.3) |
| `brain.corpus-callosum.end` | a room ended (`roomId`, `reason`) | the room service, on end or on the last member's leave (`corpus-callosum.md`, Events) |
| `brain.prefrontal.change` | the persona changed: one version was written (`version`, `reason`: `template`, `edit`, `restore`; global, no person, no text) | the persona service, after the version row is written (`prefrontal.md`, Events; built in P33.2) |
| `brain.prefrontal.style` | a person's style changed (`personId`, `fields`: the names `address`, `language`, `brevity`, `formality`, `gentleTopics`; never a value) | the style service, after the row is written (`prefrontal.md`, Events; built in P33.2) |

Every payload also carries an optional `personId`: `emit` derives it from the record's session id
(`front:<id>`, or the front of a worker's `front:<id>:agent:<task>`) and adds it when the payload has
none; events without a session (`node-changed`, global `budget-changed`) have none. The feed filter
uses the session id (`thalamus.md`); `personId` is for clients that group events. Visibility: a
person gets their own sessions' events; the owner also gets system events and the owner-routed
`brain.amygdala.wait` of members, never their previews.

Regions in `BrainRegionSchema`: `thalamus`, `wernicke`, `broca`, `cortex`, `motor`, `amygdala`,
`ras`, `hippocampus`, `parietal` (`parietal.md`), `hypothalamus` (`hypothalamus.md`), `corpus-callosum` (`corpus-callosum.md`, shared rooms). Also in the feed but not a brain event: `task-changed`
(`tasks.md`) and `budget-changed` (`budget.md`, payload `{ status }`, `BudgetChangedRecordSchema` in `activity.ts`). Every record of the feed, with its audience and payload contract, is in `thalamus.md` ("Activity feed records"). Payload `region` is always set; `sessionId` of the record is the session of the hook
(for `routed`, the front session; for cortex events, the worker session = task id).

## Motor exclusions

`brain.motor.act` is emitted for each tool result of a step except orchestration tools: `agent`,
`agent_output`, `agent_stop`, `send_message`, `todo_write`, `datetime`, and the six `memory_*` tools (they light the hippocampus instead). `ok` is true when the result
status is `output`. In a worker session (`ctx.session.parent` set) the event carries `taskId` (the
session id). The same hook in a worker emits no front phases.

## Plugin and helper

`brainEvents({ store, role })`, role `front` (turn phases, motor, amygdala) or `worker` (motor and
amygdala only; the `cortex` phases belong to `taskBoard`, which owns the row they describe).

`emit(store, type, sessionId, agentId, payload, warn?)` appends one event and returns at once:
fire and forget, `store.append(...).catch(warn)`. Hooks are bounded (30 s) and a slow store must not
stall a turn; a failed append is only reported to `warn` and never thrown.

Never emit from `tool.before`: AI SDK may call it again for the same tool call, so one call would
light the region twice. `step.end` and `turn.*` run once.

## Thalamus

Thalamus emits `brain.thalamus.routed` from the `chat.validate` option of `createHarnessHttp`: it
runs after `authorize` on the sanitised body, so only authenticated requests count. It fires for
`kind: 'send'` and carries the first 120 characters of the last user message (whitespace collapsed,
cut with an ellipsis). It never denies (returns `undefined`).

## Invariants

- Every payload parses with its schema in `packages/contracts/src/brain.ts`.
- Emission never blocks or fails a turn.
- No brain event comes from `tool.before`.

## Tests

`brain-events.test.ts`: a send turn lights wernicke and broca and its tool lights motor and
amygdala; orchestration tools are never motor acts; a worker motor act carries the task id and no
front phases; `emit` with a failing store reports and does not throw. `delegation.e2e.test.ts`: the feed
has `routed`, `wernicke.start`, `broca.*`, `cortex.start`, `cortex.end`, `ras.deliver` in order and
every payload parses.
