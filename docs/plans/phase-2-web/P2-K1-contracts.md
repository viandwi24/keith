---
id: P2-K1
title: Phase-2 contract additions and core interfaces
phase: 2
wave: 1
lane: K
status: todo
owner: null
depends: [P1-I2]
owns:
  - docs/contracts/**
  - packages/protocol/**
  - packages/core/src/mind/types.ts
  - packages/core/src/storage/types.ts
  - scripts/**
  - tsconfig.json
  - docs/decisions/0011-client-app-browser-side.md
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

- [ ] Doc example and table tests still pass; `FileDto` has schema tests.
- [ ] check-deps tests: `packages/client` importing `@keith/sdk` fails; `plugins/web/app` importing `@keith/client` passes and importing `@keith/sdk` fails.
- [ ] core.md interface blocks match the changed `types.ts`.
- [ ] `bun run plans --ready` lists the wave-2 tasks.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
