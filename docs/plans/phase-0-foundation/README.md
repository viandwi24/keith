# Phase 0: Foundation

**Goal:** a repository where phase-1 lanes can run in parallel without talking to each other. That needs tooling, frozen wire and plugin contracts, and the core's internal interfaces.

| Wave | Task | Lane | Owns |
|---|---|---|---|
| 1 | [P0-01 Scaffold the workspace and tooling](P0-01-scaffold.md) | S | root config, `scripts/`, package skeletons, CI |
| 2 | [P0-02 Implement `@keith/protocol`](P0-02-protocol.md) | P | `packages/protocol/**` |
| 3 | [P0-03 Implement `@keith/sdk` contracts and testing kit](P0-03-sdk.md) | K | `packages/sdk/**` |
| 4 | [P0-04 Freeze contracts and write core interfaces](P0-04-freeze.md) | I | `packages/core/src/**/types.ts`, `docs/contracts/**` |

This phase is sequential because every later task depends on it. Keep each task small.

**Exit:** `bun run check` is green, contracts are marked v1, and `bun run plans --ready` lists the phase-1 wave-1 tasks.
