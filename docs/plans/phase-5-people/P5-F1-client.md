---
id: P5-F1
title: "@keith/client: thread list, switching threads, authors, relay marks, invite sign-up"
phase: 5
wave: 2
lane: F
status: todo
owner: null
depends: [P5-K1]
owns:
  - packages/client/**
reads:
  - docs/plans/phase-5-people/README.md
  - docs/contracts/protocol.md
  - docs/architecture/repository.md
  - docs/architecture/nodes.md
updates:
  - docs/architecture/repository.md
scenarios: [S-5, S-6]
---

# P5-F1: Client library for phase 5

## Goal

Every TypeScript node can show several threads: a live list of the person's threads (groups included), switching between them, who wrote each message, who a relay came from, and sign-up through an invite link. The TUI (P5-F3) and the web app (P5-F2) build on this in wave 3.

## Scope

**In** (`packages/client`, `@keith/protocol` imports only):
- `http.ts`: `acceptInvite(baseUrl, { code, username, password }, { fetch? })` → `LoginResponse`. Map the errors to `ClientError`: `401` → `INVITE_INVALID` (a new code), `400` → `INVALID_REQUEST` with the core's message.
- `session.ts`: `createAuth(...).acceptInvite(...)` stores the session like `login`.
- `chat.ts`:
  - `openThread(threadId)`: `thread.close` for the open thread, then `thread.open` for the new one. A reconnect reopens the thread that was open last.
  - `onThreads` / state: the thread list, loaded with `listThreads` on connect and kept current by `thread.updated` and `thread.removed`.
  - When `thread.removed` names the open thread, the client opens the person's main thread.
- `state.ts`:
  - A `threads: ThreadDto[]` list (most recently updated first) with reducer cases for `thread.updated` and `thread.removed`, replacing P5-K1's placeholder.
  - `authorName(state, message)`: the participant's name, else a former participant's, else `null` for the Mind. Unknown ids give `Someone`.
  - `relayFrom(message)`: the `meta.relayFrom` names.
  - Frames for other threads are still ignored, apart from these two.
- `labels.ts`: `threadLabel(thread, me)` ("Mission · Tony, Pepper, Rhodey"; a direct thread is "Main").
- `@keith/client/testing`: `startFakeCore` supports `POST /v1/auth/invite`, group threads in `GET /v1/threads` and `thread.open`, and a helper to push `thread.updated` / `thread.removed`.
- repository.md: the client module table.

**Out:** rendering (P5-F2 web, P5-F3 TUI), unread counters (not in v1, D11).

## Acceptance criteria

- [ ] `state.test.ts`: `thread.updated` adds or replaces a thread and keeps the order. `thread.removed` drops it. `authorName` resolves current and former participants and the Mind.
- [ ] `chat.test.ts` (fake core): `openThread` sends `thread.close` then `thread.open`. A reconnect reopens the last thread. `thread.removed` of the open thread switches to main.
- [ ] `http.test.ts`: `acceptInvite` returns the session, and a `401` becomes `INVITE_INVALID`.
- [ ] The no-`bun:*`/`node:*` import test still passes.
- [ ] `bun run check` passes.

## Notes

- One open thread per chat client stays the model (the TUI and web show one conversation at a time). The list is what's new.

## Outcome

_Filled by the agent when finishing: what was built, decisions (ADR links), deviations, follow-ups._
