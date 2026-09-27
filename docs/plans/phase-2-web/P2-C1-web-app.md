---
id: P2-C1
title: "@keith/web browser app: React + Tailwind + shadcn/ui"
phase: 2
wave: 3
lane: C
status: done
owner: agent-P2-C1
depends: [P2-A1, P2-B1, P2-D1]
owns:
  - plugins/web/app/**
  - plugins/web/package.json
  - plugins/web/.gitignore
  - docs/decisions/0012-web-bundler.md
reads:
  - docs/architecture/ui.md
  - docs/contracts/ui-blocks.md
  - docs/contracts/protocol.md
  - docs/architecture/stack.md
  - docs/decisions/0011-client-app-browser-side.md
updates:
  - docs/architecture/stack.md
  - docs/architecture/ui.md
scenarios: [S-8]
---

# P2-C1: @keith/web browser app

## Goal

The same Threads in a browser, with every standard UI block rendered, the `html` block sandboxed, and buttons that send `ui.action`. The browser is a Node like the TUI: it uses `@keith/client` and the public `/v1` protocol only (I-8, ADR-0011).

## Scope

**In:**
- **Decide the bundler** (Bun's HTML bundler vs Vite) after reading both current docs; output must be static assets in `plugins/web/dist/` that P2-B1's plugin serves. Write `docs/decisions/0012-web-bundler.md` (`status: proposed`) and update the bundler row in stack.md. Add `build` / `dev` scripts to `plugins/web/package.json`.
- React + Tailwind + shadcn/ui, set up with their official commands (`bunx shadcn@latest init/add`, R-18, R-19), inside `plugins/web/app/`.
- Screens: login, main thread view with history, streaming assistant text, turn-state indicator, tool activity lines, proactive messages marked, input with send and cancel, reconnect state.
- UI blocks: a renderer per standard block type using shadcn components and theme tokens; `html` in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`; images only from allowed URL schemes; unknown block → `fallbackText`. `actions` buttons send `ui.action`.
- Session storage in `localStorage` (token, nodeId) through the storage port of `@keith/client`.
- Tests: component tests for every block renderer (happy-dom or Bun's DOM testing per current docs) and the app state against `@keith/client`'s fake core. A build test that produces `dist/index.html`.

**Out:** Playwright e2e (P2-I1). Workspace (phase 6).

## Acceptance criteria

- [x] Every standard block type renders; `html` iframe has exactly `sandbox="allow-scripts"`.
- [x] Imports only `@keith/client`, `@keith/protocol` and UI libraries (check-deps).
- [x] `bun run --cwd plugins/web build` produces `dist/` that the P2-B1 plugin serves.
- [x] ADR-0012 written as proposed.
- [x] `bun run check` passes.

## Outcome

**Bundler: Bun's HTML bundler** ([ADR-0012](../../decisions/0012-web-bundler.md), `status: proposed`; stack.md row updated). Read on 2026-09-26: Bun `bundler/html-static`, `bundler/fullstack`, `test/dom`; Vite guide (v8.3, needs Node 20.19+/22.12+); shadcn installation, manual installation and CLI pages. Bun won because it is already the runtime, bundler and test runner (stack rule "prefer Bun built-ins"), needs no Node and no Vite/Vitest tree, and produces the static `dist/` the plugin needs. Costs: its dev server is marked work in progress, Tailwind needs the `Bun.build` API (not the CLI), and shadcn has no Bun template.

**Built** (`plugins/web/app/`):

| Path | What |
|---|---|
| `index.html`, `main.tsx` | Entry: `normalizeBaseUrl(location.origin)`, `webStorageSessionStore(localStorage)`, `<App>` in `StrictMode` |
| `build.ts` | `buildApp({ outdir?, minify? })`: cleans `outdir`, `Bun.build` of `index.html` with `bun-plugin-tailwind`, `publicPath: '/'` (assets resolve under SPA-fallback routes), linked sourcemaps. `bun run build` (in `plugins/web`) → `plugins/web/dist/index.html` + hashed `chunk-*.js`/`.css` (~0.4 s; JS ~840 KB minified, mostly react-dom, zod via `@keith/protocol`, and the markdown parser) |
| `dev.ts`, `bunfig.toml` | `bun run dev`: `Bun.serve` with the HTML import (HMR, Tailwind via `[serve.static]`), `/v1/*` HTTP and `/v1/ws` WebSocket proxied to `KEITH_URL` (default `http://127.0.0.1:4824`), `PORT` default 5173. Smoke-tested against the fake core (page, SPA route, login, `/v1/me`, WS `hello`→`welcome` through the proxy, 502 when the core is down) |
| `components/app.tsx` | Restore session → login screen or chat screen; sign-in via `createAuth` |
| `components/chat/*` | `ChatScreen` (`useChat` → `createChatClient` with `['chat.text@1','ui.render@1']`, client `keith-web`, `onNodeId` → `auth.rememberNodeId`), header with person/thread/connection badge/sign out, reconnect banner with "Retry now" (`client.reconnect()`), 4003 → `auth.expire()` + inline sign-in → `client.reconnect(token)`, timeline (load older via `loadOlder`, auto-scroll), messages (markdown for assistant text, streaming cursor, proactive badge, cancelled badge), tool activity lines, notices, floating blocks, turn-state indicator, composer (Enter sends, Shift+Enter newline, Cancel while a turn runs) |
| `components/blocks/*` | One renderer per block type (table in ui.md "The web app"); `BlockEnvContext` gives `sendAction` and file-fetch deps. `html` → `iframe sandbox="allow-scripts" srcdoc` |
| `components/markdown.tsx` | `react-markdown` with `skipHtml`, safe links only, markdown images replaced by alt text |
| `lib/images.ts`, `hooks/use-image-src.ts` | URL rules via `isAllowedUiUrl`; `/v1/files/…` fetched with the bearer token → object URL (revoked on unmount) |
| `components/ui/*` | shadcn (`base-nova` style, Base UI): alert, badge, button, card, input, label, table, textarea, generated by `shadcn add` and formatted by Biome |
| `styles/globals.css` | shadcn's manual-install CSS; first line `@import "tailwindcss" source("..")` so Tailwind scans only `app/` whatever the cwd |
| `components.json`, `package.json`, `tsconfig.json`, `biome.json` | shadcn config; a non-workspace `package.json` (`@keith/web-app`, `imports` aliases only) that the shadcn CLI requires in its cwd; editor tsconfig with DOM libs and matching `paths`; nested Biome config enabling `css.parser.tailwindDirectives` and turning off `a11y/noLabelWithoutControl` for the generated `label.tsx` only (false positive: `htmlFor` comes through props) |

`plugins/web/package.json`: scripts `build`, `dev`; exports unchanged. `plugins/web/.gitignore`: `dist`, `app/node_modules`, `app/bun.lock`.

**Dependency versions** (all with `bun add` in `plugins/web`): react / react-dom ^19.3.0, @base-ui/react ^1.8.0, class-variance-authority ^0.7.1, cn ^0.4.0, lucide-react ^1.48.0, react-markdown ^10.1.0, shadcn ^4.21.0 (for `shadcn/tailwind.css`), tw-animate-css ^1.4.0, @keith/client workspace. Dev: tailwindcss ^4.3.3, bun-plugin-tailwind ^0.1.2, @types/react / @types/react-dom ^19.3.0, @happy-dom/global-registrator ^20.14.5, @testing-library/react ^16.3.3, @testing-library/dom ^10.4.2.

**Tests** (48 in `plugins/web`, including P2-B1's 8; 5 runs green): `ui-block.test.tsx` (every standard block, markdown safety, images: direct, core file with bearer → blob URL, failed fetch, refused scheme; actions send `ui.action` with/without value, refusal text, disabled when floating; `html` sandbox is exactly `allow-scripts`, `srcdoc`, height; unknown type → fallback), `app.test.tsx` against `@keith/client/testing`'s fake core (sign-in + stored session + nodeId + hello capabilities, wrong password, restore skips login, send → streamed reply + tool line + turn state, cancel → `input.cancel`, proactive badge, reply block → click → `ui.action` frame, floating block, history + load older + hidden empty tool-step rows, reconnect banner + retry, 4003 → re-sign-in → reconnect, sign out clears the store), `entries.test.ts`, `images.test.ts`, `build.test.ts` (runs `app/build.ts` in a subprocess into a temp dir; checks `index.html`, absolute asset links, Tailwind output). `bun run check` green (892 pass, 3 skip).

**Decisions and deviations**
- **DOM in tests:** no root `preload` (root `bunfig.toml` is not owned, and it would affect every package). `app/test/dom.ts` `useDom()` registers happy-dom for the calling file and unregisters after it; Bun's native `fetch`, `WebSocket`, `URL`, timers, etc. are kept so tests use real local sockets. Testing Library and components are loaded with `await import()` after `useDom()`: Bun evaluates CommonJS deps (react-dom) before the importing module's body, so static imports made React DOM think it had no DOM (change events silently lost). The app test turns off `IS_REACT_ACT_ENVIRONMENT` (async socket frames + `waitFor`).
- **Build test in a subprocess:** in Bun 1.3.11, `Bun.build` inside `bun test` started from the repo root cannot resolve workspace packages' own deps (`@keith/protocol` from `packages/client`, `zod`); it works from any other cwd and as a plain script. Spawning `bun app/build.ts` avoids it and tests the real script.
- **DOM types:** `/// <reference lib="dom" />` (and `dom.iterable`) in `main.tsx` and `test/dom.ts`, so the root `tsc` has DOM types; `app/tsconfig.json` adds them for editors. Root typecheck passes with the app included.
- **shadcn setup:** `shadcn init` (4.21) reports "could not detect a supported framework" for a Bun HTML app and points to the manual install, which was followed (package.json-imports alias variant). `components.json` sits in `app/` (owned) instead of `plugins/web/`, so the CLI needs `app/package.json`; it installs component deps into `app/` too, which were moved to `plugins/web/package.json` (process documented in ui.md). If the coordinator prefers, widening `owns` to `plugins/web/components.json` would allow the standard layout and drop `app/package.json`.
- **Markdown** renders assistant text too (LLM replies are markdown). Markdown images are never loaded (they bypass the block URL rules).
- **Floating `actions` blocks** have disabled buttons: `ui.action` requires a `messageId`.
- `lucide-react` and `lib/utils.ts` come from the documented shadcn install; the generated base-nova components import `cn` directly.

**Follow-ups for P2-I1**
- E2E (Playwright): run `bun run --cwd plugins/web build`, boot the core with `@keith/web`, and check login → chat → a tool block → button click → `ui.action` round trip in a real browser, plus `/v1/files` images and the `html` iframe sandbox. Visual check of the layout was not done here (no browser in this task).
- `packages/core` needs `@keith/web` as a dependency (P2-B1's note) and CI may want `bun run --cwd plugins/web build` before e2e.
- Consider a bundle-size budget; the first load is ~840 KB minified JS (~235 KB gzip).

No blockers. No ADR beyond 0012.
