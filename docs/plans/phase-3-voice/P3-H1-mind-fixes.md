---
id: P3-H1
title: "Hardening: Mind fixes (tool events, flush guards, focus, history, cancelAll, RATE_LIMITED)"
phase: 3
wave: 6
lane: H
status: in-progress
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

- [ ] One test per item above, each failing before the fix.
- [ ] Existing mind and plugins tests pass.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
