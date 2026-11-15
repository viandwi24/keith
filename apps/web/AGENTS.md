# apps/web

Keith's browser client: a SvelteKit 3 single-page app (Svelte 5, `@sveltejs/adapter-static`, fallback `200.html`). `ssr = false` and `prerender = false` live in `src/routes/+layout.ts`; `paths.base` is `/app` in `vite.config.ts` (SvelteKit 3 keeps its config there, no `svelte.config.js`). The core serves the build at `/app` (ADR-0035). Entries are `src/routes/` (thin: load and compose) and `src/lib/features/`.

- Talks to the core only through `@keith/client`; types from `@keith/contracts`; shared look from `@keith/ui/tokens`, `@keith/ui/markdown` and `@keith/ui/orb` (no Ink, no React; shared logic from `@keith/app-model`; the orb model from `@keith/ui/orb`). Never eharness, hono, `@keith/db` or another app (`scripts/check-imports.ts`: `web-npm-allowlist`, `web-only-client-contracts`).
- From npm only `svelte`, `@sveltejs/*`, `@ai-sdk/svelte` (`Chat`, pinned to the `ai` release) and `bits-ui` (headless primitives; plain CSS, no Tailwind) and (vite config, tests) their tooling. A new UI dependency needs an ADR line; versions live in the root `workspaces.catalog`. `typescript` comes from the named catalog `web` (6.x): SvelteKit and svelte-check read `ts.sys`, which TypeScript 7 does not ship.
- One folder per screen area in `src/lib/features/<feature>/`, public through `index.ts`; other features and routes import only that.
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); shared state in `.svelte.ts` modules, not stores.
- No `{@html}` without sanitising first; model and tool output is untrusted text.
- Env is read nowhere in the SPA: the core's address is the page origin; the base path is `appBase()` (`features/session`), because SvelteKit 3 has no `base` export in `$app/paths`.
- Import another feature or a route's feature as `#lib/features/<name>/index.ts` (the `#lib/*` import map does not resolve folders).
- A prop must not be named `state` (it clashes with the `$state` rune).
- No external fonts or scripts: the core's CSP is `default-src 'self'`.
- Plain CSS in component `<style>` blocks; colour tokens are `--k-<token>` properties written at startup from `@keith/ui/tokens` (`features/shell/tokens.ts`); `src/app.css` and components derive from them, no colour literals anywhere.
- Check: `bun run --cwd apps/web check-types` (svelte-check), `bun run --cwd apps/web build`; Biome formats `.svelte` but cannot see template usage, so unused-import rules are off for `*.svelte`.
- Tests: `bun test ./apps/web` from the repo root (pure `.ts` modules next to the code; no browser runner yet). A `.svelte.ts` file uses runes and is not imported by a test.
- Dev: `vite dev` proxies the core's prefixes to `127.0.0.1:7420` with `Origin` rewritten (`vite.config.ts`). Spec: docs/specs/web.md.
- Service worker: `src/service-worker/` (its own `tsconfig.json`, excluded from the app's; `check-types` runs `tsc -p` on it). Its testable logic is `lib/features/pwa/sw-logic.ts` (no `$app` import, no DOM type). It caches only the shell and immutable files, never an API answer; registration is manual (`registerServiceWorker`), never on the guest page.
- The guest page (`routes/guest`) is served by the guest listener at `/app/guest`: it must work with no owner API and no session (the root layout skips the gate for it).
