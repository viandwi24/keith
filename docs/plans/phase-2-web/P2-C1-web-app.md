---
id: P2-C1
title: "@keith/web browser app: React + Tailwind + shadcn/ui"
phase: 2
wave: 3
lane: C
status: in-progress
owner: agent-P2-C1
depends: [P2-A1, P2-B1, P2-D1]
owns:
  - plugins/web/app/**
  - plugins/web/package.json
  - plugins/web/.gitignore
  - docs/decisions/0012-web-bundler.md
reads:
  - docs/architecture/ui.md
  - docs/contracts/ui-blocks.md
  - docs/contracts/protocol.md
  - docs/architecture/stack.md
  - docs/decisions/0011-client-app-browser-side.md
updates:
  - docs/architecture/stack.md
  - docs/architecture/ui.md
scenarios: [S-8]
---

# P2-C1: @keith/web browser app

## Goal

The same Threads in a browser, with every standard UI block rendered, the `html` block sandboxed, and buttons that send `ui.action`. The browser is a Node like the TUI: it uses `@keith/client` and the public `/v1` protocol only (I-8, ADR-0011).

## Scope

**In:**
- **Decide the bundler** (Bun's HTML bundler vs Vite) after reading both current docs; output must be static assets in `plugins/web/dist/` that P2-B1's plugin serves. Write `docs/decisions/0012-web-bundler.md` (`status: proposed`) and update the bundler row in stack.md. Add `build` / `dev` scripts to `plugins/web/package.json`.
- React + Tailwind + shadcn/ui, set up with their official commands (`bunx shadcn@latest init/add`, R-18, R-19), inside `plugins/web/app/`.
- Screens: login, main thread view with history, streaming assistant text, turn-state indicator, tool activity lines, proactive messages marked, input with send and cancel, reconnect state.
- UI blocks: a renderer per standard block type using shadcn components and theme tokens; `html` in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`; images only from allowed URL schemes; unknown block → `fallbackText`. `actions` buttons send `ui.action`.
- Session storage in `localStorage` (token, nodeId) through the storage port of `@keith/client`.
- Tests: component tests for every block renderer (happy-dom or Bun's DOM testing per current docs) and the app state against `@keith/client`'s fake core. A build test that produces `dist/index.html`.

**Out:** Playwright e2e (P2-I1). Workspace (phase 6).

## Acceptance criteria

- [ ] Every standard block type renders; `html` iframe has exactly `sandbox="allow-scripts"`.
- [ ] Imports only `@keith/client`, `@keith/protocol` and UI libraries (check-deps).
- [ ] `bun run --cwd plugins/web build` produces `dist/` that the P2-B1 plugin serves.
- [ ] ADR-0012 written as proposed.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
