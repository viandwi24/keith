---
id: P1-I2
title: End-to-end scenarios S-1 to S-4
phase: 1
wave: 3
lane: I
status: todo
owner: null
depends: [P1-I1]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/sdk/**
  - packages/protocol/src/**
  - apps/tui/**
  - plugins/provider-openrouter/**
  - plugins/provider-deepseek/**
  - scripts/**
reads:
  - docs/concept/scenarios.md
  - docs/concept/model.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
  - docs/architecture/memory.md
  - docs/architecture/nodes.md
scenarios: [S-1, S-2, S-3, S-4]
---

# P1-I2: End-to-end scenarios S-1 to S-4

## Goal

Prove phase 1: the scenarios pass against the real core process, over the real protocol, with a scripted fake LLM.

## Scope

**In:**
- `tests/e2e/harness.ts`: boots the core in-process through `bootstrap({ home, plugins: [fakeLlmPlugin], clock })` with a temp `KEITH_HOME` and small `awayAfterMinutes`, creates persons, and offers a protocol-level client (login, WS, frame expectations with timeouts).
- One test file per scenario: `s1-arrival.test.ts`, `s2-background.test.ts`, `s3-restart.test.ts`, `s4-concurrency.test.ts`, implementing the tests described in scenarios.md.
- Fix integration bugs found along the way. This task alone may edit any phase-1 path in `owns`. Implementation bugs in `@keith/protocol` may be fixed. Contract *semantics* may not (blocker + ADR). **List every fix in the Outcome** with the lane it belonged to.
- Re-run the wave-1 lanes' key fake-backed tests against the real implementations (real SQLite, real scheduler).
- Human run: the coordinator (or the user) runs Keith with the TUI against a real model and follows S-2. Record observations and papercuts as follow-up tasks.

**Out:**
- New features. Anything that isn't a bug found by a scenario becomes a follow-up task.

## Acceptance criteria

- [ ] S-1, S-2, S-3, S-4 e2e tests pass in CI.
- [ ] Every fix is listed in the Outcome.
- [ ] Follow-up tasks are created for papercuts (phase-2 folder or a `phase-1-followups` list in the Outcome).
- [ ] No `> Planned (phase 1)` markers remain in `docs/architecture`.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
