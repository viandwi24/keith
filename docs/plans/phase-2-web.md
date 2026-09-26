# Phase 2: Web + plugin UI (overview)

> Task files are in [phase-2-web/](phase-2-web/README.md). This overview is kept for history.

**Goal:** install `@keith/web` and get the same Threads in a browser, with tool results rendered as UI blocks. Nothing in the Mind or in tool plugins changes (S-8, I-9, I-12).

## Lanes (sketch)

| Lane | Work | Owns |
|---|---|---|
| A | Extract `@keith/client` from the TUI's WS/HTTP code (second consumer = web). Migrate the TUI to it | `packages/client/**`, `apps/tui/src/net/**` |
| B | `@keith/web` server side: `client-app` plugin, static mount at `/`, SPA fallback, nothing else (I-8) | `plugins/web/src/server/**` |
| C | `@keith/web` browser app: React + Tailwind + shadcn/ui, login, thread view, streaming, proactive messages, and rendering of all standard UI blocks + the `html` sandbox, `ui.action`. Decide the bundler (ADR) | `plugins/web/app/**` |
| D | Core: `ui.render` fan-out to capable nodes, `MessageDto.ui`, `ui.action` routing, `/v1/files` | `packages/core/src/{mind,server}/ui*`, `packages/core/src/server/files*` |
| E | `@keith/tool-weather`: reference `tool` plugin with a service, an event and a card UI | `plugins/tool-weather/**` |
| I | Integration + S-8 e2e (browser tests with Playwright against the built web app) | `tests/e2e/**`, `bootstrap.ts` |

**Contract task first:** additive protocol changes for `ui.action`, `MessageDto.ui` and files (if any gaps are found), done as a wave-0 task of this phase.
