---
id: P0-02
title: Implement @keith/protocol
phase: 0
wave: 2
lane: P
status: done
owner: claude
depends: [P0-01]
owns:
  - packages/protocol/**
reads:
  - docs/contracts/README.md
  - docs/contracts/protocol.md
  - docs/contracts/ui-blocks.md
  - docs/rules/conventions.md
updates:
  - docs/contracts/protocol.md
  - docs/contracts/ui-blocks.md
scenarios: []
---

# P0-02: Implement @keith/protocol

## Goal

The wire contract as code: zod schemas and inferred types for every phase-1 and phase-2 frame, the HTTP DTOs, capabilities and UI blocks. Core and every node validate with it.

## Scope

**In:**
- `envelope.ts`: `FrameEnvelope` schema, `makeFrame(type, data, opts)` helper.
- `frames/node-to-core.ts` and `frames/core-to-node.ts`: one schema per frame type, plus discriminated unions `NodeFrame` and `CoreFrame`, and `parseNodeFrame(json)` / `parseCoreFrame(json)` returning a result (`{ ok, frame } | { ok: false, code, message }`).
- `dto.ts`: `PersonDto`, `ThreadDto`, `MessageDto`, `TurnState`, HTTP request/response schemas for phase-1 endpoints.
- `ids.ts`: prefix constants and schemas for prefixed ULIDs (validate the prefix and a 26-char Crockford base32 body).
- `capabilities.ts`: known capability ids plus a parser for `name@major`.
- `ui/blocks.ts`: `UiBlock` recursive schema per [ui-blocks.md](../../contracts/ui-blocks.md) with its limits (depth, size, URL schemes).
- `ui/to-text.ts`: `uiBlockToText(block)` pure function.
- `errors.ts`: error code enum and WS close codes.
- **Doc example test:** reads `docs/contracts/protocol.md` and `ui-blocks.md`, extracts every ` ```json frame` / ` ```json block` fence, and parses it. Any failure fails the test.

**Out:**
- Phase-3 binary frames and audio frames (the schemas can wait; keep the doc table).
- Any networking code.

## Deliverables

- `@keith/protocol` exports everything above from `src/index.ts`.
- Unit tests per schema (valid + invalid cases), including the UI block limits.

## Acceptance criteria

- [x] Every frame in the protocol tables marked phase 1 or 2 has a schema and a round-trip test.
- [x] Doc example test passes and fails if an example is broken (prove it with a fixture).
- [x] `uiBlockToText` covers every standard block type.
- [x] The package depends only on `zod`.
- [x] `bun run check` passes.

## Notes

If a contract turns out ambiguous while implementing, fix the ambiguity in the doc **within this task** (it owns the contract until the freeze in P0-04) and note it in the Outcome.

## Outcome

**Built** (`@keith/protocol`, depends only on `zod@^4.6.5`)

- `src/ids.ts`: `ID_PREFIXES` for all 11 prefixes, `prefixedId(prefix)` (a zod `templateLiteral`, so ids are typed `` `thr_${string}` `` and validated as prefix + 26-char Crockford ULID with first char ≤ 7), named schemas `PersonId`, `ThreadId`, `MessageId`, …, and `isPrefixedId`.
- `src/envelope.ts`: `FrameEnvelope`, `frameSchema(type, data)`, `makeFrame(type, data, { id, ts, re? })` typed per frame type, and the shared `parseFrameWith`.
- `src/frames/node-to-core.ts` / `core-to-node.ts`: one schema per phase-1/2 frame (7 node → core, 12 core → node), the `NodeFrame` / `CoreFrame` discriminated unions, `NODE_FRAME_SCHEMAS` / `CORE_FRAME_SCHEMAS`, and `parseNodeFrame(input)` / `parseCoreFrame(input)` returning `{ ok: true, frame } | { ok: false, code, message, frameId? }`.
- `src/dto.ts`: `PersonDto`, `ThreadDto`, `MessageDto`, `TurnState`, `Tier`, `Modality`, `Timestamp`, `PROTOCOL_VERSION`, `DEFAULT_PORT`, and the phase-1 HTTP bodies (`HealthResponse`, `LoginRequest/Response`, `LogoutResponse`, `MeResponse`, `ThreadsResponse`, `MessagesQuery` (coerces query strings), `MessagesResponse`).
- `src/capabilities.ts`: `KNOWN_CAPABILITIES`, `Capability`, `parseCapability`, `isKnownCapability`, `hasCapabilities`.
- `src/ui/blocks.ts`: hand-written `UiBlock` types (the schema is recursive) and the `UiBlock` schema with all limits (depth ≤ 4, ≤ 256 KB UTF-8, URL schemes, ≤ 200 table rows, id pattern, unique ids per tree). `src/ui/to-text.ts`: `uiBlockToText` for every block type.
- `src/errors.ts`: `ErrorCode`, `HttpErrorBody`, `WS_CLOSE_CODES`.
- Tests (160): a round-trip test for every frame type, invalid cases per frame, envelope and parse-failure tests, DTO/HTTP tests, id, capability and UI block limit tests, `uiBlockToText` per type. `test/doc-examples.test.ts` parses every ` ```json frame ` / ` ```json block ` fence in `protocol.md` and `ui-blocks.md`, proves a broken fixture (`test/fixtures/broken-examples.md`) fails, and checks that the frame types in the protocol tables marked phase 1 or 2 are exactly the implemented schemas.

**Contract clarifications made in the docs** (this task owned them until the freeze)

- `protocol.md`: added error code `INVALID_REQUEST` for HTTP bodies/queries that fail validation (the list had no code for it). Envelope `id`/`re` are 1..64 chars; error replies set `re`. Unknown fields are ignored (dropped), so additive changes stay compatible. Envelope `v` ≠ 1 or `hello.protocol` ≠ 1 → close `4009`, surfaced by the parsers as `UNSUPPORTED_PROTOCOL`. `hello.capabilities` must be well-formed (≤ 64). `thread.open.historyLimit` is 0..200. The messages endpoint: `limit` defaults to 50, pages are oldest first. All ids are validated as prefixed ULIDs and timestamps are integer ms. `FileDto` is left to the phase-2 `/v1/files` task. Added a code map.
- `ui-blocks.md`: depth counting (top-level = 1), size is UTF-8 bytes of the JSON, `/v1/files/<id>` without `..`, id uniqueness checked per tree by the schema and per message by the core, tables need ≥ 1 column, actions ≥ 1 action, `width`/`height` are positive integers, unknown fields ignored, and the exact `uiBlockToText` output per type.

**Deviations**

- Schemas and their inferred types share a name (`PersonDto` is both) instead of `PersonDtoSchema` + `PersonDto`. Documented in the code map.
- Parse functions accept raw text **or** an already-parsed value (`input: unknown`), not only a JSON string.
- Optional fields use zod `.optional()`, so inferred types are `field?: T | undefined`. That is friendlier to producers under `exactOptionalPropertyTypes`.

