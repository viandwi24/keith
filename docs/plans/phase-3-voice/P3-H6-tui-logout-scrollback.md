---
id: P3-H6
title: "Hardening: TUI --logout and history scrollback"
phase: 3
wave: 6
lane: H
status: in-progress
owner: agent-P3-H6
depends: [P3-K2]
owns:
  - apps/tui/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/plans/phase-1-living-core/P1-F1-tui.md
  - docs/contracts/protocol.md
updates: []
scenarios: []
---

# P3-H6: Hardening: TUI --logout and history scrollback

## Goal

D7 from [hardening-audit.md](hardening-audit.md): the two TUI features P1-F1 left out.

## Scope

**In:**
- `keith-tui --logout`: calls `POST /v1/auth/logout` with the stored token, deletes the local token, exits 0.
- Scrollback: scrolling to the top loads older messages with `GET /v1/threads/:id/messages?before=<oldest>` until `hasMore` is false, keeping the view position.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [ ] Tests for logout (token file removed, endpoint called) and for loading an older page into the view.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
