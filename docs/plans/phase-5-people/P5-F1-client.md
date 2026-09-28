---
id: P5-F1
title: "@keith/client: thread list, switching threads, authors, relay marks, invite sign-up"
phase: 5
wave: 2
lane: F
status: done
owner: agent-P5-F1
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

- [x] `state.test.ts`: `thread.updated` adds or replaces a thread and keeps the order. `thread.removed` drops it. `authorName` resolves current and former participants and the Mind.
- [x] `chat.test.ts` (fake core): `openThread` sends `thread.close` then `thread.open`. A reconnect reopens the last thread. `thread.removed` of the open thread switches to main.
- [x] `http.test.ts`: `acceptInvite` returns the session, and a `401` becomes `INVITE_INVALID`.
- [x] The no-`bun:*`/`node:*` import test still passes.
- [x] `bun run check` passes.

## Notes

- One open thread per chat client stays the model (the TUI and web show one conversation at a time). The list is what's new.

## Outcome

**Built** (`packages/client`, imports `@keith/protocol` only; the boundary test still passes):
- `http.ts`: `acceptInvite(baseUrl, { code, username, password }, { fetch?, signal? })` → `LoginResponse`. `401` → `ClientError('INVITE_INVALID', INVITE_INVALID_MESSAGE)` ("This invite link is not valid any more. Ask the owner for a new one.", the sentence P5-F2 and P5-F3 show), `400` → `INVALID_REQUEST` with the core's message, anything else → `HTTP_ERROR`. `errors.ts` has the two new codes.
- `session.ts`: `Auth.acceptInvite(body, { signal? })` stores the session like `login` (shared `started` helper, keeps a known `nodeId`).
- `state.ts`:
  - `ChatState.threads` (most recently updated first, ties by id). `thread.opened` and `thread.updated` upsert, `thread.removed` drops. `thread.updated` of the open thread also refreshes `state.thread` (participants) and keeps the conversation and turn state. `thread.removed` of the open thread clears the conversation (`thread: null`).
  - New local actions `threads` (the `GET /v1/threads` list) and `thread.closed` (switching).
  - `MessageEntry.authorPersonId?` and `relayFrom?` (optional, so entry literals in the TUI and web tests still compile). Local echoes carry the signed-in person's id.
  - `authorName(state, message)` (entry or `MessageDto`): participants, then former participants, then the signed-in person; `null` for the Mind; `UNKNOWN_AUTHOR` (`Someone`) for an unknown id. `relayFrom(message)` (entry or DTO) → sender names.
- `labels.ts`: `threadLabel(thread, me)` and `MAIN_THREAD_LABEL`.
- `chat.ts`:
  - `openThread(threadId)` → `{ ok } | { ok: false, reason: 'invalid' | 'offline' }`: `thread.close` for the open (or pending) thread, then `thread.open`, and the conversation is cleared until `thread.opened`. A reconnect reopens the thread opened last.
  - `onThreads(threads)` dep; `GET /v1/threads` after every `welcome` (a failure is a `warn` notice).
  - `thread.removed` of the open thread: opens main (`thread.open` without id) and, once it is open, adds the info notice "You are no longer in <title>." (what P5-F3 asks for).
  - Robustness: a late `thread.opened` for a thread the node switched away from is closed again; an `error` whose `re` is the pending `thread.open` of a non-main thread (e.g. the person left while offline, then reconnected) falls back to main.
  - Switching threads ends this node's microphone streams (`audio.end`) and sends `onAudio({ type: 'flush', reason: 'thread' })`; `AudioEvent`'s flush reason is now `'input' | 'thread'`.
- `@keith/client/testing`: `startFakeCore` keeps a thread list (`threads`, `messagesOf`, `openThreads()`), `addGroup({ title, purpose, others, formerParticipants, messages, updatedAt })`, `pushThreadUpdated`, `pushThreadRemoved` (also detaches sockets), per-socket open thread with `thread.close`, input and replies in any open thread, `thread.open` of an unlisted thread → `error { FORBIDDEN }` with `re`, `pushProactive(text, { threadId, relayFrom })`, and `POST /v1/auth/invite` (`FAKE_INVITE_CODE` or `inviteCode`, single use, `takenUsernames` → 400, sets `credentials` and ends old tokens). `core.thread` / `core.messages` are still the main thread, so the TUI and web tests are unchanged.
- Tests: `state.test.ts` (10 new), `chat.test.ts` (8 new, fake core), `http.test.ts` (5 new), `session.test.ts` (2 new), `labels.test.ts` (2 new). The P5-K1 placeholder test is replaced.
- repository.md: the client module table and the testing line.

**Decisions**
- `threadLabel` leaves `me` out of the participant names (that is what the `me` parameter is for): Tony sees "Mission · Pepper, Rhodey", Happy sees "Mission · Tony, Pepper, Rhodey" (the task's example). A group with nobody else is just its title.
- The loaded list replaces `state.threads` (no merge). A `thread.updated` that arrives while the `GET /v1/threads` of the same connect is in flight can be overwritten by the older list until the next update; accepted for v1 (membership changes are rare).
- `openThread` while offline is refused rather than queued; the apps can retry after `online`.

**Deviations:** none. No doc marker `> Planned (phase 5, P5-F1)` existed to remove. No ADR.

**Notes for other lanes**
- **P5-F2 / P5-F3:** use `state.threads` (or `onThreads`) for the list, `threadLabel(thread, state.person)` for names, `client.openThread(id)`, `authorName(state, entry)` for group authors (null = Keith), `relayFrom(entry)` for "via Pepper", and `auth.acceptInvite({ code, username, password })`; show `error.message` for `INVITE_INVALID`. P5-F2 wants "Main" first: `state.threads` is purely by recency, so sort the direct thread first in the web app. The fallback notice after `thread.removed` comes from the client, so P5-F3 needs no own notice. Fake core: `core.addGroup(...)`, `core.pushThreadRemoved(id)`, `FAKE_INVITE_CODE`.
- **P5-N1 / P5-I1:** the client relies on the core answering a refused `thread.open` with an `error` frame whose `re` is the `thread.open` id (as the fake does), to fall back to main after a reconnect.
