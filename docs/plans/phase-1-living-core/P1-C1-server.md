---
id: P1-C1
title: Server, auth, node handshake, presence
phase: 1
wave: 1
lane: C
status: in-progress
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

- [ ] HTTP tests for each endpoint, including 401 paths.
- [ ] WS tests with a real socket: bad token → 4003, no hello → 4001, valid flow → `welcome` then `thread.opened` (ThreadManager faked).
- [ ] Invalid frame → `error { code: INVALID_FRAME }` and the connection stays open.
- [ ] `person.arrived` fires only after the away threshold (fake clock), not on a quick reconnect, and fires with `awayMs: null` on a first-ever attach. Arrival survives a server restart (uses the persisted `last_seen_at`).
- [ ] `thread.opened` is sent exactly once per `thread.open`, built from the `OpenedThread` return value.
- [ ] Two nodes of one person attached to one thread: `attachedTo` returns both. Disconnecting one updates it.
- [ ] Plugin route under `/p/<name>/…` works. Registering under `/v1` throws `ROUTE_CONFLICT`.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
