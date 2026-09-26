---
id: P2-D1
title: "Core: ui.action routing, MessageDto.ui in history, /v1/files"
phase: 2
wave: 2
lane: D
status: todo
owner: null
depends: [P2-K1]
owns:
  - packages/core/src/mind/**
  - packages/core/src/server/**
  - packages/core/src/storage/**
  - packages/core/drizzle/**
reads:
  - docs/architecture/ui.md
  - docs/contracts/protocol.md
  - docs/contracts/ui-blocks.md
  - docs/contracts/plugin-api.md
  - docs/architecture/storage.md
  - docs/architecture/core.md
updates:
  - docs/architecture/ui.md
  - docs/architecture/storage.md
scenarios: [S-8]
---

# P2-D1: Core UI actions, UI in history, files

## Goal

Everything the core owes a UI-capable node: blocks in history, clicks routed back to the tool that made them, and a files endpoint for images. Phase 1 already sends `ui.render` to nodes with `ui.render@1` and persists `ui` entries on assistant messages.

## Scope

**In:**
- `MessageDto.ui` filled from persisted `ui` entries in `thread.opened`, `message.completed` and `GET /v1/threads/:id/messages`.
- `ui.action` frames: the server replaces its phase-1 `UNKNOWN_FRAME` reply with a call to `ThreadManager.action(...)` (interface from P2-K1). The Mind finds the block in the message's persisted `ui` entries, then calls that tool's `onAction` (result handled as P2-K1 defined in plugin-api.md), or, without `onAction`, runs the input "(clicked: <label>)" in the Thread (ui.md "Interactivity"). Unknown message/block/action → `error { NOT_FOUND }`. Tier checks apply.
- `/v1/files`: `POST` (multipart, size limit from config or a constant, recorded), `GET /v1/files/:id` with the stored mime; files live in `KEITH_HOME/files/`; `files` table + `FilesRepository` (drizzle-kit generated migration). Only the owner person or participants of a thread that references the file may read it (document the rule in storage.md).
- Tests: history with ui, action → onAction, action → clicked input, files upload/download/auth, UI block limits enforced.

**Out:** web app, client library, weather plugin.

## Acceptance criteria

- [ ] I-9: the core validates blocks and never needs to know which client renders them.
- [ ] `ui.action` on a block whose tool has `onAction` calls it exactly once with a `ToolRunContext` for the clicking person.
- [ ] A block without `onAction` produces a user turn with "(clicked: <label>)".
- [ ] Files: 401 without token, 404 for a file the person can't see, round trip of bytes and mime.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
