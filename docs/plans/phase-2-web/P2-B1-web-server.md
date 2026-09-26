---
id: P2-B1
title: "@keith/web server side: client-app plugin serving the browser app"
phase: 2
wave: 2
lane: B
status: review
owner: agent-P2-B1
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

- [x] The plugin registers exactly one static mount at `/` with SPA fallback.
- [x] Missing dist → placeholder page and a warning, core keeps running (I-12 spirit: the core never depends on it).
- [x] No import of `@keith/core`; only `@keith/sdk`/`@keith/protocol` (check-deps).
- [x] `bun run check` passes.

## Outcome

**Built.** Package `@keith/web` (`plugins/web`, created with `bun init --yes`, generated README/CLAUDE.md/.gitignore/index.ts removed; deps `@keith/sdk`, `@keith/protocol` as `workspace:*` and `zod` via `bun add`). Kind `client-app`, namespace `web`.

- `src/index.ts`: config `{ distDir?: string }` (relative paths resolve against the core's working directory). `setup` calls `ctx.http.static('/', dir, { spaFallback: 'index.html' })` exactly once. `dir` is `distDir` or `plugins/web/dist/` (resolved from `import.meta.url`) when that folder has an `index.html`; otherwise the plugin logs one warning (`web app is not built; serving a placeholder page at /`, with `distDir` and the missing path) and mounts `src/placeholder/`, which holds a static "web app isn't built" page. No filesystem writes, and setup never throws for a missing build, so the core keeps running. Exports `resolveWebRoot`, `DEFAULT_DIST_DIR`, `PLACEHOLDER_DIR`, `WEB_ENTRY`, `webConfig`.
- No `/p/web/` routes, WS handlers, services or events: no real need yet.
- `test/web.test.ts` (8 tests, `setupFakePlugin`): the single `/` mount with SPA fallback and nothing else registered, relative `distDir`, missing dist gives placeholder plus warning, dist without `index.html` counts as not built, placeholder page exists and is served as `text/html`, default dist dir, empty `distDir` gives `CONFIG_INVALID`.
- `docs/architecture/plugin-system.md`: one paragraph on how a client-app plugin with a browser UI is laid out and what `@keith/web` serves.

**Deviations.** The task asks for a test against the real core's static serving. Plugins may not import `@keith/core` (R-1), so this task tests only with the fake context. The real-core check goes to P2-I1 (below). "Not built" means `index.html` is missing from the dist dir, not just the folder, because a folder without an entry file would otherwise return 404 for every path.

**Follow-ups for P2-I1.**
- Add `"@keith/web": "workspace:*"` to `packages/core/package.json` dependencies (`bun add` in `packages/core`) so the host's `import('@keith/web')` resolves under the isolated linker, as with the provider plugins.
- Add an integration or e2e test: bootstrap the core with `plugins.enabled = ["@keith/web"]` and `[plugins."@keith/web"] distDir = <temp dir>`, then check that `GET /` and an unknown client route like `/threads/x` both return the temp `index.html` (SPA fallback), `GET /assets/app.js` returns the file, `/v1/...` is unaffected, and a missing dist serves the placeholder while the core keeps running.
- P2-C1 adds build scripts to `plugins/web/package.json` and must emit `dist/index.html`. `dist` is already in the root `.gitignore`.
