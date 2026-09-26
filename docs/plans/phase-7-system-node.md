# Phase 7: System node in Rust (overview)

> Overview only. See [ADR-0009](../decisions/0009-rust-only-out-of-process.md).

**Goal:** Keith reaches machines: a headless Rust node exposes files, screen, notifications and audio devices, and tools execute there.

## Lanes (sketch)

| Lane | Work |
|---|---|
| 0 (contract) | `node.call` / `node.result` frames, pairing endpoints, JSON Schema export from `@keith/protocol` |
| A | Core: pairing (6-digit code, node tokens), tool routing to nodes by `requires` capability |
| B | `nodes/system` (Rust, `cargo new`): protocol client from generated types, reconnect, config |
| C | Capabilities: `fs@1` (scoped roots), `notify@1`, `screen.capture@1` |
| D | Audio: `audio.in@1`/`audio.out@1` plus a local wake word |
| I | Integration: the owner asks Keith to read a file on another machine |
