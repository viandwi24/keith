---
id: P5-C2
title: "Group turns: human-to-human fan-out without an LLM turn, addressing, live participants"
phase: 5
wave: 2
lane: C
status: done
owner: agent-P5-C2
depends: [P5-K1]
owns:
  - packages/core/src/mind/thread-manager.ts
  - packages/core/src/mind/thread-manager.test.ts
  - packages/core/src/mind/group-turns.test.ts
  - packages/core/src/mind/testing/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/concept/model.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/contracts/protocol.md
updates:
  - docs/architecture/core.md
scenarios: [S-6, S-5]
---

# P5-C2: Group turns

## Goal

In a group thread, people talk to each other through Keith without Keith answering every line (S-6 step 3). A message reaches everyone's attached nodes at once, and the Mind takes a turn only when it is addressed. The thread manager follows joins and leaves live. Delivery turns that carry relays mark their message with the sender (I-13).

## Scope

**In** (`mind/thread-manager.ts`):
- **Live participants.** Subscribe to `thread.participant_joined` / `thread.participant_left` and update the cached runtime participants of a loaded thread. A leaver's queued inputs stay queued (they were said), and a leaver can't send new input (`FORBIDDEN`, as today for non-participants).
- **Group input** (only `kind: 'group'`; direct threads are unchanged):
  - The echo to other attached nodes stays immediate (`message.user`, as today).
  - When the thread is idle and nothing is queued, the thread manager asks `deps.addressing.decide(...)` (the input, up to 10 visible messages before it, the participants' names). Not addressed: persist the message at once, and no turn, no `thread.state` change and no LLM call. Addressed: queue it, and the turn runs as today.
  - While a turn runs, inputs queue as today. When the turn ends, the queued inputs are decided in order. If any is addressed, they all become the next turn. If none is, they are persisted without a turn. History order stays `user → reply → next user`.
  - With fewer than two current human participants, every input is addressed (`single_human`, D14). Without `deps.addressing`, every input is addressed (phase-4 behavior).
  - Log each verdict at debug with its `by`, never the text.
- **Turn actor.** A group turn's `runCtx.personId` is the author of its latest input, and `participants` is the current participants. Delivery and briefing turns in a group use the thread's owner if they are still a participant, else the first current participant.
- **Deliveries in a group** (task results for tasks started there, P5-E1): the flush rule stays "idle, some participant present, no hold". An arrival hold applies only to direct threads.
- **Relay attribution.** A delivery turn whose items include `relay` deliveries stores `meta.relayFrom` (the senders' `{ personId, name }`, in order) on its assistant message, so `message.completed` and history carry it. The same goes for an arrival user turn that carries relays.
- **`thread.opened` DTO:** `purpose` and `formerParticipants` for group threads (the same shape as P5-N1's `GET /v1/threads`).
- core.md: the "Group threads" turn rules and the relay attribution, with their `(P5-C2)` markers removed.

**Out:** the addressing rules themselves (P5-D1), context contents such as names, cards and the relay label (P5-C3), membership (P5-C1), frames to nodes that don't have the thread open (P5-N1).

## Acceptance criteria

- [x] `group-turns.test.ts` (the existing mind test harness, a scripted fake LLM, a scripted fake `AddressingDetector`):
  - Tony, Pepper and Rhodey are attached to a group. Pepper writes "Rhodey, are you on your way?", and the detector says not addressed. Tony's and Rhodey's nodes get `message.user`, and the message is stored. There is no `message.started`, no `thread.state` change and no LLM request.
  - "Keith, what's the status?" (addressed) runs a turn whose `runCtx.personId` is the author, with all three participants.
  - Two non-addressed inputs during a running turn are stored after the reply without a second turn. One addressed input among them gives exactly one next turn, with all of them.
  - After `thread.participant_left` for Rhodey, his input is `FORBIDDEN`, and the next turn's participants leave him out. After `thread.participant_joined`, a new participant can send input without reloading the thread.
  - A group with one current participant runs a turn for every input, without calling the detector.
- [x] `thread-manager.test.ts`: a delivery turn carrying two `relay` items stores `meta.relayFrom` with both senders in order, and `message.completed` carries it. Direct-thread tests pass unchanged.
- [x] `bun run check` passes.

## Notes

- The detector may call the `utility` model (P5-D1), so `decide` can take a moment. Keep the thread's other work moving: decide outside the pump's critical section, and handle an input that arrives while an earlier one is still being decided in order.
- A test that needs the real detector belongs to P5-I1. Here, use a scripted fake from `mind/testing/`.

## Outcome

No ADR, no contract or `types.ts` change. Bootstrap is unchanged: until P5-I1 passes `addressing`, every group input is addressed (phase-4 behavior).

**Built** (`mind/thread-manager.ts`)
- **Runtime** now knows the thread's `kind` and `ownerPersonId` (read with the participants when it loads).
- **Live participants:** subscribes to `thread.participant_joined` / `thread.participant_left` and updates the cached participants of a loaded (or loading) thread; an unloaded thread reads storage when it loads. A leaver's queued inputs stay queued; new input and `open` from them are `FORBIDDEN` as for any non-participant.
- **Group input:** the echo is unchanged. In the pump, a group's queued inputs are taken as a batch and decided in order (`anyAddressed`), stopping at the first addressed one. Addressed: the batch is the next user turn. Not addressed: each input is appended at once (`thread.message_added`, no `turn.started`, no `thread.state`, no LLM call) and the pump loops. `recent` = the latest 10 visible stored messages plus the batch's earlier inputs, trimmed to 10. Fewer than two current participants → addressed by `single_human` without calling the detector; no detector → addressed (`default`). Verdicts are logged at debug with `threadId`, `messageId`, `addressed`, `by`, never the text. A detector that throws is treated as `unsure` (not addressed) with a warning.
- **Turn actor:** user turns act as the latest input's author (unchanged); delivery and briefing turns act as the owner while a participant, else the first current participant. `participants` are always the current ones.
- **Arrival hold** (and the `auto` briefing grace) applies only to direct threads; a group open with an arrival just checks the queue.
- **Relay attribution:** any turn whose deliveries include `relay` items stores `meta.relayFrom` (one `{ personId, name }` per sender, first-appearance delivery order; a sender who no longer exists is skipped). It flows through `message.completed` and history via the existing `toMessageDto` copy. Applies to delivery turns and arrival user turns alike.
- **`thread.opened` DTO:** for `kind: 'group'`, `purpose` (when the record has one) and `formerParticipants` (always present, possibly empty; `PersonDto`s in `formerParticipants` order, most recent leaver first).

**Tests**
- New `mind/group-turns.test.ts` (15 tests): every acceptance case, plus decide-during-decide ordering, no detector, direct threads never ask, a leaver's queued input is stored, a group dropping to one human, `thread.opened` fields, no arrival hold in a group, and the delivery actor with and without the owner.
- `thread-manager.test.ts`: a delivery turn with three relays from two senders stores and sends `relayFrom` with both senders in order (and history returns it); an arrival user turn carrying a relay stamps it too. Existing direct-thread tests unchanged.
- `mind/testing`: `createFakeAddressing` (scripted verdicts, recorded calls, optional gate to model a slow classifier) in `fakes.ts`; the harness takes `addressing`, records every turn's `runCtx` (`runCtxs`), exposes `addPerson` and `openGroup`, and defines `RHODEY` / `RHODEY_PHONE` (not created by default).

**Decisions**
- **Deciding runs in the pump**, not in `input()`. "Decide outside the pump's critical section" is met as: `input()` never waits for a decision, other threads are unaffected, and a later input queues behind the decision in order. The cost is that a delivery or a `ui.action` job in the same group waits for a decision in progress (at most the detector's 5 s timeout). Running deliveries while an earlier input is still undecided would have broken history order (`user → reply`) and the addressed input's context, so I kept it simple.
- **Stop at the first addressed input** of a batch: the later ones join the turn anyway, so asking the detector about them would only cost `utility` calls.
- `cancelAll` / `stop` abort the decision in progress through its signal (the detector's job to honour it).
- `relayFrom` is stamped whenever the turn carried relays, also on a failed or cancelled turn (its partial text was about them); the items stay pending, so the retry stamps again.

**Deviations**
- None in scope. core.md's "Group threads" turn rules and the Relays attribution line lost their P5-C2 markers; the remaining markers name only P5-C1, P5-D1 (Group threads) and P5-B1, P5-C3 (Relays). The "Queue details" rule in "Threads and turn state" points to the group rules.

**Notes for other lanes**
- **P5-D1:** `decide` is called only for group threads with two or more current participants; `recent` may include not-yet-stored inputs of the same batch (records with no `seq`). Honour `signal` (aborted on shutdown). `participantNames` are in participant order.
- **P5-C1:** emit `thread.participant_joined` / `_left` only after the storage write; the thread manager updates its cache from the event alone and never re-reads storage for a loaded thread.
- **P5-N1:** the thread manager's `thread.opened` DTO for groups has `purpose` (absent when null) and `formerParticipants` (always an array); match that in `GET /v1/threads`. Detaching a leaver's nodes from the group is the server's job; the thread manager only refuses their input.
- **P5-I1:** pass `addressing` into `createThreadManager`; group turns then follow the real detector.
