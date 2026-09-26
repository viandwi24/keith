# Phase 2: Web + plugin UI

**Goal:** install `@keith/web` and get the same Threads in a browser, with tool results rendered as UI blocks. Nothing in the Mind or in tool plugins changes (S-8, I-9, I-12).

| Wave | Task | Lane | Owns (summary) |
|---|---|---|---|
| 1 | [P2-K1 Contract additions and core interfaces](P2-K1-contracts.md) | K | contracts, protocol, `mind/types.ts`, `storage/types.ts`, check-deps |
| 2 | [P2-A1 `@keith/client` + TUI migration](P2-A1-client.md) | A | `packages/client`, `apps/tui` |
| 2 | [P2-B1 `@keith/web` server side](P2-B1-web-server.md) | B | `plugins/web/src` |
| 2 | [P2-D1 Core: ui.action, UI in history, files](P2-D1-core-ui.md) | D | `core/src/{mind,server,storage}`, `core/drizzle` |
| 2 | [P2-E1 `@keith/tool-weather`](P2-E1-tool-weather.md) | E | `plugins/tool-weather` |
| 3 | [P2-C1 `@keith/web` browser app](P2-C1-web-app.md) | C | `plugins/web/app` |
| 4 | [P2-I1 Integration + S-8 e2e](P2-I1-integration.md) | I | `tests/e2e`, fixes |

The browser app waits for wave 3 because it builds on `@keith/client`, which is extracted in wave 2.

**Reserved ADR numbers:** 0011 for P2-K1 (browser side of client-app plugins), 0012 for P2-C1 (web bundler).

**Exit:** S-8 passes in a real browser in CI, and a human used the web app against a real model.
