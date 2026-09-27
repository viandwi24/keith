---
id: P3-H2
title: "Hardening: server fixes (welcome close, chat.text@1, notice, RATE_LIMITED)"
phase: 3
wave: 6
lane: H
status: review
owner: agent-P3-H2
depends: [P3-K2]
owns:
  - packages/core/src/server/**
reads:
  - docs/plans/phase-3-voice/hardening-audit.md
  - docs/contracts/protocol.md
  - docs/architecture/nodes.md
updates:
  - docs/architecture/nodes.md
scenarios: []
---

# P3-H2: Hardening: server fixes (welcome close, chat.text@1, notice, RATE_LIMITED)

## Goal

Fix B7 and the server side of C1–C3 from [hardening-audit.md](hardening-audit.md).

## Scope

**In:**
- B7: if the `welcome` frame can't be built or sent, close the socket (use an existing close code; document which).
- C3: `input.text` from a node without `chat.text@1` → `error { FORBIDDEN }`; `AttachmentRegistry.send` doesn't deliver `message.*` / `tool.activity` frames to such nodes.
- C1: send `notice` as protocol.md now defines: failed plugins to owner nodes on `welcome`; the voice-off `info` to nodes declaring `audio.in@1` without `[voice]`. The server takes what it needs as optional deps (e.g. `pluginStatus?: () => PluginStatus[]`, `voiceConfigured?: boolean`); P3-I3 wires them.
- C2: `RATE_LIMITED` passes through to the node like `PROVIDER_ERROR` (not `INTERNAL`).
- B5 (server side): pass `thread.open.historyLimit` through to `ThreadManager.open` instead of slicing in `connection.ts` (P3-K2 note). Remove the nodes.md `> Planned (phase 3, task P3-H2)` note once done.

**Out:** anything not listed; items owned by another hardening task.

## Acceptance criteria

- [x] Tests for each item (failing before).
- [x] Existing server tests pass; `chat.text@1` nodes see no change.
- [x] `bun run check` passes.

## Outcome

**Built** (all in `packages/core/src/server/`)
- **B7** (`connection.ts`): the `welcome` frame is built, validated with `CoreFrame` and written straight to the socket *before* the node counts as ready. If validation or the send fails, the handshake's catch closes the socket with **`1011`** (the standard WebSocket "internal error" code, already used for other handshake failures; no new protocol close code). No `node.connected` / `node.disconnected` is emitted for such a node.
- **C3**: `input.text` from a node without `chat.text@1` → `error { FORBIDDEN }` (checked before the thread-open check). `ServerAttachmentRegistry.connect(nodeId, outlet, capabilities)` now takes the `hello` capabilities; `send` drops `message.user`, `message.started`, `message.delta`, `message.completed` and `tool.activity` for a node without `chat.text@1`. Other frames are unchanged.
- **C1**: right after `welcome`, an owner node gets one `warn` notice per plugin in state `failed` (`plugin <id> failed: <error.message>`), then a node that declared `audio.in@1` gets `info` `voice is not configured on this Keith` when voice isn't configured. New optional deps on `CoreServerDeps` / `ConnectionDeps`: `pluginStatus?: () => PluginStatus[]` and `voiceConfigured?: boolean` (default: `voice !== undefined`). P3-I3 wires them in bootstrap.
- **C2**: `RATE_LIMITED` is in the pass-through set (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL`) for errors thrown by `ThreadManager.input` / `action` / `open`.
- **B5**: `thread.open` passes `historyLimit` to `ThreadManager.open`; the server's slice stays as a guard.
- Tests: new `delivery-rules.test.ts` (B7, C3 x2, C1 x3, C2, B5) and one registry test in `attachments.test.ts`. All 7 item tests failed against the old code. `test-fakes.ts`: `pluginStatus` / `voiceConfigured` options, `calls.open` typed from `ThreadManager['open']`.
- Docs: nodes.md connection table (notices, `1011` on a failed welcome, `historyLimit` pass-through, `chat.text@1` refusal), pass-through code list, registry filtering; the `> Planned (phase 3, task P3-H2)` note is removed.

**Decisions**
- A missing `voiceConfigured` falls back to whether a `VoiceInput` was passed, so today's bootstrap (voice only with `[voice]`) already behaves correctly before P3-I3 wires the flag.

**Deviations / notes**
- `KeithErrorCode` (`packages/sdk/src/errors.ts`) has no `RATE_LIMITED`, so a `KeithError('RATE_LIMITED')` can't be typed today. The server compares codes as strings, so it passes through whatever H1 raises; the test casts. P3-H1 (which raises it) needs `RATE_LIMITED` added to `KEITH_ERROR_CODES` in `@keith/sdk`, which no H task owns: the coordinator should check this for H1/I3.
- Turn errors sent by the mind itself (`thread-manager.ts`, via the registry) are H1's side of C2; this task covers only thrown errors on the server path.

