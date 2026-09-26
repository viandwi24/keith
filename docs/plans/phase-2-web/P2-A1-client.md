---
id: P2-A1
title: Extract @keith/client and migrate the TUI
phase: 2
wave: 2
lane: A
status: review
owner: agent-P2-A1
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

- [x] `@keith/client` has no dependency but `@keith/protocol`, and imports no `bun:*` / `node:*` module (test).
- [x] The client tests cover login, open, send, stream, proactive message during typing, reconnect restoring the thread, 4003 → re-login, `ui.render` block state, and `ui.action` send.
- [x] The TUI works as before (its tests pass against the shared fake core).
- [x] `bun run check` passes.

## Outcome

**Built: `packages/client` (`@keith/client`)**, created with `bun init` (generated README, CLAUDE.md, .gitignore, index.ts and the nested `node_modules` removed; `package.json` renamed, `exports` `.` and `./testing`; `tsconfig.json` extends the base like `@keith/protocol`). Its only dependency is `@keith/protocol`: HTTP bodies are validated with the protocol's zod schemas through a structural `safeParse` type, so the package needs no zod of its own.

| Module | Public API |
|---|---|
| `http.ts` | `normalizeBaseUrl`, `wsUrl`, `login`, `logout`, `getMe`, `listThreads`, `listMessages(baseUrl, token, threadId, { before, limit })`. Injectable `fetch` and `signal`. `ClientError { code }`: `LOGIN_FAILED`, `UNAUTHORIZED` (401 → sign in again), `NOT_FOUND`, `HTTP_ERROR`, `NETWORK`, `INVALID_RESPONSE`, `INVALID_URL`, `ABORTED` |
| `session.ts` | `StoredSession`, `SessionStore` (sync or async `load`/`save`/`clear`, injected), `parseStoredSession` (no zod), `memorySessionStore`, `webStorageSessionStore(localStorage, key = 'keith.session')`, `createAuth({ baseUrl, store })` → `restore()` (same core, not expired), `login(creds)` (saves, keeps the known nodeId), `logout()` (best-effort `POST /v1/auth/logout`, then clears), `rememberNodeId(id)`, `expire()` (after 4003: forget the token, keep the nodeId) |
| `chat.ts` | `createChatClient(deps)`: everything the TUI's `client.ts` did (hello, main-thread open and reopen by id, ping/pong, backoff reconnect, 4003 → `auth-required`, 4009 → closed, `send`, `cancel`) plus `capabilities` (default `['chat.text@1']`, the web app adds `ui.render@1`), `sendUiAction({ messageId, blockId, actionId, value? })` (validated ids, `invalid`/`offline` results), `loadOlder()` (pages `GET /v1/threads/:id/messages?before=` and prepends; `busy`/`no-more`/`failed` results), `reconnect(token?)` (re-login after 4003 keeping state and thread, or "retry now") |
| `state.ts` | `ChatState` + pure `applyFrame`/`applyLocal`. New: `MessageEntry.ui: { block, fallbackText }[]` (from `ui.render` by block id, replaced in place, kept through `message.completed` unless the DTO carries `ui`; history DTOs' `ui` get `uiBlockToText` fallback), floating `UiEntry` for `ui.render` without `messageId`, `history { hasMore, loading }`, `oldestMessageId` |
| `labels.ts` | `turnLabel`, `connectionLabel` (moved from the TUI's `view.ts`) |
| `test/fake-core.ts` (`@keith/client/testing`) | Moved from `apps/tui/test/`. Added: `logout`/`me`/`threads`/`messages` (paging) endpoints with bearer auth, per-socket capabilities, `pushUi` and `replyUi` (`ui.render` only to `ui.render@1` sockets, block kept on the final message), `history` seeding. `waitUntil` exported alongside |

**TUI (`apps/tui`):** `api.ts`, `client.ts`, `state.ts` are gone. It keeps `main.ts` (CLI args, login loop, now on `createAuth` + `createChatClient`), `config.ts` (the `tui.json` file, now also a `fileSessionStore(path)` `SessionStore`, validated with `parseStoredSession`), `view.ts` (terminal segments; floating UI entries show their fallback text), `ui.ts`, `login-screen.ts`, `errors.ts` (`TuiError` now only `INVALID_ARGS`/`CONFIG_INVALID`). `zod` was removed from the TUI (`bun remove zod`); it depends on `@keith/client` (`workspace:*`). An invalid `--url` now prints the error and exits 2 instead of throwing.

**Tests:** client 62 (http 13, session 9, state 16, chat 20 incl. login/open/send/stream, proactive during a streamed reply, reconnect restoring the thread, 4003 → re-login → `reconnect`, `ui.render` block state, no `ui.render` without the capability, `ui.action` send, history paging; labels 2; boundary 2: dependencies are exactly `@keith/protocol`, `src/` imports only `@keith/protocol` and relative files and uses no `Bun.`/`process.`). The TUI's reducer/client/api tests moved into the client; the TUI's own tests (view, OpenTUI screens, config, args) run against the shared fake core. Client + TUI tests ran 5× in a row green. A pty smoke run of the real `keith-tui` against the fake core (stored session → hello, thread.open, input.text, nodeId saved) passed.

**Deviations and notes:**
- Moved tests live next to the code in `packages/client/src/*.test.ts` (the repo's pattern); only the fake core and helpers are in `test/`.
- `createAuth.logout()` clears the whole stored session, including the `nodeId` (the store holds one flat `StoredSession`, same shape as the TUI's existing `tui.json`). After a logout the core issues a new node id on the next login. Acceptable for now; revisit if the web app needs stable ids across logouts.
- After a reconnect, `thread.opened` replaces the entries with the latest page, so pages loaded with `loadOlder` are dropped and `hasMore` is recomputed.
- `hasMore` after `thread.opened` is inferred from `messages.length >= historyLimit` (the frame has no `hasMore`); a `loadOlder` that returns nothing settles it.
- The TUI still starts a fresh client after 4003 (the login screen replaces the chat screen); `reconnect(token)` is there for the web app.
- `docs/architecture/nodes.md` needed no change.

**Follow-ups:** none required. `keith-tui --logout` can now be a few lines on `createAuth().logout()`.
