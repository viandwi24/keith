# 0018. Plugin terminal views are rendered on the server

Status: Accepted (2026-11-08), implemented and proven 2026-11-09 (P18, steps 1 to 9). Extends ADR-0016 (the manifest slot `tui`) and ADR-0010 (manage from the TUI). Plan: docs/plans/done/P18-plugin-tui-views.md. Spec: docs/specs/plugin-views.md.

## Context

Plugins (ADR-0016) bring features, and a feature may want a screen: a notes browser, a list of reminders. Shipping plugin UI code to every TUI client means the client
runs code the owner installed on the core, versions drift between core and client, and the client must trust it. The owner decided that a plugin's view is for the
terminal only; a plugin that wants a web UI ships its own, and nothing is shared between the two. Ink 8.0.0 (apps/tui, apps/core and packages/ui all depend on it) accepts
`stdout` and `stdin` in `render(tree, options)`, and its `debug: true` mode writes the whole frame on every render with no cursor movement (`ink.js`, `renderFrame`).
The core already has a WebSocket pattern, `/nodes/ws` (`modules/nodes/gateway.ts`): Host and Origin checks, authentication at upgrade, a hello within 10 seconds,
size limits. Bun's `Bun.serve` takes one `websocket` handler (`compose.ts` passes the nodes gateway), so a second socket kind needs a dispatcher.

## Decision

1. **A plugin view is a full Ink app** written by the plugin (`plugins/<id>/tui/*.tsx`), registered in the manifest as `tui: { menu, views }`. Terminal only.
2. **It runs in the core**, in process: opening a menu entry makes the core `render` the view on a virtual stdout and stdin (not an OS process), torn down on close, on
   idle, when the connection drops or when the viewer's session is revoked or suspended.
3. **The client shows frames and sends keys.** An authenticated WebSocket (`/plugins/views/ws`, same guard and Host/Origin rules as `/nodes/ws`) carries key input and resize
   to the core and frames back. The server renders with Ink's `debug` mode so each message is one full frame of text and SGR styling.
4. **The client treats the stream as untrusted terminal output.** It parses with an allow-list (printable text, newline, SGR colours and attributes) and drops everything else:
   OSC (title, hyperlinks, OSC 52 clipboard), DCS, APC, PM, SOS, every other CSI (including device reports that make a terminal answer), C1 controls, BEL and bidi overrides. It
   never writes view bytes to the real terminal: it draws the parsed cells with its own Ink `Text`, so an escape cannot reach the user's terminal by construction.
5. **The host reserves keys.** `esc` leaves the panel and `ctrl+g` goes Home; the view never sees them. The rest go to the view. Resize is forwarded.
6. **Data goes through `useKeith()`**, which carries the viewer's `Actor` (ADR-0014), so the same guard (actor, ACL, rate limit, audit) of ADR-0016 applies at the data layer. A view
   has no database handle. Opening a view is itself an audited, rate-limited operation.
7. **Menu entries are filtered per actor** by the same permission and audience rules as operations; guests get none.
8. **Theme tokens from `packages/ui` are offered** (`useTheme`), not forced.
9. **Limits:** per-actor and global caps on open views, a frame rate cap (about 8 fps), a frame size cap, an input rate cap, an idle timeout, and no `<Static>` output.

## Consequences

- The client has no plugin code and cannot be attacked by a view's output; the cost is a round trip per key and a full frame per change.
- A view is T1 code (ADR-0016): an endless loop blocks the core's event loop. The error boundary and the caps limit damage, not hostility. A worker or subprocess tier is the later fix.
- Colour: chalk's level is process-global; the view host runs where no other Ink renders (the daemon) and forces truecolor, and the client quantizes to its own depth.
- Adds a socket dispatcher in `compose.ts` (nodes and views share the one `websocket` object) and a shared stream parser in `packages/client`.
- Every view is testable without a terminal: mount on virtual streams, send keys, assert frames.
- Revisit for mouse support, a host-mediated copy action (OSC 52 is stripped), or a subprocess tier for untrusted plugins; a web UI never reuses these views.

## What the build settled (2026-11-09)

- **The local socket serves views.** `fetchLocal` upgrades `/plugins/views/ws` and resolves the principal exactly as HTTP over the socket does (implicit owner for `idle-lock` and `full`, a bearer when trust is `none`); a locked socket answers `423` and a view open at that moment closes as `revoked`; a key in a view counts as the owner's activity for the idle-lock. A TUI on the socket therefore needs no token. Rejected: a TUI that insists on a stored credential (an owner on the socket-only default would never see a view). Guests never get views (the guest listener has no `/plugins`, the guest screen has no menu).
- **The client never writes a view's bytes to the terminal** (decision 4) and this was proved at three levels: the parser's fuzz and golden tests, a hostile plugin against the real server and client (the bytes are on the wire, the client drops all of them) and a real pseudo-terminal asserting the terminal's raw output holds none of them. The one UI component that draws colours which did not come from the theme is `StyledLines`.
- **Plugins carry `react` for the JSX runtime** (`jsxImportSource: "@keith/host"` fails under tsc). Ink and the look still come from `@keith/host/tui`.
- **No one-key public share in the Notes view**: widening needs a step-up a view cannot give (a view is never elevated), so the panel shows the refusal.
- **Caps limit what a view holds and sends, not what it computes.** Unchanged consequence of running T1 code in the core; the subprocess tier remains the later fix. Opening is rate limited (30 a minute per person) and audited with ids only (`plugin.view.open|close`, 20 rows a minute per person, then counted).
