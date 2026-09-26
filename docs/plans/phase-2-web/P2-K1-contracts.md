---
id: P2-K1
title: Phase-2 contract additions and core interfaces
phase: 2
wave: 1
lane: K
status: done
owner: coordinator
depends: [P1-I2]
owns:
  - docs/contracts/**
  - packages/protocol/**
  - packages/core/src/mind/types.ts
  - packages/core/src/storage/types.ts
  - scripts/**
  - tsconfig.json
  - docs/decisions/0011-client-app-browser-side.md
  - packages/core/src/mind/thread-manager.ts
  - packages/core/src/server/test-fakes.ts
  - packages/core/src/storage/db.ts
reads:
  - docs/plans/phase-2-web.md
  - docs/architecture/ui.md
  - docs/contracts/protocol.md
  - docs/contracts/plugin-api.md
  - docs/architecture/storage.md
updates:
  - docs/architecture/core.md
  - docs/architecture/repository.md
  - docs/rules/engineering.md
scenarios: [S-8]
---

# P2-K1: Phase-2 contract additions and core interfaces

## Goal

Every wave-2 lane can build against types: the file DTOs, `ui.action` handling in the Mind, the `files` repository, and dependency rules for `@keith/client` and the browser side of client-app plugins. Runs before the parallel lanes, like P0-04.

## Scope

**In:**
- `@keith/protocol` (additive, contracts rule 3): `FileDto` and the `/v1/files` request/response schemas (`POST` multipart → `{ file: FileDto }`, `GET /v1/files/:id` streams the bytes). Update `protocol.md` accordingly.
- `plugin-api.md`: define what the core does with a `ToolResult` returned by `onAction` (placeholder left open in P0-03).
- `packages/core/src/mind/types.ts`: `ThreadManager.action(...)` for `ui.action` frames. `storage/types.ts`: `FileRecord`, `FilesRepository`, `Repositories.files`. Mirror both in core.md's interface section.
- `scripts/check-deps.ts` (+ tests): `packages/client` may import only `@keith/protocol`; the browser side of client-app plugins (`plugins/*/app/**`) follows the app rules (`@keith/protocol`, `@keith/client`), per ADR-0011; plugin server code may not import its `app/`.
- Root `tsconfig.json`: include `plugins/*/app/**/*.{ts,tsx}` and `packages/*/src/**/*.tsx` so wave-3 code is typechecked.
- Propose ADR-0011 (R-1 wording for the browser side of client-app plugins); the human accepts it.

**Out:** any implementation.

## Acceptance criteria

- [x] Doc example and table tests still pass; `FileDto` has schema tests.
- [x] check-deps tests: `packages/client` importing `@keith/sdk` fails; `plugins/web/app` importing `@keith/client` passes and importing `@keith/sdk` fails.
- [x] core.md interface blocks match the changed `types.ts`.
- [x] `bun run plans --ready` lists the wave-2 tasks.
- [x] `bun run check` passes.

## Outcome

Done by the coordinator (like P0-04), after the owner accepted [ADR-0011](../../decisions/0011-client-app-browser-side.md).

**Built**
- `@keith/protocol` (additive): `FileDto`, `FileUploadResponse`, `FILE_MAX_BYTES` (10 MiB), `fileUrl(id)`, with tests. `protocol.md` has a new "Files" section.
- `plugin-api.md`: the `onAction` result is now defined: once per click, tier-checked against the clicking person; a returned `ToolResult` becomes an assistant message without a model call; `undefined` adds nothing; a throw becomes an `error` frame; blocks without `onAction` become the input `(clicked: <label>)`.
- `mind/types.ts`: `ThreadManager.action({ threadId, personId, nodeId, messageId, blockId, actionId, value? })`. `storage/types.ts`: `FileRecord`, `FilesRepository` (`create`, `get`), `Repositories.files`. `core.md` blocks regenerated from the code.
- `scripts/check-deps.ts`: `packages/client` → only `@keith/protocol`; `plugins/<name>/app/**` → app rule (`@keith/protocol`, `@keith/client`); plugin server code may not import its `app/` and vice versa; `dist/` is skipped. Tests added.
- Root `tsconfig.json` includes `*.tsx` in packages/apps and `plugins/*/app/**`.
- `engineering.md` R-1 and `repository.md` updated per ADR-0011.

**Deviations**
- Adding required members to frozen interfaces broke three implementers. I added placeholders only, so `bun run check` stays green, and widened this task's `owns` to cover them: `MindThreadManager.action` throws `NOT_FOUND` ("not supported yet"), the server test fake's `action` throws, and the storage `files` repository rejects `create` and returns `null` from `get`. P2-D1 replaces all three.
- `FileRecord` has a `name` column that storage.md's `files` row lacks; P2-D1 adds it to the table and to storage.md.

