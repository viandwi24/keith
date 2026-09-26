---
id: P2-D1
title: "Core: ui.action routing, MessageDto.ui in history, /v1/files"
phase: 2
wave: 2
lane: D
status: done
owner: agent-P2-D1
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

- [x] I-9: the core validates blocks and never needs to know which client renders them.
- [x] `ui.action` on a block whose tool has `onAction` calls it exactly once with a `ToolRunContext` for the clicking person.
- [x] A block without `onAction` produces a user turn with "(clicked: <label>)".
- [x] Files: 401 without token, 404 for a file the person can't see, round trip of bytes and mime.
- [x] `bun run check` passes.

## Outcome

**Built**

- **UI in history:** already in place from phase 1. `MessageDto.ui` is filled by `mind/messages.ts` (`thread.opened`, `message.completed`) and `server/dto.ts` (`GET /v1/threads/:id/messages`). New tests cover `thread.opened` history; the HTTP test already covered the endpoint.
- **Block validation (I-9):** phase 1 did not validate tool blocks at all. An invalid block would have been stored and made later history reads throw `STORAGE_CORRUPT`. `mind/ui.ts` (`validUiBlock`, `idsFreeIn`, `findUiAction`) now does it. The run loop drops a block that fails the `UiBlock` schema or its limits (depth, 256 KB, URL schemes, ids in the tree), with a warning. The ThreadManager drops a block that reuses a block id already on the same message.
- **`ui.action`:** `server/connection.ts` sends the frame to `ThreadManager.action` (a thread not open on the node gets `FORBIDDEN`). It doesn't await the call, so a result waiting behind a running turn can't block `input.cancel`. Rejections become `error` frames with `re`, using the existing code mapping. `MindThreadManager.action` replaces the placeholder. It checks participation, finds the `actions` block at any depth in the message's `ui` entries (`NOT_FOUND` otherwise), checks the tier, calls `onAction` once with the tool's timeout, and appends a returned `ToolResult` as an assistant message through the thread's pump (the new `Runtime.jobs`), so it lands after any running turn. Without `onAction`, the click becomes the input `(clicked: <label>)`. Full rules are in ui.md "Interactivity".
- **Files:** `files` table in `storage/schema.ts` (with `name`), migration `drizzle/20260926162316_files` generated with `bunx drizzle-kit generate --name=files` (`drizzle-kit check` is clean), and `storage/files.ts` replaces the stub repository. `server/files.ts` handles `POST /v1/files` (multipart part `file`, `FILE_MAX_BYTES`, content-length pre-check, bytes at `<filesDir>/<id>`, row removed if the insert fails) and `GET /v1/files/:id` (stored mime, `nosniff`, `CSP: sandbox`, `404` when the caller may not read the file). The read rule is in storage.md "Files". `server/responses.ts` holds `errorResponse` (moved out of `http-api.ts` to avoid an import cycle, and re-exported there).
- **Tests:** `storage/files.test.ts`, `mind/ui-action.test.ts` (history, onAction once with the clicker's context, stored vs frame value, `undefined` result, clicked input, NOT_FOUND cases, tier/participant refusals, throwing handler, ordering behind a running turn, invalid/too deep/too large/duplicate-id blocks), `server/ui-action.test.ts` (routing, error mapping, not-open thread, invalid frame), `server/files.test.ts` (401, round trip, mime fallback, 400 cases, 404 cases, sharing via the owner's message or a tool block, a URL pasted by someone else grants nothing, paging past 200 messages, files disabled). The new WS/HTTP tests passed 5 runs in a row. `bun run check` is green (795 pass, 2 skip).

**For P2-I1 (bootstrap wiring):** both new deps are optional, so the current bootstrap still compiles and runs:
- `createThreadManager({ ..., tools, services })`. Without `tools`, every click becomes `(clicked: <label>)` and `onAction` never runs. Without `services`, `t.services.get` throws `SERVICE_MISSING`.
- `createCoreServer({ ..., filesDir: paths.filesDir })`. Without it, `/v1/files` answers `404` and the server logs a warning. Bootstrap already creates the folder.

**Decisions**
- Tier check for `onAction`: the lowest tier of the clicking person *and* the thread's participants, because everyone in the thread sees the result. This is the run loop's rule, and in a direct thread it equals "the clicking person" from plugin-api.md.
- `ToolAction.value` is the frame's `value`, or the stored action's `value` when the frame has none.
- A tool that is no longer registered is treated like one without `onAction` (clicked input) rather than `NOT_FOUND`.
- The `message.user` echo of a clicked input also goes to the clicking node, which never typed the text.
- The `ui` entry of an `onAction` result keeps the tool's name, with `toolCallId` `action:<messageId>`, since there is no provider call id.
- File read rule: owner, or a current participant of a thread where the file's URL appears in a user message *written by the owner* or in an assistant UI block. A URL pasted by someone else grants nothing. The check pages through the reader's threads (fine at household scale). A reference index would need a new `FilesRepository` method, which is a `storage/types.ts` change.

**Deviations / follow-ups**
- `docs/architecture/nodes.md` line 67 still says `ui.action` answers `UNKNOWN_FRAME` until phase 2. That file is outside this task's `updates`; P2-I1 (or the coordinator) should drop that clause.
- `/v1/files/:id` needs a bearer header (contract), so the web app (P2-C1) must fetch images with `Authorization` and show them through object URLs. A plain `<img src="/v1/files/…">` gets `401`. Documented in ui.md "Rendering rules".
- `GET /v1/threads/:id/messages` still returns intermediate tool-step assistant rows (empty content), while `thread.opened` hides them. I tried hiding them in the HTTP page and reverted it: a page made only of hidden rows would come back empty with `hasMore: true` and no cursor. Clients should skip assistant messages with empty content and no `ui`, or a later protocol change can page by visible messages.
- Uploads without `content-length` are buffered by `req.formData()` up to Bun's request-body limit before the size check.
- No ADR needed, no blockers.

