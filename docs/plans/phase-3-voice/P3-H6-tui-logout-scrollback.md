---
id: P3-H6
title: "Hardening: TUI --logout and history scrollback"
phase: 3
wave: 6
lane: H
status: review
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

- [x] Tests for logout (token file removed, endpoint called) and for loading an older page into the view.
- [x] `bun run check` passes.

## Outcome

**Built (`apps/tui` only).** The HTTP calls and the paging state already existed in `@keith/client` (`logout`, `ChatClient.loadOlder`, `history.hasMore/loading`, P2-A1), so this task only wires them into the TUI.

| File | What |
|---|---|
| `src/logout.ts` | `logoutCommand(store)`: loads `tui.json`, `POST /v1/auth/logout` with the stored bearer token on the core that issued it, deletes the file, prints `signed out of <url>`, returns 0. An unreachable core prints a warning and still deletes the local token; an already dead token (`UNAUTHORIZED`) is silent; no session prints `not signed in` |
| `src/main.ts` | `--logout` flag (in `USAGE`), handled before any renderer is created. `--url` is ignored with `--logout` (the token belongs to its stored core). Chat wires `loadOlder` to `client.loadOlder()` |
| `src/ui.ts` | A history line at the top of the log (`↑ older messages: PgUp or scroll up` / `loading…` / `· start of the conversation ·`). Reaching the top of a scrollable log (mouse wheel, or PgUp) calls `loadOlder` while `hasMore` and not loading; PgUp when already at the top (or when the log fits the view) asks too. PgUp/PgDn scroll half a view. A prepended page is inserted above the existing lines (no rebuild), and the distance from the scroll position to the bottom is restored on the content's next `resize`, so the lines on screen stay put. `ChatScreen.log` is exposed for tests |
| `src/view.ts` | `historyLine(state)` and its three texts |

**Tests (+9, 31 in the TUI):** `logout.test.ts` against the fake core: `main(['--logout', …])` exits 0, removes the token file and the token is revoked (`GET /v1/me` → `UNAUTHORIZED`); a fetch spy sees exactly one `POST /v1/auth/logout` with `Bearer <token>`; unreachable core; revoked token; no session. `ui.test.ts`: PgUp to the top of a 60-message thread (first page 20) prepends the older page with `history 41` kept on the same screen row and `history 40` just above it; mouse-wheel scrolling loads pages until `hasMore` is false, then shows the start line and PgUp asks for nothing more. `view.test.ts`: history line states. `main.test.ts`: `--logout` parsing.

**Notes:**
- The mock keyboard of `@opentui/core/testing` has no named PgUp outside kitty mode, so the test sends the raw `ESC [5~` sequence.
- No doc describes the TUI's flags or keys (the task has no `updates:`), so no doc changed. The hint line now lists `PgUp/PgDn scroll`.
