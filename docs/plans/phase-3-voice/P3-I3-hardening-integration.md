---
id: P3-I3
title: "Hardening integration: wiring, e2e gaps and doc fixes"
phase: 3
wave: 8
lane: I
status: todo
owner: null
depends: [P3-H1, P3-H2, P3-H3, P3-H4, P3-H5, P3-H6, P3-H7]
owns:
  - packages/**
  - plugins/**
  - apps/**
  - tests/**
  - scripts/**
  - package.json
  - .github/**
  - docs/architecture/**
  - docs/concept/scenarios.md
  - docs/rules/engineering.md
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/plans/phase-3-voice/P3-I1-integration.md
updates:
  - docs/architecture/**
  - docs/concept/scenarios.md
scenarios: []
---

# P3-I3: Hardening integration: wiring, e2e gaps and doc fixes

## Goal

Wire the hardening lanes into a real `keith start`, close the e2e gaps, and apply every doc fix in [hardening-audit.md](hardening-audit.md). After this, the audit list has nothing open except the owner's manual items.

## Scope

**In:**
- Bootstrap: acquire the home lock first and release it last (D1); the file log writer (D2); `cancelAll()` replaces the busy-thread workaround (B6); pass `pluginStatus` / `voiceConfigured` to the server (C1). Add the H5 sync check to `bun run check` if H5 couldn't.
- e2e: T1 (S-8 TUI-only → enable web → restart → same thread and card) and T2 (S-1 non-greeting branch).
- Every item in the audit's "Doc fixes" list.
- Integration fixes per lane recorded in the Outcome.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] Two `keith start` on one home: the second fails with a readable error (test).
- [ ] T1 and T2 pass 5 runs in a row.
- [ ] Every audit item is ticked in hardening-audit.md or listed as manual.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
