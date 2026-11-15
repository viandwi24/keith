# Plugin terminal views

Code: `packages/contracts/src/plugin-views.ts` (slot and protocol), `packages/host/src/tui` and `packages/host/src/views.ts` (virtual streams, `ViewHost`, `useKeith`), `apps/core/src/modules/plugins/view-socket.ts` (gateway), `apps/core/src/compose-views.ts` (wiring and socket dispatcher), `modules/plugins/http.ts` (menu),
`packages/client/src/view` (parser and `openView`), `apps/core/src/modules/plugins/view-audit.ts` (audit), `apps/tui/src/features/plugin-view` (panel). ADR: `docs/decisions/0018-plugin-tui-views-rendered-on-the-server.md`. Plan: `docs/plans/done/P18-plugin-tui-views.md`.
Related: `plugins.md` (manifest, guard), `nodes.md` (the other WebSocket), `client.md`, `tui.md`, `tui-design.md`, `auth.md`.

Status: implemented (P18 steps 1 to 9): slot validation and protocol schemas, the Ink spike (result **GO**, "Spike findings"), ViewHost, `useKeith` and `@keith/host/tui`, the socket dispatcher and `/plugins/views/ws` (TCP and the local socket), the client parser and `openView`, the TUI panel and Home menu (`tui.md`), the built-in Notes and Reminders views, and the operation layer (audit, open rate, doctor, load test).

## Purpose

A plugin writes a full Ink app. The core runs it in process on virtual streams; the TUI shows its frames in a panel and forwards keys. The view is T1 code like the rest of the plugin (a loop that never yields blocks the core:
the caps and the error boundary limit damage, not hostility), but **its output is untrusted by the client** and **its data access is the viewer's**. Terminal only: nothing here is shared with a web UI, and a guest never reaches a view.

## Manifest slot (`tui`)

```ts
tui: {
  menu: [{ id: 'browse', label: 'Notes', view: 'list', permission: 'notes.use', audience: 'user' }],
  views: { list: () => import('./tui/notes-view.tsx') },
}
```

| Field | Rule |
| --- | --- |
| `views` | `{ <key>: () => Promise<{ default: Component }> }`; key is `^[a-z][a-z0-9-]{0,31}$`, at most 16 views. The loader runs when a view opens, not at boot. A default export is a component taking `{ viewId, params }` |
| `menu[].id` | the same key format; unique inside the plugin; the menu id of the whole core is `<plugin>.<id>` |
| `menu[].label` | 1 to 30 characters |
| `menu[].view` | must be a key of `views` (definition error otherwise) |
| `menu[].permission` | `authenticated` (default), a core capability or a capability the plugin declares: the same rule as an operation. A person who lacks it does not see the entry and cannot open the view |
| `menu[].audience` | `user` only. `public` is refused: a guest is never offered a view (P17), whatever a plugin writes |
| `menu` | at most 16 entries. The slot is a strict object: any other key is a definition error |

A view with no menu entry is not openable. The wire id of a view is `<plugin>.<view key>` (`notes.list`); `VIEW_ID` is its pattern. `defineKeithPlugin` validates the slot with `TuiSlotSchema` (`@keith/contracts`) and the cross-checks
(view exists, permission known, ids unique) and reports every problem in `PluginDefinitionError`.

## Menu: `GET /plugins/tui/menu`

Behind the bearer, like the other `/plugins/*` routes. The answer is `{ items: [{ id, plugin, label, viewId }] }` (`ViewMenuSchema`): the entries of the **loaded** plugins whose permission the caller's capability set holds, from the actor facts
read now (a suspended person gets none). A guest has no way to call it (guests reach no `/plugins/*` route). Order: boot order of plugins, then manifest order.

## Transport: `/plugins/views/ws`

- Same front door as `/nodes/ws`: the Host and Origin guard runs first (`createRequestGuard`), then the upgrade.
- **Also on the local Unix socket** (decision of P18 step 6): `fetchLocal` upgrades `/plugins/views/ws` and the principal is resolved **exactly as for HTTP over the socket**: the owner's implicit principal when `local trust` is `idle-lock` or `full`, a bearer (a socket session) when it is `none`;
  a **locked** socket (P14 idle-lock) answers `423` and opens nothing, and a view that is open when the socket locks closes with `revoked` (the sweeper asks again). A person's `key` or `resize` is activity for the idle-lock (`LocalAccess.activity()`), so typing in a view never locks the owner out mid-sentence.
  A client reaches it with `ws+unix://<socket>:/plugins/views/ws`. Guests never get views: the guest listener has no `/plugins`.
- **Authentication at upgrade** with the same resolution as HTTP: `Authorization: Bearer <credential>` through the principal resolver. A missing or bad credential is `401`; a guest credential or a guest listener never reaches this route.
  Step-up is not required to view (operations a view calls apply their own rules). The credential travels in the header only, never in the query string.
- The socket carries JSON text messages. Binary messages are ignored. A message over 64 KiB or more than 400 messages in a second closes the socket with `error` (Bun's `maxPayloadLength` is the larger node limit, 4 MiB, since one `websocket` object serves both kinds).
- The first message must be `hello` within `VIEW_LIMITS.helloTimeoutMs` (10 s), else the socket is closed. A hello that is invalid (any message that is not a valid `hello` first), times out, names an unknown view, a view the actor may not open, or a disabled plugin gets `closed { reason: 'refused' }` (one answer for all).
- A second `hello` on one socket is a protocol error: `closed { reason: 'error' }`.

### Messages (`ClientToViewSchema`, `ViewToClientSchema`)

| Direction | Message | Meaning |
| --- | --- | --- |
| client to server | `{ v: 1, type: 'hello', viewId, cols, rows, colorDepth, params? }` | open the view. `cols` 20 to 400, `rows` 4 to 200, `colorDepth` 1, 4, 8 or 24 (informational: the server always renders truecolor and the client quantizes), `params` at most 8 string pairs |
| client to server | `{ type: 'key', data }` | terminal input bytes, 1 to 4096 characters. An arrow up is `ESC [ A`. Printable text and a bracketed paste go as text. The client never sends `esc` alone or `ctrl+g` (reserved); the host drops them if it sees them |
| client to server | `{ type: 'resize', cols, rows }` | new size (clamped, an unchanged size is ignored); Ink re-lays out and a full frame follows |
| client to server | `{ type: 'close' }` | leave; the server tears the view down and closes the socket |
| client to server | `{ type: 'ping' }` | keep-alive; the server answers `pong`. A `ping` is not input: it does not reset the idle timer |
| server to client | `{ v: 1, type: 'ready', cols, rows }` | the view is mounted |
| server to client | `{ type: 'frame', seq, text, more? }` | a full frame (below) |
| server to client | `{ type: 'closed', reason }` | the view ended: `view` (it exited), `idle`, `revoked`, `limit`, `error`, `refused`. The socket then closes with code 1000 and the reason as text |
| server to client | `{ type: 'pong' }` | answer to `ping` |

**Frame.** `text` is what Ink writes in `debug` mode: the whole screen as lines joined by `\n`, with SGR styling and nothing else. A frame is complete (not a diff), so any frame can replace any older one.
A frame of more than `frameChunkChars` (16384) characters is sent in parts that share one `seq`; every part but the last carries `more: true`. A newer `seq` replaces an unfinished one. A frame of more than `frameMaxBytes` (256 KiB)
is never sent: the view closes with `limit`. `seq` increases by one per frame the host emits; a gap means the socket dropped older frames under backpressure (harmless).

**Backpressure.** The ViewHost emits at most `framesPerSecond` (8) per view and keeps only the latest unsent frame: when `ws.send` reports backpressure (a `-1` result or a large `getBufferedAmount()`) the frame is held and replaced by the next one,
never queued. A client that stays behind for 30 s is closed (`error`). `ready` is always sent before the first frame; a frame that arrives while the view opens is held. Nothing about a view buffers without bound.

**Heartbeat and idle.** The client pings every 20 s; the server closes a socket that has sent nothing for 60 s with `error`. `idleMs` (10 min) without a `key` or `resize` closes the view with `idle`. Input beyond `keysPerSecond` (200) is dropped.

**Revocation.** One sweeper (every 500 ms, running only while a view socket is open) re-resolves each viewer's credential through the same principal resolver as HTTP (a fresh `Request`, so the cache is not hit) and `ViewAccess.find` again (person active, capability still held): a revoked or expired credential, a suspended person or a lost capability gets `closed { reason: 'revoked' }` within about one second and the view is torn down. A failed re-check fails closed.

**Limits.** `perActor` 3 and `global` 10 open views; the next is `closed { reason: 'limit' }`. Teardown on every exit path (close, idle, drop, revoke, error, core stop) leaves no timer, listener or instance.

### Reserved keys

`esc` leaves the panel (the client sends `close`); `ctrl+g` goes Home. Both are handled by the client and never forwarded (`isLeave` and `isHome` in `@keith/client`; the web uses `esc` to release the keyboard); a stray `\u001b` or `\u0007` message is dropped by the server too. Everything else goes to the view.

## Sanitiser rules (the client: `parseFrame`)

The stream is untrusted terminal output. `parseFrame(text, { cols?, rows?, colorDepth? })` (`packages/client/src/view/parse-frame.ts`, pure, no Bun or Node API) turns a frame into `{ lines: Run[][], truncated }` with a strict allow-list. The client **never writes view bytes to the real terminal**:
a UI draws the runs with its own Ink `Text`, so an escape cannot reach the user's terminal by construction.

- **Kept:** printable text (any Unicode letter, symbol, emoji, private-use glyph), `\n` (also `\r\n` and U+2028/2029), tab (expanded to the next stop of 8), SGR (`ESC [ ... m`, parameters split on `;` or `:`) with bold 1, dim 2, italic 3, underline 4, inverse 7, strikethrough 9 and their resets, 8 and bright colours (30 to 37, 90 to 97, 40 to 47, 100 to 107), `38|48;5;n` and `38|48;2;r;g;b`
  (values 0 to 255), 0 and the empty `ESC [ m` as reset. An unknown or malformed SGR parameter is ignored (a malformed extended colour ends that sequence's parameters).
- **Dropped (the whole sequence, never passed on):** every OSC (title, hyperlink, OSC 52 clipboard, any), DCS, APC, PM, SOS (ended by BEL, `ESC \`, U+009C, a newline, or the next `ESC`; an unterminated one ends at the line), every CSI other than a plain SGR (cursor movement, erase, scroll, modes, device reports such as `ESC [ 6 n`,
  kitty queries such as `ESC [ ? u`; a private marker `< = > ?` or an intermediate byte makes it not SGR even when it ends in `m`), two-character escapes with their intermediates (`ESC c`, `ESC ( B`, `ESC 7`), a lone `ESC` at the end. The 8-bit introducers (U+009B CSI, U+009D OSC, U+0090 DCS, U+0098 SOS, U+009E PM, U+009F APC) drop their bodies too, and are never read as SGR.
  Every other C1 control (U+0080 to U+009F), C0 control (BEL, backspace, VT, FF, NUL, SO, SI, ...), DEL, lone `\r`, all Unicode format characters except ZWNJ and ZWJ (which covers bidi overrides U+202A to U+202E, isolates U+2066 to U+2069, LRM, RLM, ALM, soft hyphen, tag characters U+E0000 to U+E007F),
  noncharacters (U+FFFE, U+FFFF, U+FDD0 to U+FDEF and the last two code points of each plane). A lone surrogate becomes U+FFFD.
- **Bounded:** a CSI longer than 256 characters is dropped up to its terminator (an SGR with more than 32 parameters is dropped); at most 4 combining marks or joiners follow one base character (an emoji family keeps its joiners); input beyond 256 KiB is ignored; at most `rows` lines (200 at most) and `cols` cells per line (400 at most; wide East Asian and emoji count 2, the width is an
  approximation, so a UI still clips with Ink's `wrap="truncate"`); `truncated` says something was cut.
- **Colours** are quantized to the client's depth and returned as strings for Ink `Text`: 24 keeps `#rrggbb`, 8 gives `ansi256(n)`, 4 gives the 16 names (`red`, `redBright`, ...), 1 gives none (attributes stay).
- **Properties** (fuzz-tested with a seeded generator, 4000 mixed-piece strings and 1500 random code-point strings, plus golden frames recorded from Ink and a table of attacks: OSC 52 with BEL and ST, title, hyperlink, DCS, APC, PM, SOS, DSR, DA, kitty query, modes, cursor, C1 forms, bidi, BEL, tags, noncharacters, truncated sequences, huge lines): no run text contains `ESC`, a C0 or C1 control, a bidi control, a tag character or
  a lone surrogate; no run is empty; the lines fit `rows` and `cols`; parsing the clean text again gives the same text; a frame at the size cap parses in well under 50 ms.

## Client API (`@keith/client`)

- `client.viewMenu()` (or `fetchViewMenu({ core, credential })`): `GET /plugins/tui/menu`, validated by `ViewMenuSchema`; rejects with `ViewMenuError` (`unauthorized` for 401 or a client without a token, else `unavailable`).
- `client.openView(options)` (or `openView({ core, credential, ... })`) returns a `ViewConnection` and reports through callbacks:

```ts
openView({
  viewId: 'notes.list', cols, rows, colorDepth?: 1 | 4 | 8 | 24 /* default 24 */, params?: Record<string, string>,
  onFrame(frame: ParsedFrame) {},         // each complete frame, already sanitised, cut to the size and depth
  onStatus?(status: 'connecting' | 'open' | 'closed') {},
  onEnd(reason: ViewEndReason) {},       // exactly once
}): { status(), sendKey(data), resize(cols, rows), close() }
```

  `ViewEndReason` is the server's `view | idle | revoked | limit | error | refused`, or what the client saw: `disconnected` (the socket dropped or went silent after it had opened), `unavailable` (it never opened: core down or a refused upgrade, a bad credential among them), `protocol` (the server broke the protocol: bad JSON, a frame that grows past 256 KiB).
- **Keys.** The UI turns its key events into terminal bytes (arrow up is `ESC [ A`; `keyBytes(input, key)` of `packages/client/src/view/key-bytes.ts`, exported from both entries, takes any object shaped like `KeyLike`: Ink's `Key` and the web's mapped `KeyboardEvent` both fit) and calls `sendKey(bytes)`. `esc` alone and `ctrl+g` (`RESERVED_VIEW_KEYS`) are dropped here: the UI handles them itself (leave and Home). Before `open` and after `close`, input is dropped. A paste is split into parts of at most 4096 characters (never between the halves of a surrogate pair) and cut at 64 KiB.
- **Resize.** `resize(cols, rows)` coalesces for 50 ms and sends the last size; the sanitiser uses the latest size for the next frames.
- **Frames.** Parts of one `seq` are joined; a newer `seq` replaces an unfinished one; a frame older than the last complete one is ignored.
- **Close.** `close()` sends `close`, waits up to 1 s for the server's answer and then drops the socket; `onEnd('view')`. Before the socket has opened it just drops it.
- **Heartbeat.** The client pings every 20 s and counts the server gone after 60 s of silence.
- **Reconnect rules: none.** A view lives on the server only while its socket is open, so a dropped connection is a view that is gone. The client reports `disconnected` and never reconnects or replays input behind the person's back; the UI offers to open a fresh view on their action (step 6: the panel says disconnected and offers `esc`).
- Needs a bearer credential, or a client built with `socketPath` (the local Unix socket: no token, the socket's rules decide who the viewer is). A client with neither throws `ViewMenuError('unauthorized')`. `createKeithClient({ baseUrl, fetch: socketFetch(path), socketPath: path })` is what the TUI builds for a socket connection.

### Web (`apps/web`, `docs/specs/web.md`, "Apps")

The web client shows a view as the same terminal grid: it opens the view with the platform `WebSocket` in cookie mode (`client.openView`, no header; the cookie goes with the same-origin upgrade), sizes `hello` from the container in cells (a hidden monospace probe), draws the
parsed runs as text spans in a `<pre>` (never as markup) with the colours mapped to the theme tokens, and sends keys as terminal bytes through `keyBytes` (`@keith/client`, shared with the TUI: the same bytes for the same key). `esc` returns the keyboard to the page instead of
leaving, because the grid takes Tab; `ctrl+c` and `ctrl+g` are not sent. A view of `plugin:<id>:<view>` in an `open.view` delivery opens `/app/apps/<id>/<view>` when the view is in the person's menu. The slot is unchanged: a plugin ships no web code.

## Data and operations (`useKeith`)

A view reaches data only through `useKeith()` from `@keith/host/tui`. `createViewKeith` builds the handle per view for its viewer; it carries **the viewer's actor** (person id, login method), never a credential, and nothing of the plugin or the core:

- `call(target, input)`: runs `<plugin>.<operation>` through `guard.run` with the viewer as principal (`session: { kind: 'api', elevated: false }`: a view never steps up). Actor, capability, audience, input parse, ACL, rate limit and audit all apply. The target must be an
  operation with `expose.call` (the switch of `k.call`); an unknown or closed one is the one `NOT_FOUND`. The viewer may call any plugin's operation that exposes calls, as `k.call` allows. An `AbortSignal` that fires when the view closes is passed to the guard, so a call in flight sees `k.signal` abort.
- `events(target, handler, options?)`: `<plugin>.<event>` typed events for the viewer (`options` is `{ onResync? }`, see the resync rule below), through the `ViewEventsPort`. The core's port is feed-backed (`apps/core/src/view-events.ts`, wired in `compose-views.ts`): it reads the same activity records the person's feed shows (`plugin.<plugin>.<event>` records addressed to the viewer or to `*`, the feed's rule for plugin records), so a view and the feed agree. Rules:
  - **own plugin only**: a view of `notes.list` listens to `notes.*` events; `events('reminders.…')` from it is a no-op unsubscribe;
  - **no history**: a listener starts at the newest record the poller has read; records before it are never delivered;
  - **one poller**: it reads the store every 500 ms only while a view listens and stops with the last listener;
  - **unsubscribe**: the function the plugin gets removes its listener; a view that closes (its abort signal fires) removes every listener it still holds, so nothing outlives the view;
  - **a handler that throws** is logged and does not stop the other listeners.
  - **Resync:** after a prune past the poller's cursor, the cursor moves to the prune boundary (pruned records are never replayed, survivors are read) and every listener of the view gets `onResync()` once for that prune: records of its subscriptions may have been lost, so a view that keeps state from events refetches. It is not called for a read without a prune, nor for a listener that was not attached when the prune happened. A throwing `onResync` is logged and the other listeners still hear it. The port is `ViewEventsPort.subscribe(viewer, plugin, event, handler, options?)` (`packages/host/src/tui/view-keith.ts`); the option is additive, so a listener without it works as before.
- `useTheme()` (from `@keith/ui`): the tokens, `dark` at truecolor (the server renders truecolor; the client quantizes). `useTerminal()`: `{ cols, rows, colorDepth }`, following a resize.

The handle's keys are exactly `viewId`, `call`, `events` (a test asserts it): no database, config, session object or credential. A plugin is T1 code and can still read `process.env`: this is structure, not a sandbox.

`@keith/host/tui` (plugin-facing) re-exports `ink` (`Box`, `Text`, `Newline`, `Spacer`, `Transform`, `useInput`, `usePaste`, `useApp`, `useFocus`, `useFocusManager`, `useWindowSize`, `measureElement`), React hooks and `memo`, `Fragment`, `Suspense`, `createContext`,
and a curated set of `@keith/ui` primitives (`Txt`, `Surface`, `Panel`, `Block`, `ListRow`, `NavList`, `ScrollView`, `TextInput`, `Notice`, `Badge`, `KeyHints`, `Field`, `Markdown`, `Rule`, `G`, text-width helpers, `useTheme`). Not offered: `render`, `Static`, `useStdout`, `useStderr`, `useStdin`.
`check-imports` enforces it: a plugin imports `ink` or `chalk` only through `@keith/host/tui` (`plugins-view-code-via-host-tui`), never `@keith/host/views` (`plugins-no-host-views`), and inside `@keith/host` only `src/tui/` and `src/views.ts` load Ink, chalk or `@keith/ui` (`host-ink-only-in-tui`).

## ViewHost (core-facing: `@keith/host/views`)

`createViewHost({ access, keith, limits?, log?, now? })` returns `{ open, closeFor, closeAll, snapshot }`; `createViewAccess({ directory, plugins })` answers `menu(principalId)` and `find(principalId, viewId)` from the actor facts read now (an active person only; guests, system actors, suspended and unknown people get
nothing; unknown view, not permitted and no menu entry are one answer).

`open({ viewer, viewId, cols, rows, colorDepth, params }, { frame({ seq, text }), closed(reason) })` returns `{ ok: true, view } | { ok: false, reason: 'limit' | 'refused' | 'error' }`:

1. caps: `perActor` and `global` are checked and a slot is taken **before the first await** (concurrent opens cannot pass together); a refused or failed open frees it. `limit` over the caps.
2. `access.find`, then the loader (`loadTimeoutMs` 5 s): a missing view, a missing default export or a failed import is `refused` or `error`.
3. `chalk.level = 3` (refcounted, restored after the last view), a `VirtualStdout`, a discarded `stderr` sink, a `VirtualStdin`, then `render(<ThemeProvider><KeithProvider><Boundary><View viewId params/></Boundary></KeithProvider></ThemeProvider>, { stdout, stderr, stdin, debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false })`.

The handle: `key(data)` (the reserved keys, an empty or oversized string and input beyond `keysPerSecond` are dropped), `resize(cols, rows)` (clamped to the limits; the same size is ignored; Ink re-lays out and a frame follows), `close(reason = 'view')` (idempotent).
**Frame pacing:** the sink drops empty writes and private-mode toggles, keeps only the latest frame, sends at most `framesPerSecond` (8) and never a frame equal to the last one sent; `seq` counts the frames the host emitted. A frame over `frameMaxBytes` closes the view with `limit`.
**Ending:** every path runs one `close`: the viewer closes, `idle` (no `key` or `resize` for `idleMs`), the view calls `useApp().exit()` (`view`), a render error caught by the boundary or an exception thrown by an input handler (`error`; the listeners of `VirtualStdin` are wrapped so a throw is never an uncaught exception of the core),
`closeFor(principalId, 'revoked')`, `closeAll(reason)` (the core stops; later opens are `refused`), a frame over the cap (`limit`). `close` aborts the signal of the calls in flight, unmounts, disposes the streams (listeners, sink), clears the pacing and idle timers, frees the slot and calls `closed(reason)` once. The viewer never sees an error text.
Test: after close, revoke, idle, a view that exits, a render error and an input error, no timer is live, the process `exit` and signal listener counts and the `process.stdin` listeners are at the baseline, and no frame arrives later.

Not caught: an exception thrown in a plugin's own timer or promise (outside React and `useInput`) is an uncaught exception of the core like any T1 plugin bug; the subprocess tier is the later fix.

## Operation: audit, limits, doctor, load

- **Audit.** `plugin.view.open` when a view is ready and `plugin.view.close` when it ends (`modules/plugins/view-audit.ts`, written by the view gateway). Detail: `viewId`; close adds `reason` (the server's reasons, or `disconnected` when the socket dropped) and `openMs`. **Never** a frame, a key, a parameter or a credential (a test greps the rows for typed text and frame text). `via` is `tcp` or `local`. **Rate limited per person**: at most 20 rows a minute; the rest are counted and the next window opens with one `plugin.view.throttled { dropped }`, so a client that opens and closes in a loop cannot flood the table and nothing is silent.
- **Open rate.** At most 30 opens per person per minute (`opensPerWindow`); the next is `closed { reason: 'limit' }` and nothing is started (it counts before `ViewHost.open`, so a refused hello costs no render). Besides the caps (3 per person, 10 in all), the idle teardown (10 min), the key rate (200 a second), the 64 KiB message cap, the 400 messages a second per socket, the 256 KiB frame cap and the 30 s lag close.
- **Doctor.** `keith-core doctor` with a running core adds `plugin views`: each open view as `<view> for <person id> (<age> s)` from `admin.plugins.views.list` (owner only, `plugins.manage`; ids and times, never content). `Core.views.snapshot()` is the same list.
- **Load** (`apps/core/src/plugin-views-ops.e2e.test.tsx`, real server): ten views at once (three people at the cap of 3, one more person) each re-rendering every 5 ms are paced to the 8 fps of the host (2 to 12 frames a second measured), the event loop's worst delay stays under 400 ms, the eleventh view is `limit`; a reader that upgrades, says hello and then never reads again (its socket stops reading while it still types) does not slow the other viewer, and every view is torn down afterwards (`snapshot()` empty, no socket left). The caps limit what a view may hold and send, not what it may compute (a view that never yields still blocks the loop: T1, ADR-0018); the subprocess tier is the later fix (ADR-0018).
- **Tests of the limits** live where the limit lives: caps, idle, revoke and teardown in `packages/host/src/tui/view-host.test.tsx`, backpressure, lag, flood, silence and revoke in `apps/core/src/modules/plugins/view-socket.test.ts`, the fourth view and the 256 KiB cap over a real socket in `plugin-views.e2e.test.tsx`, the revocation time (under 1.5 s) there too, idle over the real socket in `plugin-views-ops.e2e.test.tsx`.

## Plugin views in a plugin package (JSX)

A plugin's view is a `.tsx` file in the plugin (`plugins/<id>/tui/*.tsx`). Its package lists `react` (`catalog:`) and `@types/react` (dev) and its `tsconfig.json` sets `"jsx": "react-jsx"`, so `react/jsx-runtime` resolves from `plugins/<id>`; everything else (Ink, the look, `useKeith`, `useTerminal`) is imported from `@keith/host/tui`, so the plugin still imports only `@keith/host` and `@keith/contracts` (`check-imports`: the JSX runtime is the compiler's import, not the plugin's). (`jsxImportSource: "@keith/host"` was tried: tsc then compiles `@keith/ui`'s own `.tsx` under the plugin's settings and fails, so the dependency is the way.)
Keys can arrive faster than a render (a paste, fast typing): a view that has modes keeps the mode in a ref the input handler reads, as `TextInput` does, or a letter typed into a box is taken for a command.
The built-in views are `notes.browse` (`plugins/notes/tui`, `plugins/notes.md`) and `reminders.list` (`plugins/reminders/tui`, `plugins/reminders.md`); the viewer's actor is what `useKeith().call` runs as, so the P15 leak kit runs through them (`notes-view.test.tsx`, `reminders-view.test.tsx`).
`openTestView` (`@keith/host/testing`) is the test driver; `hostilePlugin` (same entry) is the hostile fixture, proved against the real server and client in `apps/core/src/plugin-views-hostile.e2e.test.tsx`: the raw bytes are on the wire (the server cannot tell), the client drops every one, a frame over the cap closes the view with `limit`.

## Spike findings

Result: **GO**, no workaround of weight. Test: `packages/host/src/tui/spike.test.tsx` (11 tests, Ink 8.0.0, Bun 1.4.2) over `VirtualStdout` and `VirtualStdin` (`packages/host/src/tui/virtual-streams.ts`).

| Question (plan item) | Finding |
| --- | --- |
| Custom stdin and stdout (1) | `render(tree, { stdout, stdin, stderr, debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false })` works. `useInput` works when stdin has `setRawMode` and `isTTY: true` (Ink's `getRawModeStream` and `useInput` need only these, plus `setEncoding`, `read()` and a `readable` event: a `Readable` subclass gives them, `ref`/`unref` are optional). `process.stdin` listeners (`readable`, `data`, `keypress`) and `isRaw` are unchanged. Arrows (`ESC [ B`), printable text and `\r` arrive as the right `key` and `input` |
| Resize (2) | `stdout.columns` and `stdout.rows` are read per layout; after setting them, emitting `resize` makes Ink re-lay out and write a frame (a width change writes an empty chunk, then the new frame, then an identical frame). Components that read the size use `useWindowSize()`. **`interactive: true` is required**: the default is `false` when `CI` is set or `isTTY` is falsy, and then Ink installs no resize listener |
| `debug` and `maxFps` (3) | `debug: true` writes **the whole frame as one `write` call**, no cursor, erase or sync sequences. `maxFps` does **not** throttle `debug` writes (205 writes for 200 state changes in 400 ms), so the `ViewHost` coalesces in its sink to at most 8 frames per second and drops a frame equal to the last sent |
| Non-frame writes | Ink also writes `ESC [ ? 2004 h` and `l` (bracketed paste, when `usePaste` is used), `ESC [ ? 25 h` and an empty string at unmount and on a width shrink. The sink drops an empty write and a write that is exactly `ESC [ ? <digits> h|l`; the client parser would drop them anyway |
| Terminal queries | Without `kittyKeyboard` Ink writes no `ESC [ ? u` query, no DSR `ESC [ 6 n` and no OSC (checked past the 200 ms detection window). The host never passes `kittyKeyboard` |
| Unmount cleanup (4) | After `unmount()` of five busy views (one `setInterval` each, `useInput`): zero live timers (a probe wraps `setTimeout`/`setInterval`), the `exit`, `SIGINT`, `SIGTERM` and `beforeExit` listener counts of the process are back to the baseline, and no frame is written after unmount. While a view is mounted Ink (through `signal-exit`) holds one extra `SIGINT` and `SIGTERM` listener |
| Frame content (5) | Real frames hold only text, `\n` and SGR: bold `1`, dim `2`, italic `3`, underline `4`, inverse `7`, strikethrough `9`, 16/bright colours (`36`, `91`, `44`), truecolor `38;2;r;g;b`, resets. Box borders are plain Unicode. Wide characters and emoji are plain text. A long line is truncated with `…` when asked. Golden test asserts the allow-list `text | \n | SGR` |
| Colour (6) | chalk decides the level once per process from the real stdout and the environment: in a daemon with no TTY it is **0 and no SGR is written**. Ink 8 ignores the virtual stdout for this. The host sets `chalk.level = 3` (`chalk` 6.0.1 is a direct dependency of `@keith/host`, the same instance as Ink's) while at least one view is mounted and puts the old level back when the last one closes (a refcount; a full `bun test` run shares one process, and a level left at 3 broke the colour-off tests of the TUI). It is process-global: only the daemon mounts views |
| `<Static>` | its items accumulate in **every** frame (`fullStaticOutput + output`). Not supported: the frame cap closes a view that grows |
| Hostile strings | Ink scrubs the content of `<Text>` and `<Transform>`: OSC, DCS, non-SGR CSI, BEL and bidi overrides disappear (and `U+009B` 31 m turns into SGR). **`useStdout().write` and `useStderr().write` are raw**: the string goes to the sink in front of the frame. So `@keith/host/tui` does not re-export `useStdout`, `useStderr` or `useStdin`, the host gives `stderr` a sink that discards, and the client sanitiser stays the real defence |
| Frame size | 80x24 of coloured words about 8 KB; the worst case, 200x60 with every cell its own truecolor, about 225 KB. The 256 KiB cap fits the worst case; a normal view is far below the 16 KiB part size |
| `Bun.serve` dispatcher (7) | not part of the spike: step 4 |

Consequences for steps 3 to 5: the sink (not Ink) throttles, de-duplicates and classifies writes; `interactive: true`, `debug: true` and `chalk.level = 3` are fixed; `useStdout`, `useStderr` and `useStdin` are not offered to plugins; the client never trusts that frames are clean.

## Not here

A declarative web slot (the web draws the terminal grid today), mouse, images, hyperlinks, clipboard (a host copy action is future work), views for guests, view-to-view navigation, third-party views (a subprocess tier later).
