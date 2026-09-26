---
id: P1-F1
title: TUI node
phase: 1
wave: 1
lane: F
status: review
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

- [x] Against the fake core: login, open thread, send, stream, and see the final message (test drives the TUI's state layer, not the terminal renderer).
- [x] An unsolicited `message.started { proactive: true }` renders while the user is typing, without losing the draft.
- [x] Reconnect after the fake core restarts restores the thread.
- [x] Token file created with mode 600.
- [x] Rendering logic is separated from protocol and state logic so it can be tested headless.
- [x] `bun run check` passes.

## Outcome

**Framework:** OpenTUI, proposed in [ADR-0010](../../decisions/0010-tui-framework.md) (`status: proposed`, the coordinator accepts it). The TUI uses `@opentui/core` through its imperative core API, so it needs no React or JSX. The TUI row in [stack.md](../../architecture/stack.md) is updated. Ink 7.1.1 and OpenTUI 0.5.12 docs were read on 2026-09-26 (URLs in the ADR). OpenTUI won on Bun support (Bun-first, prebuilt native core), its multi-line `TextareaRenderable` (Ink has no multi-line input), diffed rendering for streaming text, and a headless test renderer.

**Built (`apps/tui`):**

| File | What |
|---|---|
| `src/index.ts`, `src/main.ts` | `keith-tui [--url …]` entry (`bin` in `package.json`). Sign in or reuse the stored session, run the chat, and prompt for a new login when the core closes with 4003 |
| `src/api.ts` | `POST /v1/auth/login` with `LoginRequest`/`LoginResponse`/`HttpErrorBody`, the WS URL, and URL normalization |
| `src/config.ts` | `$XDG_CONFIG_HOME/keith/tui.json` (falls back to `~/.config`). It stores url, token, person, expiry and `nodeId`, is validated with zod, and is written atomically with mode 600 (dir 700) |
| `src/client.ts` | WS client: `hello { capabilities: ['chat.text@1'], nodeId? }`, `thread.open` (main thread, then the same thread id after a reconnect), `parseCoreFrame` on every frame, `ping` → `pong`, exponential backoff reconnect (500 ms → 15 s), `auth-required` on 4003, stop on 4009, `input.text` / `input.cancel` |
| `src/state.ts` | Pure reducer from core frames to `ChatState`: history, streaming deltas, completion, proactive mark, tool activity upserted per `toolCallId`, notices and errors, local echo of sent input |
| `src/view.ts` | Pure presentation: status line (person · thread · connection · `thinking…`/`speaking`), `Keith ▸` prefix for proactive messages, dim tool lines, notice/error lines |
| `src/ui.ts`, `src/login-screen.ts` | The only OpenTUI code. Chat screen: status bar, sticky-bottom scroll box, bordered textarea (Enter sends, Ctrl+J / Alt+Enter / Shift+Enter newline, Esc `input.cancel`, Ctrl+C quits), hint line. Login screen: username input, then a masked password |
| `test/fake-core.ts` | A fake core built on `@keith/protocol` schemas: `Bun.serve` on port 0 with login, WS hello/welcome, thread.open/opened, a streamed scripted reply (optional tool activity), `pushProactive`, `ping`, `revokeTokens`, `dropConnections`, `stop`/`restart` on the same port |

**Tests (49, all headless):** reducer and view units. Client against the fake core: login → open → send → stream → final, tool activity, S-2 proactive, nodeId persisted and resent, ping/pong, reconnect after the core restarts restores the thread, 4003 stops reconnecting, cancel, and send guards. OpenTUI test renderer: Enter sends and clears, Ctrl+J newline, a proactive message renders while typing and the draft stays (S-2, I-11), Esc cancel + Ctrl+C quit, the reconnecting status, and the masked login. Config: mode 600 on create and overwrite, with `XDG_CONFIG_HOME` set to a temp dir. A manual pty smoke run of the real binary against the fake core (login, send, streamed reply, proactive message, Ctrl+C, token file `-rw-------`) passed.

**Dependencies added (in `apps/tui` via `bun add`):** `@opentui/core` ^0.5.12 and `zod` ^4.6.5 (same major as `@keith/protocol`, for validating the session file).

**Deviations and notes:**
- R-11: apps can't import `KeithError` (R-1), so the TUI has its own `TuiError(code, message, { cause })`.
- The fake core doesn't await `server.stop(true)`. In Bun 1.3.11 that promise never settles once a WebSocket has closed, but the port is released at once. A comment explains it.
- The core never echoes a node's own input back (`message.user` is for other nodes), so the TUI shows sent text as a local entry. The history from `thread.opened` replaces it after a reconnect.
- Frames that fail to parse become a `warn` notice. Unknown frame types are ignored (forward compatibility). Nodes can't send `error` frames, so no reply is sent.
- Shift+Enter inserts a newline only in terminals that report it (kitty keyboard protocol). Ctrl+J works everywhere.

**Follow-ups:** `keith-tui --logout` (`POST /v1/auth/logout`) and scrolling back through older history (`GET /v1/threads/:id/messages?before=`) are not in scope.
