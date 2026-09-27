---
id: P3-H7
title: "Hardening: UI blocks on deliveries, and order by seq"
phase: 3
wave: 7
lane: H
status: todo
owner: null
depends: [P3-H1, P3-H3]
owns:
  - packages/core/src/mind/**
  - packages/core/src/scheduler/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/contracts/plugin-api.md
  - docs/architecture/ui.md
  - docs/architecture/core.md
updates:
  - docs/architecture/core.md
  - docs/architecture/ui.md
scenarios: []
---

# P3-H7: Hardening: UI blocks on deliveries, and order by seq

## Goal

C5 and the mind side of D3 from [hardening-audit.md](hardening-audit.md).

## Scope

**In:**
- When a delivery or briefing turn delivers items that carry `ui` (plugin deliveries, task results), the blocks are attached to that turn's assistant message: persisted as `ui` entries, sent as `ui.render` to `ui.render@1` nodes, with fallback text for the others, exactly like tool UI. Items are marked delivered with the message id.
- Remove the 1 ms restamp (`inOrder`) now that storage orders by `seq`.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] A plugin delivery with a card shows up in `thread.opened` history and as `ui.render` on a web-like node; a text-only node gets the fallback.
- [ ] A task result's `ui` reaches the delivered message.
- [ ] History order tests pass without the restamp.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
