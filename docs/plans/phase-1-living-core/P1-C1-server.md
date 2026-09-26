---
id: P1-C1
title: Server, auth, node handshake, presence
phase: 1
wave: 1
lane: C
status: done
owner: agent-P1-C1
depends: [P0-04]
owns:
  - packages/core/src/server/**
reads:
  - docs/architecture/nodes.md
  - docs/contracts/protocol.md
  - docs/contracts/plugin-api.md
  - docs/architecture/core.md
updates:
  - docs/architecture/nodes.md
scenarios: [S-1, S-4]
---

# P1-C1: Server, auth, node handshake, presence

## Goal

Nodes can log in, connect over WebSocket, open threads, send input and receive frames, all through the public `/v1` protocol on one port.

## Scope

**In:**
- `Bun.serve` on `server.host:port` with HTTP routing for every phase-1 endpoint in protocol.md, plus the WS upgrade at `/v1/ws`.
- Auth: login (verify with `Bun.password`), opaque token generation, SHA-256 hashing, expiry, logout, and a bearer middleware. Uses the storage repository interfaces.
- WS: token check on upgrade (close 4003), `hello` timeout (4001), protocol version check on `hello.protocol` and envelope `v` (4009), heartbeat (4010), `welcome` with a persisted or new `nodeId`, and fill `auth_tokens.node_id` on `hello`.
- Frame routing: parse every incoming frame with `@keith/protocol`, then dispatch `thread.open/close`, `input.text`, `input.cancel` to the `ThreadManager` interface. On `thread.open`, the server computes `arrival`, calls `ThreadManager.open`, and **sends the `thread.opened` frame itself** from the returned `OpenedThread`. Reply `error` frames for invalid or unknown frames.
- `AttachmentRegistry` implementation (constructed standalone so bootstrap can hand it to both the mind and the server): which node has which thread open, `send(nodeId, frame)`, `attachedTo(threadId)`.
- `Presence` implementation: present or away per person, and `lastSeenAt` persisted to `persons.last_seen_at` when a person becomes away, refreshed on `scheduler.ticked` while present, and flushed for all present persons by a `flushPresence()` method that bootstrap calls on shutdown. Arrival per core.md (threshold, or first-ever attach with `awayMs: null`). Emits `node.connected`/`node.disconnected`, `person.arrived`, `person.left`.
- `HttpRegistry` and `WsRegistry` implementations for plugins (mount rules and reserved paths per plugin-api.md), handed to the plugin host by bootstrap.
- Serve `GET /v1/health` without auth.

**Out:**
- Thread logic, history loading (ThreadManager, E1). CLI (I1). Audio frames (phase 3).

## Acceptance criteria

- [x] HTTP tests for each endpoint, including 401 paths.
- [x] WS tests with a real socket: bad token → 4003, no hello → 4001, valid flow → `welcome` then `thread.opened` (ThreadManager faked).
- [x] Invalid frame → `error { code: INVALID_FRAME }` and the connection stays open.
- [x] `person.arrived` fires only after the away threshold (fake clock), not on a quick reconnect, and fires with `awayMs: null` on a first-ever attach. Arrival survives a server restart (uses the persisted `last_seen_at`).
- [x] `thread.opened` is sent exactly once per `thread.open`, built from the `OpenedThread` return value.
- [x] Two nodes of one person attached to one thread: `attachedTo` returns both. Disconnecting one updates it.
- [x] Plugin route under `/p/<name>/…` works. Registering under `/v1` throws `ROUTE_CONFLICT`.
- [x] `bun run check` passes.

## Outcome

**Built** (`packages/core/src/server/`):

- `attachments.ts`: `createAttachmentRegistry({ log })` → `ServerAttachmentRegistry` (the frozen `AttachmentRegistry` plus `connect/disconnect/isConnected/threadsOf` for the server). `attachedTo` lists nodes in attach order (most recent last, for focus fallback). `send` validates outgoing frames with `CoreFrame` (R-9) and drops and logs an invalid one.
- `presence.ts`: `createPresence({ config, clock, log, events, persons })` → `ServerPresence` (frozen `Presence` plus server hooks). Arrival = first attach while not present, with `awayMs ≥ awayAfterMinutes × 60 000` or `last_seen_at` null (`awayMs: null`). Writes `last_seen_at` when a person becomes away, on every `scheduler.ticked` while present, and in `flushPresence()`. Emits `person.arrived` (after `ThreadManager.open` succeeds) and `person.left`. `dispose()` unsubscribes from ticks.
- `auth.ts`: login with `Bun.password.verify` (one dummy verify for an unknown username), 32-byte base64url tokens, SHA-256 hex hashes via `Bun.CryptoHasher`, expiry from `auth.tokenTtlDays`, expired tokens deleted on use, logout.
- `http-api.ts`: every phase-1 `/v1` endpoint, `{ error: { code, message } }` bodies, `400 INVALID_REQUEST` for bad JSON/body/query, `401` without a valid bearer, `404` for unknown `/v1` routes and for threads the caller is not in. `tool` messages are filtered out (`roles: ['user', 'assistant']`).
- `connection.ts`: the per-socket state machine (4003/4001/4009/4010, hello, welcome, node-id choice, frame routing, error frames, plugin frames). Timers are injectable (`timing`) so tests use short real timers.
- `plugin-routes.ts`: `HttpRegistry`/`WsRegistry` as `PluginScoped` views. Routes mount at `/p/<namespace><path>` with `:param` segments and `auth` defaulting to `bearer`. `/v1…` or another plugin's `/p/…` throws `ROUTE_CONFLICT`, and so does a duplicate route, static mount or ws type. `static('/')` is `client-app` only (`PLUGIN_KIND_VIOLATION`) and single-owner. Static serving has an SPA fallback and blocks path traversal. WS types must start with `<namespace>.` (`PLUGIN_NAMESPACE_INVALID`).
- `server.ts`: `createCoreServer(deps)` → `CoreServer` on one `Bun.serve` port. `/v1/*` always goes to the core, then plugin routes, then statics. `listen()` returns the bound host and port, so tests use `port: 0`.
- `index.ts` exports the three factories and their deps types. `test-fakes.ts` holds in-memory fakes of the storage, event bus and ThreadManager interfaces plus a real-socket test harness.

**Tests:** 56 tests in `attachments`, `presence`, `http`, `ws` and `plugin-routes` `.test.ts`. They use real sockets on OS-chosen ports and a fake clock for presence and token expiry. `bun run check` is green (357 tests).

**Decisions and deviations:**
- `ThreadManager.open` has no `historyLimit` parameter, so the server trims `OpenedThread.messages` to the last `historyLimit` (default 50). If the mind returns fewer messages than asked for, the node gets fewer. Follow-up for integration: either the mind always returns up to 200, or `open` gets a `historyLimit` (a `mind/types.ts` change).
- Who attaches: the server calls `attachments.attach` after `ThreadManager.open` resolves (the thread id isn't known before that for the main thread), then sends `thread.opened` in the same tick. Frames the mind sends to that thread *during* `open` (for example the start of a delivery turn kicked off synchronously) won't reach the opening node. The mind should start any turn from `open` asynchronously (a scheduler job), which it does by design. The integration task should check this.
- Node ids: a `hello.nodeId` is reused only if the `nodes` row exists and no live socket has it. Otherwise the token's node id is tried, then a new id is issued. This keeps two sockets from ever sharing a node id.
- `input.text`/`input.cancel` for a thread the node hasn't opened → `error { FORBIDDEN }`. `ui.action` → `UNKNOWN_FRAME` until phase 2. Binary frames → `INVALID_FRAME` until phase 3.
- Server frame ids are a per-server counter (`c1`, `c2`, …), unique per connection as the protocol requires. Node ids come from the injected `ids`.
- The kind table (which kinds may use `http`/`ws` at all) is left to the plugin host, as plugin-system.md says. The server only applies the kind rule for `static('/')`.
- Bun 1.3.11 quirk: the promise returned by `server.stop()` never settles once a WebSocket has been open. `stop()` therefore calls `server.stop(true)` without awaiting it, then waits for every connection's cleanup.
- No new dependencies. Protocol schemas come from `@keith/protocol` and no direct `zod` import is needed.

**Docs:** `docs/architecture/nodes.md` gains a "How the core handles a connection" table and auth details.

**For P1-I1 (bootstrap):** construct `createAttachmentRegistry` and `createPresence` at step 4, `createCoreServer({ config, log, clock, ids, events, repos, threads, attachments, presence, version })` at step 9, pass `server.http`/`server.ws` to the plugin host, and call `listen()` at step 12. On shutdown, call `presence.flushPresence()`, then `server.stop()`, then `presence.dispose()`.
