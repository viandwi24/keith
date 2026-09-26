# ADR-0009: Rust only for out-of-process nodes

- **Status:** accepted
- **Date:** 2026-09-25

## Context

The project uses Bun/TypeScript and wants Rust where it earns its place: low-level device access, performance and small binaries.

## Decision

- The core, the SDK, plugins and the TS clients are TypeScript on Bun.
- Rust is used for **out-of-process Nodes** (the phase-7 system node: fs, screen capture, mic/speaker, wake word, notifications) that speak the public protocol.
- No FFI or native addons inside the core process without a new ADR.

## Consequences

- The protocol must be consumable from Rust. Phase 7 adds JSON Schema export from `@keith/protocol` and generates Rust types from it.
