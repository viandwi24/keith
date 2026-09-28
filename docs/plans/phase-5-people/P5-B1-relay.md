---
id: P5-B1
title: "Relay: relay.send with I-13 checks, relay.block and relay.unblock"
phase: 5
wave: 2
lane: B
status: in-progress
owner: agent-P5-B1
depends: [P5-K1]
owns:
  - packages/core/src/scheduler/relay.ts
  - packages/core/src/scheduler/relay.test.ts
  - packages/core/src/builtins/relay.ts
  - packages/core/src/builtins/relay.test.ts
reads:
  - docs/plans/phase-5-people/README.md
  - docs/decisions/0017-tier-rules-for-relays-and-group-threads.md
  - docs/concept/model.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
scenarios: [S-5]
---

# P5-B1: Relay

## Goal

"Tell Pepper I'll be late" works (S-5), and only when I-13 allows it. The relay is a delivery authored by Tony in Pepper's main thread. Pepper can block relays from anyone.

## Scope

**In:**
- `createRelayService(deps)` (`scheduler/relay.ts`, same deps as the P5-K1 placeholder):
  - `send`:
    - `self` when sender and recipient are the same person.
    - `unknown_recipient` when the recipient doesn't exist or has no `main` thread.
    - `not_allowed` when ADR-0017's tier rule refuses it (a guest may relay only to the owner), or when the recipient's `blockedRelayFrom` names the sender.
    - Otherwise `deliveries.enqueue({ personId: to, threadId: <their main>, kind: 'relay', authorPersonId: from, source: 'core', urgency: 'normal', content: text })`, answered with `{ ok: true, delivery }`.
  - `block` / `unblock`: read the card (a missing card is created empty), add or remove the id, and upsert only when the list changed. Keep `tone` and `notes`.
- The tools (`builtins/relay.ts`, keeping P5-K1's names, schemas, `minTier` and `RELAY_MESSAGES`):
  - `relay.send { to, text }`: resolves `to` with `deps.persons.findByName`, then calls `send`. The answers are ADR-0017's: sent ("I'll pass that on to Pepper."), unknown name, generic refusal, and "You can't relay to yourself."
  - `relay.block { from }` / `relay.unblock { from }` act on the caller's own card, and answer whether anything changed.
- core.md: the "Relays" subsection (checks, delivery shape, attribution, no memory), with the `(P5-B1)` marker removed.

**Out:**
- How the delivery turn shows the relay: the section-8 label (P5-C3) and `meta.relayFrom` (P5-C2).
- The CLI block commands (P5-A1).
- Relays into group threads: v1 relays go to the recipient's main thread only.

## Acceptance criteria

- [ ] `relay.test.ts` (fake repositories and delivery queue), each test named with the invariant:
  - "I-13: member relays to member" enqueues a `relay` delivery authored by the sender in the recipient's main thread.
  - "I-13: guest may relay only to the owner": to the owner ok, to a member `not_allowed`.
  - "I-13: a block refuses" even for the owner as sender.
  - `self`, `unknown_recipient` (no person, and a person without a main thread).
  - `block` / `unblock` are idempotent and keep `tone` and `notes`.
- [ ] `builtins/relay.test.ts`: `relay.send` answers the same generic text for a tier refusal and for a block. It resolves names case-insensitively, and answers the unknown-name text.
- [ ] `bun run check` passes.

## Notes

- `DeliveryQueue.enqueue` emits `delivery.enqueued`. The thread manager flushes it into Pepper's thread when she is present and idle, or on her next arrival (existing behavior, I-11).
- Keep the relay text verbatim in the delivery. The model phrases it in the delivery turn, and the node shows `meta.relayFrom`, so the sender is visible even if the model paraphrases.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
