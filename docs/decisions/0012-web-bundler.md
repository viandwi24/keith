# ADR-0012: Bun's HTML bundler for the web app

- **Status:** accepted
- **Date:** 2026-09-26
- **Rules/invariants affected:** R-18 (official scaffolding), R-19 (one component system per client), stack rule "prefer Bun built-ins"

## Context

Task P2-C1 builds the browser half of `@keith/web` (`plugins/web/app/`, a Node per [ADR-0011](0011-client-app-browser-side.md)) with React, Tailwind and shadcn/ui. The stack table left the bundler open between Bun's HTML bundler and Vite. The output must be static files in `plugins/web/dist/` (`index.html` plus assets), which the plugin serves at `/` with an SPA fallback (P2-B1).

The current official docs were read on 2026-09-26:

| | Bun HTML bundler | Vite |
|---|---|---|
| Sources | <https://bun.com/docs/bundler/html-static>, <https://bun.com/docs/bundler/fullstack>, <https://bun.com/docs/test/dom> | <https://vite.dev/guide/>, Tailwind's Vite guide, <https://ui.shadcn.com/docs/installation/vite> |
| Version | Built into Bun 1.3.11 (the repo's pinned runtime) | Vite 8.3 |
| Runtime | Bun only | Needs Node.js 20.19+ / 22.12+ (Bun is documented as a package manager) |
| Production build | `Bun.build({ entrypoints: ['index.html'], outdir, plugins })`: HTML, hashed JS/CSS chunks, rewritten asset paths | `vite build`: same shape of output |
| Tailwind v4 | `bun-plugin-tailwind` (published from the Tailwind repo). The docs say plugins work only through the `Bun.build` API or `bunfig.toml` `[serve.static]` for the dev server, not the `bun build` CLI | `@tailwindcss/vite`, first-class |
| Dev server | `Bun.serve({ routes: { '/*': indexHtml }, development: { hmr: true } })`, marked "work in progress" | Mature HMR dev server with a proxy option |
| shadcn/ui | No Bun template in `shadcn init` (it reports "could not detect a supported framework"); the documented manual install applies, then `shadcn add` works | Official `-t vite` template |
| Tests | `bun test` with happy-dom (Bun's DOM testing guide) | Vitest would be a second test runner, or the same `bun test` setup |

## Decision

- The web app is bundled with **Bun's HTML bundler** through the `Bun.build` API (`plugins/web/app/build.ts`, `bun run build` in `plugins/web`), with `bun-plugin-tailwind` for Tailwind v4. Output: `plugins/web/dist/index.html` plus hashed JS/CSS, with `publicPath: '/'` so the assets resolve from any client route served through the SPA fallback.
- `bun run dev` runs Bun's fullstack dev server (`app/dev.ts`): `index.html` with hot reloading, and `/v1/*` (HTTP and the `/v1/ws` WebSocket) forwarded to a running core, so the app talks to the core from its own origin exactly as in production.
- shadcn/ui follows its documented manual installation (the `cn` helper, `tw-animate-css`, `shadcn/tailwind.css`, CSS variables), with components added by `bunx --bun shadcn@latest add` (R-18).

## Consequences

- One toolchain: Bun runs the core, the build, the dev server and the tests. No Node.js requirement and no Vite/Vitest dependency tree. This follows the stack rule "prefer Bun built-ins over packages".
- Bun's HTML bundler and dev server are younger than Vite and documented as work in progress. If a missing feature blocks the web app (for example code splitting options or dev-server behavior), switching to Vite is contained: the app code is plain React + Tailwind and does not depend on the bundler, and only `build.ts`, `dev.ts` and the package scripts change.
- shadcn/ui has no Bun template, so its setup is the manual one. `shadcn add` must run in the folder that holds `components.json` and a `package.json` (see [ui.md](../architecture/ui.md#the-web-app)).
- Tailwind runs through a Bun plugin, so the production build uses the `Bun.build` API (a small script) instead of the `bun build` CLI.
