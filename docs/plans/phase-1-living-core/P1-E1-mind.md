---
id: P1-E1
title: "Mind: threads, turn loop, context builder, delivery flush, briefing"
phase: 1
wave: 1
lane: E
status: done
owner: agent-P1-E1
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

- [x] Streaming: frames arrive in the order `thread.state(thinking)` → `message.started` → `thread.state(speaking)` → `message.delta`… → `message.completed` → `thread.state(idle)`.
- [x] A tool call loop runs the tool, feeds the result back, and completes. A tool error becomes a tool result, not a crash.
- [x] Input while speaking is queued and runs next, with both user messages in the second context.
- [x] `input.cancel` stops streaming and persists a partial message with `cancelled`.
- [x] I-7: a second attached node gets `message.user` echo and all text frames. Focus follows the latest input.
- [x] I-11 / S-2: a delivery enqueued while idle and present produces a `message.started { proactive: true }` without input.
- [x] A delivery enqueued while away waits. On `open` with `arrival` and `briefing = on-greeting`, no delivery turn runs. The reply to "hello" has the delivery in context, and the delivery is marked delivered with that reply's `messageId` (S-1).
- [x] `on-greeting` hold times out after `holdMs` with no input, then a normal delivery turn runs (fake clock).
- [x] `open` without arrival and with pending deliveries runs a delivery turn right away.
- [x] S-4: two threads for two persons run turns concurrently (fake LLM with delays; the total time is less than the sum).
- [x] Stall watchdog aborts a silent step (fake clock).
- [x] `bun run check` passes.

## Outcome

**Built** (`packages/core/src/mind/`, `packages/core/src/builtins/skill.ts`):

- `run-loop.ts`: `createRunLoop(deps)` → `RunLoop`. Steps up to `maxSteps`, parallel tool calls through `tools.invoke` (a throwing registry is still turned into an error result), tool specs from each tool's zod schema (`z.toJSONSchema`), stall watchdog per step (`stallMs`, reset on every stream event), retry of retryable `ProviderError`s 2x with exponential backoff (500 ms base), provider failures surfaced as `KeithError('PROVIDER_ERROR')`, cancellation returns the partial text with `stoppedBy: 'cancelled'`. With `persist`, each tool step is stored (assistant row with `toolCalls` + one `tool` row per call) and `thread.message_added` is emitted. Emits `tool.called` / `tool.completed`. Reports through `onEvent` only.
- `context-sections.ts`: the nine sections as separate pure functions. `context-builder.ts`: `createContextBuilder(deps)` assembles them in core.md order, loads the `recentMessages` window, and filters tools by the lowest participant tier and the focus node's capabilities. `personaFromFile(path)` is the persona reader for bootstrap.
- `messages.ts`: record → `LlmMessage` replay (drops orphan tool rows, strips incomplete tool calls), record → `MessageDto` (hides tool rows and tool-call steps), `lowestTier`.
- `thread-manager.ts`: `createThreadManager(deps)` → `MindThreadManager` (`ThreadManager` + `idle()` for tests and `stop()` for shutdown). Get-or-create `main` thread, per-thread single-flight pump with FIFO input, `thread.state` frames + `thread.state_changed`, `message.user` echo to other nodes, focus, cancel, streaming frames, `tool.activity`, `ui.render` only to nodes with `ui.render@1` (capabilities read from `repos.nodes`), error frame + apology message on failure, `turn.*` events. Delivery flush on all four triggers, `critical` before queued input, delivery lane with `proactive: true`, `markDelivered(ids, messageId)`. Arrival: `on-greeting` hold (deliveries go into the first user turn; timeout after `holdMs` → delivery turn), `auto` (briefing turn after `graceMs`), `off`.
- `builtins/skill.ts`: `createSkillLoadTool({ skills })` → the `skill.load` tool (guest tier; unknown names return an error result that lists the known skills).
- Tests: 50 tests in `mind/*.test.ts`. They cover every acceptance criterion and use in-memory fakes built from the other lanes' `types.ts` (`mind/testing/fakes.ts`, wired by `mind/testing/harness.ts`). Timers use `jest.useFakeTimers()` together with the fake clock.

**Decisions and details** (documented in core.md, in the prose sections only):

- Inputs that arrive while a turn runs are echoed at once, but persisted when their turn starts. All waiting inputs join one turn. This keeps history ordered `user → reply → user`.
- Nodes see one assistant message per turn, with all the text streamed in that turn. Tool-step rows are internal (replayed to the model, never sent to nodes).
- A retryable error is retried only before the step's first event. A stall is not retried.
- After a failed or cancelled turn there is no automatic re-flush, so a broken delivery turn cannot loop. A cancelled delivery turn does not mark its items delivered.
- The delivery check on `open` (trigger d) runs on the next macrotask, so the server's `thread.opened` goes out first.
- The `auto` grace period acts as a short hold. Input during a hold or grace ends it, and that user turn carries the deliveries.
- Frame ids: `Ids` only makes prefixed ids, so frame ids are the ULID part of an `ids.next('trn')` value.
- Delivery and briefing turns use the `foreground` model role. `runCtx.personId` is the author of the last input, or else the first participant.

**Deviations / notes for integration:**

- Added `zod@^4.6.5` to `@keith/core` (`bun add` in `packages/core`) for the `skill.load` input schema and JSON Schema conversion. This matches the sdk's version. Other lanes may add the same dependency: on a rebase conflict, take main's version.
- The `skill.load` tests live in `mind/skill-load-tool.test.ts` because this task owns only `builtins/skill.ts`. They import that file directly (a test-only exception to R-3).
- `open` loads the latest `MESSAGES_PAGE.defaultLimit` (50) messages. `ThreadManager.open` has no `historyLimit` parameter, so the server can only trim this list, not get more. Follow-up: add `historyLimit` to `open` if nodes need more than 50.
- `ThreadManager` gets node capabilities from `repos.nodes`, because `NodeSink` has none. The server must upsert the node record (from `hello`) before calling `open` or `input`.
- The server should attach the node before or right after `open`. Turn frames go to `attachedTo(threadId)`.
- Integration (bootstrap) wiring: `createRunLoop({ providers, tools, repos, events, ids, clock, log, stallMs: config.mind.turn.stallMs })`, `createContextBuilder({ config, persona: personaFromFile(paths.personaFile), clock, repos, memory, commitments, skills, tools })`, `createThreadManager({ config, repos, nodes: attachments, presence, scheduler, deliveries, context, runLoop, events, ids, clock, log })`, and `tools.registerBuiltin(createSkillLoadTool({ skills }))`.
- No contradictions found between docs.
