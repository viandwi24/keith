---
id: P2-B1
title: "@keith/web server side: client-app plugin serving the browser app"
phase: 2
wave: 2
lane: B
status: todo
owner: null
depends: [P2-K1]
owns:
  - plugins/web/package.json
  - plugins/web/tsconfig.json
  - plugins/web/src/**
  - plugins/web/test/**
reads:
  - docs/architecture/plugin-system.md
  - docs/contracts/plugin-api.md
  - docs/architecture/ui.md
  - docs/decisions/0002-plugins-run-in-core-nodes-do-not.md
updates:
  - docs/architecture/plugin-system.md
scenarios: [S-8]
---

# P2-B1: @keith/web server side

## Goal

Installing `@keith/web` makes the core serve the browser app at `/`. The plugin does nothing else: the browser talks to the core only through the public `/v1` protocol (I-8).

## Scope

**In:**
- Package `@keith/web` (`bun init` in `plugins/web`, R-18), kind `client-app`, namespace `web`.
- `setup`: `ctx.http.static('/', <dist dir>, { spaFallback: 'index.html' })`. The dist dir is `plugins/web/dist/` (built by P2-C1) resolved relative to the package; config option `distDir` overrides it. If the dist dir is missing, the plugin logs a clear warning and serves a tiny placeholder page that says the web app isn't built, instead of failing the core.
- No routes under `/p/web/` unless a real need appears (record it in Outcome).
- Tests with `setupFakePlugin` and against the real core's static serving through a temp dist dir.

**Out:** the browser app itself (P2-C1). Build scripts for the app (P2-C1 adds them to this package.json in wave 3).

## Acceptance criteria

- [ ] The plugin registers exactly one static mount at `/` with SPA fallback.
- [ ] Missing dist → placeholder page and a warning, core keeps running (I-12 spirit: the core never depends on it).
- [ ] No import of `@keith/core`; only `@keith/sdk`/`@keith/protocol` (check-deps).
- [ ] `bun run check` passes.

## Outcome

_To be filled._
