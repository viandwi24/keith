---
id: P1-E1
title: "Mind: threads, turn loop, context builder, delivery flush, briefing"
phase: 1
wave: 1
lane: E
status: todo
owner: null
depends: [P0-04]
owns:
  - packages/core/src/mind/**
  - packages/core/src/builtins/skill.ts
reads:
  - docs/concept/model.md
  - docs/concept/scenarios.md
  - docs/architecture/core.md
  - docs/contracts/protocol.md
  - docs/contracts/providers.md
updates:
  - docs/architecture/core.md
scenarios: [S-1, S-2, S-4]
---

# P1-E1: Mind (threads, turn loop, context builder, delivery flush, briefing)

## Goal

Threads behave as core.md describes: turn states, queued input, cancellation, focus, streaming to attached nodes, tool loops, delivery turns and arrival briefings.

## Scope

**In:**
- `ThreadManager` implementation:
  - `open`: get or create the person's direct thread with slug `main` (plus its participant row), load the last N messages, and return `OpenedThread` (the **server** sends the `thread.opened` frame). Emit `thread.opened`. Apply the arrival policy if `arrival` is non-null (the only arrival trigger; don't subscribe to `person.arrived`), otherwise run a normal delivery check (flush trigger d).
  - `input`: persist the user message (author, node, modality), echo `message.user` to other attached nodes, set focus, queue if busy, run the turn in the `foreground` lane (Scheduler interface).
  - `cancel`: abort the current turn and persist the partial text with `meta.cancelled`.
  - Turn states and `thread.state` frames. Single-flight per thread, with a FIFO of pending inputs.
- `createRunLoop(deps)` → `RunLoop` per core.md (a pure function of registries and repositories; the scheduler lane also uses it for tasks): steps, stall watchdog, parallel tool calls through the tool registry's `invoke`, persisting tool messages when `persist` is set, provider retry (2x with backoff, retryable only), and reporting through `onEvent` (`RunLoop` never sends frames). The ThreadManager maps `RunLoopEvent`s to `message.*`, `tool.activity` and `ui.render` frames.
- Context builder with the nine sections in core.md order, each a separately tested function. Tool filtering by tier and capabilities. `recentMessages` window.
- Delivery flush per core.md "Flush triggers" (subscribe to `delivery.enqueued`, check after each turn, and when an arrival hold ends): if idle, present and not held, run a **delivery turn** (delivery lane) with pending deliveries in context and `proactive: true` frames, then `markDelivered(ids, messageId)` for every item in context. `critical` items go before queued input.
- Arrival policy from `open(... arrival)` per core.md "Presence and arrival": the `on-greeting` hold (pending deliveries go into the first user turn's context, are marked delivered after that reply, and the hold times out after `holdMs`), `auto` (briefing turn after `graceMs`), and `off`.
- `builtins/skill.ts`: the `skill.load` tool.

**Out:**
- Scheduler, task, commitment and delivery queue implementations (G1). Memory implementation (M1). Use fakes built from `types.ts`.

## Acceptance criteria

Tests use the fake LLM from `@keith/sdk/testing`, a fake NodeSink that records frames, and a fake clock:

- [ ] Streaming: frames arrive in the order `thread.state(thinking)` → `message.started` → `thread.state(speaking)` → `message.delta`… → `message.completed` → `thread.state(idle)`.
- [ ] A tool call loop runs the tool, feeds the result back, and completes. A tool error becomes a tool result, not a crash.
- [ ] Input while speaking is queued and runs next, with both user messages in the second context.
- [ ] `input.cancel` stops streaming and persists a partial message with `cancelled`.
- [ ] I-7: a second attached node gets `message.user` echo and all text frames. Focus follows the latest input.
- [ ] I-11 / S-2: a delivery enqueued while idle and present produces a `message.started { proactive: true }` without input.
- [ ] A delivery enqueued while away waits. On `open` with `arrival` and `briefing = on-greeting`, no delivery turn runs. The reply to "hello" has the delivery in context, and the delivery is marked delivered with that reply's `messageId` (S-1).
- [ ] `on-greeting` hold times out after `holdMs` with no input, then a normal delivery turn runs (fake clock).
- [ ] `open` without arrival and with pending deliveries runs a delivery turn right away.
- [ ] S-4: two threads for two persons run turns concurrently (fake LLM with delays; the total time is less than the sum).
- [ ] Stall watchdog aborts a silent step (fake clock).
- [ ] `bun run check` passes.

## Outcome

_To be filled._
