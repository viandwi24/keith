---
id: P3-H5
title: "Hardening: core.md interface sync check and check-deps tests rule"
phase: 3
wave: 6
lane: H
status: in-progress
owner: agent-P3-H5
depends: [P3-K2]
owns:
  - scripts/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/architecture/core.md
  - docs/architecture/repository.md
updates: []
scenarios: []
---

# P3-H5: Hardening: core.md interface sync check and check-deps tests rule

## Goal

D5 and D6 from [hardening-audit.md](hardening-audit.md).

## Scope

**In:**
- `scripts/check-core-docs.ts` (+ tests): for every `### … (\`<folder>/types.ts\`)` section in core.md, the fenced `ts` block equals the exported declarations of that file (normalize whitespace; decide and document what is compared). Add it to the `check` script chain only if the root `package.json` is in owns; otherwise record the one-line change for P3-I3.
- check-deps: files under `tests/` other than `tests/e2e` may not import `@keith/core`.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] The sync check passes on main and fails on a fixture with a drifted block.
- [ ] check-deps test for the `tests/` rule.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
