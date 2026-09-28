---
id: P5-C2
title: "Group turns: human-to-human fan-out without an LLM turn, addressing, live participants"
phase: 5
wave: 2
lane: C
status: in-progress
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

- [ ] `group-turns.test.ts` (the existing mind test harness, a scripted fake LLM, a scripted fake `AddressingDetector`):
  - Tony, Pepper and Rhodey are attached to a group. Pepper writes "Rhodey, are you on your way?", and the detector says not addressed. Tony's and Rhodey's nodes get `message.user`, and the message is stored. There is no `message.started`, no `thread.state` change and no LLM request.
  - "Keith, what's the status?" (addressed) runs a turn whose `runCtx.personId` is the author, with all three participants.
  - Two non-addressed inputs during a running turn are stored after the reply without a second turn. One addressed input among them gives exactly one next turn, with all of them.
  - After `thread.participant_left` for Rhodey, his input is `FORBIDDEN`, and the next turn's participants leave him out. After `thread.participant_joined`, a new participant can send input without reloading the thread.
  - A group with one current participant runs a turn for every input, without calling the detector.
- [ ] `thread-manager.test.ts`: a delivery turn carrying two `relay` items stores `meta.relayFrom` with both senders in order, and `message.completed` carries it. Direct-thread tests pass unchanged.
- [ ] `bun run check` passes.

## Notes

- The detector may call the `utility` model (P5-D1), so `decide` can take a moment. Keep the thread's other work moving: decide outside the pump's critical section, and handle an input that arrives while an earlier one is still being decided in order.
- A test that needs the real detector belongs to P5-I1. Here, use a scripted fake from `mind/testing/`.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
