---
id: P0-02
title: Implement @keith/protocol
phase: 0
wave: 2
lane: P
status: todo
owner: null
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

- [ ] Every frame in the protocol tables marked phase 1 or 2 has a schema and a round-trip test.
- [ ] Doc example test passes and fails if an example is broken (prove it with a fixture).
- [ ] `uiBlockToText` covers every standard block type.
- [ ] The package depends only on `zod`.
- [ ] `bun run check` passes.

## Notes

If a contract turns out ambiguous while implementing, fix the ambiguity in the doc **within this task** (it owns the contract until the freeze in P0-04) and note it in the Outcome.

## Outcome

_To be filled._
