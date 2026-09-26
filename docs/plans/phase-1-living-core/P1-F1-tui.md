---
id: P1-F1
title: TUI node
phase: 1
wave: 1
lane: F
status: in-progress
owner: agent-P1-F1
depends: [P0-04]
owns:
  - apps/tui/**
  - docs/decisions/0010-tui-framework.md
reads:
  - docs/architecture/nodes.md
  - docs/contracts/protocol.md
  - docs/concept/model.md
  - docs/architecture/stack.md
updates:
  - docs/architecture/stack.md
scenarios: [S-2]
---

# P1-F1: TUI node

## Goal

A terminal client that is a pleasure to talk to Keith through: streaming replies, visible turn state, tool activity, and unsolicited messages from the Mind.

## Scope

**In:**
- **Decide the framework** (Ink or OpenTUI) after reading both projects' current docs. Criteria: Bun compatibility, smooth streaming text, input editing, maintenance activity. Write `docs/decisions/0010-tui-framework.md` (`status: proposed`, the coordinator accepts it) and update the TUI row in `stack.md` in the same PR. (This task may create that ADR file and edit that one row.)
- `keith-tui [--url http://127.0.0.1:4824]`: login screen (username, password) → `POST /v1/auth/login` → store token and `nodeId` in `$XDG_CONFIG_HOME/keith/tui.json` (file mode 600).
- WS connection with `hello { capabilities: ['chat.text@1'] }`, `thread.open` for the main thread, history rendering, reconnect with backoff, and a re-login prompt on 4003.
- Conversation view: user and assistant messages, live streaming deltas, a turn state indicator (`thinking…`, `speaking`), `tool.activity` lines (dim), `proactive` messages visibly marked (e.g. "Keith ▸" prefix), `notice` and `error` rendering.
- Input: multi-line editing, Enter sends, Esc sends `input.cancel`, Ctrl+C quits.
- Protocol handling only through `@keith/protocol` parsers. The TUI imports nothing else from the workspace (R-1).
- `apps/tui/test/fake-core.ts`: a tiny WS + HTTP fake core built on protocol schemas, used by tests.

**Out:**
- UI block rendering (the TUI doesn't declare `ui.render@1`). Voice. Multiple threads UI.

## Acceptance criteria

- [ ] Against the fake core: login, open thread, send, stream, and see the final message (test drives the TUI's state layer, not the terminal renderer).
- [ ] An unsolicited `message.started { proactive: true }` renders while the user is typing, without losing the draft.
- [ ] Reconnect after the fake core restarts restores the thread.
- [ ] Token file created with mode 600.
- [ ] Rendering logic is separated from protocol and state logic so it can be tested headless.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
