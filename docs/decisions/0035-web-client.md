# ADR-0035: The web client is a built-in app

Status: accepted (Nov 14, 2026). Plan: `docs/plans/active/P38-web-client.md`. Amends the P0 plan (`plugins/web-ui`, "the web UI comes
in as a plugin"). Builds on ADR-0013 (sign-in), ADR-0016 (plugin layer), ADR-0033 (client context). Amended by ADR-0037 and
ADR-0038 (proposed): §1 the workspace's core side is the plugin `web`; §7 plugin code may run in the browser, sandboxed.

## Context

The TUI is Keith's only full client. A browser client reaches the person where a terminal cannot (a phone, a borrowed machine, a
second screen) and has room for richer components: Markdown with tables and highlighted code, tool calls as cards, a command palette,
sortable tables and charts in Manage, side panels, system notifications. The P0 plan placed the web UI in `plugins/web-ui`, but a
plugin may import only `@keith/host` and `@keith/contracts`, while every UI must talk to the core through `@keith/client` (hard rule 4),
and the host contract has no slot for static files.

## Decision

1. **`apps/web` is a built-in client, like the TUI.** Neither client is a plugin. Both talk to the core only through `@keith/client`,
   take types only from `@keith/contracts` and share design tokens with `@keith/ui` (Ink-free subpaths).
2. **SvelteKit 3 as a single-page app.** `adapter-static`, `ssr = false`, fallback `200.html`, base path `/app`. Hono in the core stays
   the only server; there is no SSR and no second Node process. The base path keeps SPA routes from colliding with core routes on a
   reload.
3. **The core serves the build at `/app` on the same origin.** No CORS. The existing Host and Origin guard applies; the page gets a
   strict CSP, `frame-ancestors 'none'` and `Referrer-Policy: no-referrer`. The folder comes from `KEITH_WEB_DIR` and can be switched
   off. In development, Vite proxies to the core.
4. **The browser signs in with an HttpOnly cookie.** The sign-in methods and assurance levels are the TUI's (PIN, password, device code,
   token; step-up for sensitive calls). The core issues the credential as a `SameSite=Strict`, `HttpOnly` cookie (`Secure` over HTTPS)
   so page scripts never hold a secret, reads it only when no `Authorization` header is present (the CLI, TUI and nodes are unchanged),
   and refuses a cookie-authenticated write without a same-origin `Origin` or `Sec-Fetch-Site`. "Remember this device" is off by default.
5. **Logic is shared, not rewritten.** The TUI's framework-free state and action modules move step by step into a package both clients
   use; each client keeps only its rendering.
6. **The presence kind is `web`.** One tab per browser reports; a `notify` delivery is a toast, or a system notification when the tab is
   hidden and the person opted in. Web Push joins the reach ladder later.
7. **Plugin views first appear as the terminal grid** they already render; a declarative web slot is a later decision. No plugin
   JavaScript runs in the browser.

## Later: plugins as bridges for third-party clients

A third-party client (for example a mobile app) uses the core's API as it is. When such a client needs something of its own, a plugin
should be able to serve it: register extra HTTP routes and WebSocket handlers in the core at runtime. ADR-0016 §5 forbids free-form
plugin routes and sockets today. Lifting it needs its own ADR: every route and socket goes through the guard (actor, capability, ACL,
step-up), lives under the plugin's prefix, is listed in OpenAPI, rate-limited and audited, and is switched off with the plugin.

## Consequences

- `@keith/client` gets a browser entry (no `node:*` or Bun APIs) and a cookie mode; the core gets cookie auth, CSRF checks, static
  serving and security headers; whoami reports when an elevation ends.
- Vite and SvelteKit join the tool list of ADR-0006; `apps/web` pins TypeScript 6 in a named catalog until SvelteKit reads its
  config without `ts.sys`.
- The gate learns `.svelte`: check-imports reads `<script>` blocks, check-size counts the files, Biome and svelte-check cover the app.
- Two clients must stay equal in reach: a feature lands in the client package first, then in each UI.
- Remote browsers should use HTTPS (Tailscale serve); plain HTTP on a LAN allows the PIN with the TUI's warning.
