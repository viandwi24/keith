# ADR-0010: OpenTUI (core API, no React) for the TUI node

- **Status:** accepted
- **Date:** 2026-09-26
- **Rules/invariants affected:** R-6, R-19 (one component system per client), I-11

## Context

Task P1-F1 builds the terminal Node. The stack table left the framework open between Ink and OpenTUI, to be picked for Bun compatibility, smooth streaming text, input editing and maintenance activity. Both projects' current docs and npm metadata were read on 2026-09-26:

| | Ink | OpenTUI |
|---|---|---|
| Sources | <https://github.com/vadimdemedes/ink> (readme), npm `ink` | <https://github.com/anomalyco/opentui>, <https://opentui.com/docs>, `/docs/components/textarea`, `/docs/core-concepts/keyboard`, `/docs/core-concepts/testing`, npm `@opentui/core` |
| Latest version | 7.1.1 (2026-07-16) | 0.5.12 (2026-09-22), pre-1.0, releases every one to two weeks |
| Runtime | Node-first (`engines.node >= 22`). Bun is not mentioned in the docs | Bun-first (`engines.bun >= 1.3.0`): a native Zig core loaded through Bun FFI, prebuilt per platform as optional packages (`@opentui/core-<os>-<arch>`: macOS, Linux glibc/musl and Windows, x64 and arm64). Node needs >= 26.4 |
| Rendering model | React reconciler + Yoga, repaints the dynamic region. `<Static>` for finished lines | Native frame buffer with cell diffing. Imperative renderables, plus optional React and Solid bindings |
| Text input | None built in. `ink-text-input` is single-line and last published 2024-05 | `TextareaRenderable`: multi-line, cursor movement, word motions, undo/redo, bracketed paste, rebindable keys (including `submit`) |
| Headless tests | `ink-testing-library` | `@opentui/core/testing`: `createTestRenderer`, `mockInput`, `captureCharFrame` |
| Production use | Many CLIs (Claude Code, Gemini CLI, …) | OpenCode, "for millions of users" |

A smoke test on this repo's Bun 1.3.11 loaded `@opentui/core` and created a test renderer without extra setup.

## Decision

- The TUI uses **`@opentui/core`** (targeting 0.5.x) through its **imperative core API** (`createCliRenderer`, `BoxRenderable`, `ScrollBoxRenderable`, `TextRenderable`, `TextareaRenderable`, `InputRenderable`). No React or Solid binding, so no JSX and no second dependency. The root `tsconfig.json` only includes `.ts` files, and the core API needs nothing else.
- The input is a `TextareaRenderable` with Enter rebound to `submit`. Ctrl+J, Alt+Enter and Shift+Enter (when the terminal reports it) insert a newline.
- Protocol and state logic stay free of OpenTUI (`client.ts`, `state.ts`, `view.ts`), so they run headless in tests. Only `ui.ts` and the login screen import OpenTUI, and they are tested with its test renderer.

## Consequences

- Multi-line editing, streaming redraws and a sticky-bottom scroll box come from the library. The TUI writes no editor and no diffing code.
- The TUI runs on Bun only. That matches the rest of the stack.
- OpenTUI is pre-1.0 and ships breaking changes in minor versions. The dependency uses a caret range on 0.5 (which npm treats as `>=0.5.12 <0.6.0`), and an upgrade to 0.6 is a deliberate `bun add` with the TUI tests as the gate.
- It is a native dependency. A platform without a prebuilt binary can't run the TUI until upstream ships one. The web client (phase 2) covers it.
- If a later client wants React components shared with the web UI, `@opentui/react` can be added then, under a new decision.
