---
id: P3-H2
title: "Hardening: server fixes (welcome close, chat.text@1, notice, RATE_LIMITED)"
phase: 3
wave: 6
lane: H
status: in-progress
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

- [ ] Tests for each item (failing before).
- [ ] Existing server tests pass; `chat.text@1` nodes see no change.
- [ ] `bun run check` passes.

## Outcome

_Filled by the agent when finishing._
