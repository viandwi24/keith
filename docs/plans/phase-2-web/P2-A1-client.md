---
id: P2-A1
title: Extract @keith/client and migrate the TUI
phase: 2
wave: 2
lane: A
status: todo
owner: null
depends: [P2-K1]
owns:
  - packages/client/**
  - apps/tui/**
reads:
  - docs/architecture/repository.md
  - docs/contracts/protocol.md
  - docs/architecture/nodes.md
  - docs/decisions/0010-tui-framework.md
updates:
  - docs/architecture/repository.md
scenarios: [S-8]
---

# P2-A1: Extract @keith/client and migrate the TUI

## Goal

One protocol client library used by every TS node: the TUI now, the web browser app in wave 3 (the second consumer that justifies the package, R-6).

## Scope

**In:**
- New package `@keith/client` (`bun init` in `packages/client`, R-18), depending only on `@keith/protocol` (and nothing Bun-specific: it must run in browsers too; use `fetch` and the standard `WebSocket`).
- Move the TUI's protocol, connection and state logic (`apps/tui/src/{api,client,state,view}.ts`, the pieces that aren't terminal rendering or config-file storage) into `@keith/client`: login/logout/me/threads/messages HTTP calls, WS connection with `hello`, heartbeat replies, reconnect with backoff, `thread.open`, streaming state, proactive messages, `ui.render` blocks and `ui.action` sending. Storage of the token and nodeId is injected (the TUI keeps its `tui.json`, the browser will use `localStorage`).
- The TUI depends on `@keith/client` and keeps only terminal rendering, config storage and CLI args. All existing TUI tests pass (moved where they belong).
- `packages/client/test/fake-core.ts`: the fake core moves here so both consumers can use it.

**Out:** the web app (P2-C1). New protocol features.

## Acceptance criteria

- [ ] `@keith/client` has no dependency but `@keith/protocol`, and imports no `bun:*` / `node:*` module (test).
- [ ] The client tests cover login, open, send, stream, proactive message during typing, reconnect restoring the thread, 4003 → re-login, `ui.render` block state, and `ui.action` send.
- [ ] The TUI works as before (its tests pass against the shared fake core).
- [ ] `bun run check` passes.

## Outcome

_To be filled._
