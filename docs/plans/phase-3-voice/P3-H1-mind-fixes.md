---
id: P3-H1
title: "Hardening: Mind fixes (tool events, flush guards, focus, history, cancelAll, RATE_LIMITED)"
phase: 3
wave: 6
lane: H
status: review
owner: agent-P3-H1
depends: [P3-K2]
owns:
  - packages/core/src/mind/**
  - packages/core/src/plugins/tools.ts
  - packages/core/src/plugins/tools.test.ts
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/architecture/core.md
  - docs/contracts/events.md
  - docs/contracts/protocol.md
updates:
  - docs/architecture/core.md
scenarios: []
---

# P3-H1: Hardening: Mind fixes (tool events, flush guards, focus, history, cancelAll, RATE_LIMITED)

## Goal

Fix B1–B6 and the mind side of C2 from [hardening-audit.md](hardening-audit.md). Each fix starts with a failing test.

## Scope

**In:**
- B1: emit `tool.called` / `tool.completed` from one place only. The registry's `invoke` is the owner (it also serves `onAction`); it emits for every invocation, including unknown/invalid/tier-refused ones (`ok: false`). The run loop stops emitting. T3: a test through the real registry counts exactly one pair per call.
- B2: no delivery or briefing flush while the thread is `listening`.
- B3: reproduce first. If real, a failed delivery turn doesn't pre-empt queued user input again in the same pump run; the input runs next.
- B4: focus fallback is the most recently attached node (`attachedTo(...).at(-1)`); test with three nodes.
- B5: `open` honors `historyLimit` (1..200, default 50).
- B6: `MindThreadManager.cancelAll(): Promise<void>` aborts every running turn and resolves when they persisted. (Bootstrap switches to it in P3-I3.)
- C2: a turn that fails because the provider answered `rate_limited` (after the retries) raises `KeithError('RATE_LIMITED')` instead of `PROVIDER_ERROR`.
- Update core.md's provider-error prose for the `RATE_LIMITED` split (P3-K2 note).

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] One test per item above, each failing before the fix.
- [x] Existing mind and plugins tests pass.
- [x] `bun run check` passes.

## Outcome

Every item got a test first; all of them failed before the fix (B3 reproduced: the turn kinds were `user, delivery, delivery` instead of `user, delivery, user`).

**Built**
- **B1** (`plugins/tools.ts`, `mind/run-loop.ts`): `CoreToolRegistry.invoke` is the only emitter of `tool.called` / `tool.completed`. It emits the pair for every invocation, including unknown tools, tier refusals, invalid input and calls already aborted (`ok: false`); the checks moved into an inner `attempt`. The run loop no longer emits bus tool events (it still sends `tool.started` / `tool.completed` through `onEvent`). Tests: `tools.test.ts` (refused calls emit one pair each), `run-loop.test.ts` T3 (the real registry under the real run loop: exactly one pair per call, ok and unknown). The mind's fake registry (`mind/testing/fakes.ts`) now emits like the real one when given a bus.
- **B2** (`thread-manager.ts`): `canFlush` requires `listening === null`, and a due briefing waits while listening. When listening ends without input (`voiceActivity` `speaking: false`, or the speaking node detaching) the pump is kicked, so the waiting flush or briefing runs (flush trigger (e) in core.md). Tests for a delivery and for an `auto` briefing.
- **B3**: the pump tracks `preempt` for its run. After a delivery or briefing turn that fails or is cancelled, queued input is no longer pre-empted by critical items in that pump run, so the input runs next; the normal flush after that turn retries the delivery once.
- **B4**: focus fallback is `attachedTo(threadId).at(-1)` (most recently attached). Test with three nodes.
- **B5**: `open` returns the latest `historyLimit` visible messages (default 50, clamped to 0..200). It pages with `roles: ['user', 'assistant']` and keeps paging back when tool-step assistant rows are hidden, so the count is exact. Test with 130 exchanges, each with a hidden tool step.
- **B6**: `MindThreadManager.cancelAll(): Promise<void>` aborts every running turn and resolves when every pump has finished (so each turn persisted its cancelled reply). No new turn starts while it runs; a turn picked in that window is aborted at start. `stop()` now also blocks new turns (bootstrap calls it before cancelling). Bootstrap still uses its own loop until P3-I3.
- **C2**: the run loop raises `KeithError('RATE_LIMITED')` when the provider's final error is `rate_limited` (after retries, or when it arrives after streamed output), `PROVIDER_ERROR` otherwise. The thread manager sends the `error` frame with `RATE_LIMITED` and `turn.failed` carries it. Rebased on `fc07851`, which added the code to `KEITH_ERROR_CODES`.
- **Docs** (`core.md`): focus fallback, history on open, `cancelAll` and `stop`, tool events owned by `tools.invoke`, the `RATE_LIMITED` split in the provider-errors line, flush trigger (e) and no flush or briefing while listening, and the B3 rule under "Delivery turn".

**Decisions**
- `historyLimit` range is 0..200 (0 = no messages), following `mind/types.ts` and the wire schema (P3-K2), not the task's "1..200".
- B3's guard lasts for one pump run, not forever: a later input can be pre-empted again by a new critical item.
- `stop()` starting no new turn is a small widening of its meaning. It matches bootstrap's comment ("No new delivery turns") and keeps `cancelAll` from racing a queued input during shutdown.

**Deviations**
- `run-loop.test.ts` "gives up after two retries" used `rate_limited` and expected `PROVIDER_ERROR`; it now expects `RATE_LIMITED` (the C2 unit test).
- The `ui.action` `onAction` path in `thread-manager.ts` doesn't go through `tools.invoke` and still emits no tool events (unchanged).

**Follow-ups**
- P3-I3: switch bootstrap's shutdown to `threads.cancelAll()` and drop `trackRunningTurns` / `cancelRunningTurns`.
