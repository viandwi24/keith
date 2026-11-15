# P38 — Web client

Status: built, waiting for the manual test (Nov 15, 2026) · Owner: viandwi24 · Decision: ADR-0035 · Branch: `main`

## Goal

A browser client with the TUI's flow (sign-in, locked token and step-up, the orb, the menus and panels, chat, approvals) and the room
the web gives: richer chat, a command palette, tables, forms and charts in Manage, side panels, notifications, and a layout for phones.

## Phases

Each phase updates its specs in the same change, has its own tests, and passes the targeted tests of the areas it touches.

### W0 Scaffold and tooling — done

Evidence: `bunx sv@latest create apps/web --template minimal --types ts --add sveltekit-adapter=adapter:static --no-install` (sv 1.3.0); svelte 5.57.3, kit 3.2.0, adapter-static 4.0.1, vite 8.3.8 in the catalog; TypeScript 6.0.3 in the named catalog `web` (TS 7 has no `ts.sys`, which SvelteKit's tsconfig writer needs); `bun --bun vite build` works without Node; svelte-check 0 errors; check-imports rules `web-npm-allowlist` and `web-only-client-contracts` with `.svelte` script extraction (tests pass); lint, check-size, check-exports, root tsc pass.

- `apps/web` from `bunx sv create` (SvelteKit 3, adapter-static, `ssr = false`, base `/app`), versions in the catalog.
- TypeScript and `bun --bun vite` settled; svelte-check in `check-types`.
- check-imports reads `.svelte` and has a rule for apps/web; check-size counts `.svelte`; Biome covers the app.
- `apps/web/AGENTS.md`; the folder table in the root AGENTS.md.

### W1 Foundation in client and core — done

Evidence: contracts `web-session.ts` (`SESSION_COOKIE`, `deliver`, adopt, `{ cookie: true }`) and whoami `elevatedUntil`; core `auth/web-session.ts`, `auth/web-routes.ts`, `thalamus/web-static.ts` (CSP with the sha256 of each inline script of `200.html`), `thalamus/cookie-guard.ts`; `@keith/client/browser` with an import-graph test that refuses `node:`, `bun:` and `Bun.`; tests: contracts and client 585 pass, core auth, thalamus and config 340 pass (`web-session.e2e`, `web-static.e2e` included); tsc of contracts, client, core, tui, node and svelte-check clean; lint, check-imports, check-size, check-exports (23 entries) ok. TUI login, step-up and plugin-view tests 58 pass; `bun run smoke` 110 steps ok.


- `@keith/client/browser`: browser stores, environment, `WEB_CAPABILITIES`, cookie mode; Node defaults stay in the Node entry.
- Core: cookie credential (`deliver: 'cookie'` on sign-in, device poll and step-up; adopt and logout routes), CSRF check for
  cookie writes, `/app` static serving with security headers, `KEITH_WEB_DIR`, whoami `elevatedUntil`.
- Done when: core e2e tests for cookie sign-in, CSRF refusal, logout clearing the cookie, Host and Origin; specs `auth.md`,
  `thalamus.md`, `client.md`.

### W2 Sign-in and shell — done

Evidence: `@keith/ui/tokens` (Ink-free tables, the TUI unchanged), bits-ui 2.21.0 in the catalog and the web allowlist, features session, login, shell, connection, toasts, identity; `docs/specs/web.md`; 38 web tests, svelte-check 0 errors. Tried in a browser against a real core on a scratch folder: PIN sign-in sets an HttpOnly cookie (`document.cookie` empty), reload keeps the session, privacy notice and ack, theme switch, desktop rail and the phone tab bar, sign out calls `/auth/web/logout` and a protected path sends back to `/app/login?next=…`. Fixed during the try: the shell used fixed grid rows, so the phone tab bar floated under the content when the offline banner rendered nothing.


Sign-in (all methods, throttle countdown, LAN warning, remember), logout, whoami, connection monitor and offline banner, toasts,
privacy notice, design tokens from `@keith/ui/tokens`, responsive shell (rail, inspector, tab bar). Spec `docs/specs/web.md`.

### W3 Chat — done

Evidence: the TUI's pure chat modules moved to `packages/app-model` (83 tests; the TUI imports them, its chat tests pass); `@ai-sdk/svelte` 5.0.153 (matches `ai` 7.0.153); `@keith/ui/markdown`; `/app/chat` and `/app/chat/history`; 73 web tests. Tried in a browser against a real core with the smoke's fake provider: streaming answer, Markdown list with bold and code, a delegation as a tool card with its task chip, input and output expanded, the slash menu, `/new` refused with "a task is still running" while the worker waits, history list. Fixed during the try: the chat listed only finished tasks after a reload (`active: false`), so a running task lost its chip; the chip now reads `task · <status>`.


Chat session, Markdown (sanitised), tool cards, notices, question cards, dividers, slash palette, `/new`, `/compact`, history, dream lines.

### W4 Approvals and step-up — done

Evidence: approval and step-up logic in `packages/app-model` (`approval-state`, `step-up-state`, `StepUpController`, shared with the TUI); web `approvals` (card above the composer, `/app/inbox`, badge) and `stepup` (dialog, `guard`); the client maps the core's `pin_session_cannot_step_up`. Tried in a browser against a real core, a paired node with shell on and the fake provider: a shell approval card with the full command, Allow once opens the step-up, a PIN step-up from a PIN session is refused with the core's text and the dialog moves to Password, a password step-up allows the command (toast `allowed`, `elevated 9:58` pill, badge down), Deny with reason (typing `n` in the reason field does not deny), tasks turn `done` live. Fixed during the try: the dialog now opens on Password for a PIN session (`preferMethod`), and a dismissed step-up is the info toast `Not confirmed.` as in the TUI, not `Failed to answer`.


Inbox and approval cards (no shortcuts while the composer has focus), step-up dialog and `guard`, the elevated pill.

### W5 Home and presence — done

Evidence: `@keith/ui/orb` with no Bun, Node, ink or react import (import-graph test); brain, budget and nodes state, the Home model and the menu tree in `packages/app-model`; canvas orb and trace, subtitle, quick ask, caption, summary cards, ⌘K palette, inspector, presence kind `web` with one reporting tab (Web Locks, BroadcastChannel fallback), `notify` toasts and opt-in system notifications, `open.view` navigation; 514 web, app-model and ui tests. Tried in a browser: Home with the orb, inspector lamps, tasks, nodes, budget and approvals live; the palette opens Manage > Audit; presence turns `active` with `where` once there is input. Fixed during the try: the orb and the trace now draw one frame at once, so a browser that throttles animation frames never shows an empty canvas.


Canvas orb from `@keith/ui/orb`, brain trace, subtitle, quick ask, command palette, inspector panels, presence kind `web` with
`notify` and `open.view`.

### W6 Screens — done

Evidence: `/app/tasks` (+ detail, stop), `/app/nodes`, `/app/budget`, `/app/presence` (status form, disclosure, clients), `/app/brain`, `/app/me` and `/app/me/memory`, `/app/rooms` (+ room view, invitations, Home banner), `/app/help`; presence, style and room state in `packages/app-model`; 526 web and app-model tests. Tried in a browser: tasks with filters and live status, presence, brain trace, me and persona, rooms.


Tasks, Nodes, Budget, Presence, Brain, Me and Memory, Rooms, Help; start the shared logic package.

### W7 Manage — done

Evidence: every TUI Manage section at `/app/manage/<section>` from shared section models in `@keith/app-model/manage` (the TUI uses the same models; its manage tests pass); tables with search, sort and filters, drawers, forms from the shared specs and `formSpec`, type-to-confirm, shown-once secrets, step-up guard; Logs drill-down with inline SVG charts. Tried in a browser: Audit, People, Providers, Logs (sessions, session with charts, generations). Fixed during the try: Manage pages drop the inspector column so their tables have room at 1280 px.


Every Manage section.

### W8 Plugin views and guest — done

Evidence: `keyBytes` moved to `@keith/client` (TUI and web send the same bytes); `/app/apps` and `/app/apps/<plugin>/<view>` draw the terminal grid over the cookie WebSocket; the guest listener serves `/app/guest` from the same build in `guestOnly` mode (`guest-web.e2e.test.ts`, owner routes 404 there). Tried in a browser: the Notes view renders and takes keys; the guest page refuses a loopback visitor under `zones=lan` and, with `loopback` allowed, chats and reads the public notes.


Terminal-grid plugin views (key handling moved into `@keith/client`), the guest page.

### W9 PWA and Web Push — done

Evidence: core push module (VAPID keys sealed in the vault, RFC 8291 `aes128gcm` with WebCrypto matching the RFC test vector, 404/410 removes a subscription), migration `0027_purple_skullbuster.sql` (`push_subscriptions`), push routes in the reach ladder for away, offline, mobile, out and urgent (a companion route: the front session still follows), neutral payload unless `push.preview`; manifest, icons and a service worker (shell cache only, `push` and `notificationclick`), the device toggle and device list. Served correctly by the core (manifest `application/manifest+json`, worker `text/javascript`, `no-cache`). Not tried end to end here: the in-app browser pane does not fetch service-worker scripts, so registration and a real push wait for the manual test in Chrome.


Install, service worker, Web Push as a reach-ladder route (neutral payload by default).

### Gate

Nov 15, 2026: `bun run check` exit 0 (lint, check-types with svelte-check, 6434 tests pass and 0 fail, check-imports, check-size, check-exports with 28 entries); `bun run smoke` 110 steps ok. Real use waits for manual scenario 34.

### Later

- Declarative plugin web slot and passkey step-up, each with an ADR.
- Plugins as bridges for third-party clients (routes and WebSocket handlers registered at runtime, under the guard): ADR-0035 "Later".

## Owns

`apps/web`, the browser entry of `packages/client`, the cookie and static parts of `modules/auth` and `modules/thalamus`, the
`.svelte` support in `scripts/`, ADR-0035, this file.
