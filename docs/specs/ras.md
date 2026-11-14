# RAS (proactive marking)

Code: `apps/core/src/modules/ras/proactive.ts`. Tests: `ras.test.ts`, `apps/core/src/delegation.e2e.test.ts`,
`apps/core/src/spike-park.test.ts`.

## Purpose

Tell the owner which messages Keith started by itself (a worker's report woke the front agent), so
a client can mark them (the TUI shows a diamond), and announce the delivery in the brain feed.

## Public API

`proactive({ store })`: a plugin for the FRONT agent (plugin name `keith`). `PROACTIVE_REASON` is
`'subagent-report'`.

Data part `proactive` (full type `data-keith.proactive`): `{ reason: 'subagent-report' }`, with
`model: 'omit'`, so the model never sees it. It is stored with the assistant message, returned by
`GET /sessions/:id/messages` and carried by the stream.

## Behaviour

1. `message.saved`: for each saved message with a `data-eh.event` part named `subagent` whose data
   has a `taskId`, remember `{ taskId, messageId, at }` per session (deduplicated by message id,
   last 20 kept). That event part is how eharness stores a worker report in the lead's history.
2. `turn.start` with `kind: 'wake'` (a turn with no user input, started by the inbox): write
   `ctx.stream.data('proactive', { reason }, { id: 'proactive' })` into the assistant message of the
   turn, then move the noted reports of the session to this turn and clear them. Every `turn.start`
   also records the start time of the turn of that session.
3. `turn.end` of such a turn: append `brain.ras.deliver` `{ region: 'ras', taskId, messageId? }` for
   each distinct reported task (`messageId` = the turn's assistant message, when known), with
   `sessionId` and `agentId` of the turn.
4. `turn.end` of any other turn: drop the noted reports older than that turn's start.

A turn of `kind: 'send'` is never marked: the answer to an owner message is a reply, not an
interruption, even when a report was noted before it.

## Known gap

A report delivered into a turn the owner started (`kind: 'send'`, the report is read mid-turn by
the running loop) is not marked and emits no `brain.ras.deliver`: that turn answers the owner.
The task still shows `done` on the board, and the owner sees the result inside the reply. Marking
such a reply is future work (it needs a part written by a mid-turn hook).

## Invariants

- The mark exists only on assistant messages of `wake` turns.
- `brain.ras.deliver` is emitted once per task per wake turn, after the turn ends.
- A failing store never fails the turn (`emit` is fire and forget, `brain-events.md`).

## Tests

`ras.test.ts`: a wake turn is marked and `brain.ras.deliver` names the task and the message; an
answer to an owner message is not marked even with a report noted before it. `delegation.e2e.test.ts`: the
wake message is stored proactive and visible in `messages`; after a restart the interrupted task
is reported proactively. `spike-park.test.ts`: the shape was proven there first.
