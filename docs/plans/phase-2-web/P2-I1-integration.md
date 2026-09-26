---
id: P2-I1
title: "Integration and S-8 end to end in a real browser"
phase: 2
wave: 4
lane: I
status: todo
owner: null
depends: [P2-C1, P2-E1]
owns:
  - tests/e2e/**
  - packages/core/**
  - packages/client/**
  - packages/sdk/**
  - packages/protocol/src/**
  - plugins/web/**
  - plugins/tool-weather/**
  - apps/tui/**
  - scripts/**
  - package.json
  - .github/**
reads:
  - docs/concept/scenarios.md
  - docs/architecture/ui.md
  - docs/plans/phase-2-web.md
updates:
  - docs/architecture/ui.md
  - docs/architecture/overview.md
scenarios: [S-8]
---

# P2-I1: Integration and S-8 end to end

## Goal

S-8 plays out for real: Keith runs with the TUI only, then `@keith/web` is enabled, and a browser shows the same Thread with the weather card rendered, while nothing in the Mind or tool plugins changed.

## Scope

**In:**
- `keith setup` offers to enable `@keith/web` and `@keith/tool-weather`; bootstrap/config wiring as needed.
- `tests/e2e/s8-web.test.ts` with Playwright (Chromium is preinstalled at `/opt/pw-browsers`; read the current Playwright docs for Bun): boot the core with the fake LLM scripted to call `weather.current` (fake `fetch` for the weather plugin), open the built web app, log in, see history from a TUI-driven turn, see the card render, click "Refresh" and see the updated card, and confirm the TUI protocol client received the same text (I-7) and the `fallbackText`.
- CI: build the web app and run the Playwright test.
- Fix integration bugs in owned paths; list every fix with its lane. Contract semantics may not change (blocker + ADR).
- Human run: the coordinator (or the user) runs Keith with the web app against a real model; notes go in Outcome.

**Out:** new features.

## Acceptance criteria

- [ ] S-8 e2e passes locally and in CI, 5 runs in a row.
- [ ] Every fix listed in Outcome.
- [ ] No `> Planned (phase 2)` markers left in docs/architecture.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
