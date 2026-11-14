# P18 — Plugin terminal views rendered on the server

Nov 9, 2026 · status: **done Nov 9, 2026 (spike result GO)** · ADR-0018 · specs touched: new `plugin-views.md`; `plugins.md`, `thalamus.md`, `client.md`, `tui.md`, `tui-design.md`, `ui` rules
Order: P14 -> P15 -> P16 -> P17 -> **P18**. Needs: `Actor` and sessions (P14), the guard and `useKeith`-able context (P16), the leak kit (P15). Not offered to guests (P17).

## Goal

A plugin author writes an Ink app; opening its menu entry in the TUI shows it in a panel. The core runs the view, the client shows frames and sends keys, the stream is treated as hostile,
and the data the view reads is checked against the viewer, not the plugin.

## Verified starting point

- Ink is 8.0.0 (`catalog`); `apps/core`, `apps/tui` and `packages/ui` all depend on `ink` and `react`; the core already renders Ink for its console (`apps/core/src/cli/console-home.tsx`).
- `render(tree, { stdout, stdin, stderr, debug, exitOnCtrlC, patchConsole, maxFps, incrementalRendering })` is in `ink/build/render.d.ts`. Raw mode support comes from `getRawModeStream(stdin)`
  (`components/App.js`), so a custom stdin must expose `setRawMode` (and likely `isTTY`) for `useInput`; terminal size comes from `stdout.columns` and `stdout.rows` (`getWindowSize`).
- In `debug: true` Ink writes `fullStaticOutput + output` on every render (`ink.js` `renderFrame`, ~line 343): full frames, no cursor or erase sequences, and `<Static>` content accumulates.
- `/nodes/ws`: `compose.ts` runs the Host/Origin guard first, then `nodes.gateway.upgrade(request, server)`; the gateway authenticates, upgrades and requires a JSON hello in 10 s, `maxPayloadLength` 4 MiB.
  `Bun.serve` receives one `websocket: nodes.gateway.websocket`, so adding a second kind means a dispatcher keyed by `ws.data.kind`.
- The TUI's Home menu is `features/home/home-menu.tsx` and `menu-state.ts`; menu items today come from the manage sections the role may read.
- The TUI talks to the core only through `packages/client` (hard rule 4); scripts import no workspace package (smoke uses plain fetch and `WebSocket`).

## Decisions taken (ADR-0018)

| Question | Decision |
| --- | --- |
| Where it renders | In the core, in process, on virtual stdout/stdin; not an OS process |
| Frames | Ink `debug: true`, one full frame per message, throttled to 8 fps, at most 256 KiB |
| Client parser | Allow-list: text, `\n`, SGR; everything else dropped; drawn by the client's own `Text`, never passed through to the real terminal |
| Parser home | `packages/client/src/view/` (pure, fuzz-tested). An in-repo parser first; `@xterm/headless` only if a gap appears, and then with its reason in ADR-0006 (rule 11) |
| Transport | `/plugins/views/ws` through the same guard as `/nodes/ws`; bearer at upgrade, hello `{ viewId, cols, rows, colorDepth }` within 10 s |
| Reserved keys | `esc` leave, `ctrl+g` Home; the host swallows them |
| Data | `useKeith()` with the viewer's `Actor`; no db handle; the guard applies per call |
| Menu | `tui.menu` entries `{ id, label, view, permission?, audience }`, listed by `GET /plugins/tui/menu` filtered per actor |
| Limits | 3 open views per actor, 10 global, idle teardown 10 min, input 200 keys/s, no `<Static>` |
| Theme | `useTheme()` returns `@keith/ui` tokens; plugins may ignore it |

## Non-goals

A web UI or shared components with a web UI. Mouse, images, hyperlinks, clipboard (OSC 52 is stripped; a host copy action is future work). Third-party or untrusted views (subprocess tier).
View-to-view navigation. Views for guests. Replacing the manage sections. Any eharness change.

## Design in brief

**Manifest slot (validated in P16, now used):** `tui: { menu: [{ id, label, view, permission?, audience }], views: { [id]: () => import('./tui/notes-view.tsx') } }`. A view module's default export is a component with props
`{ viewId, params }`. The host provides `@keith/host/tui` re-exporting `ink`, `react` and `@keith/ui` primitives, so plugins still import only `@keith/host` and `@keith/contracts`.

**ViewHost (core):** for each open view: `VirtualStdout` (EventEmitter with `columns`, `rows`, `isTTY: true`, `write` capturing frames, `resize(cols, rows)` emitting `resize`),
`VirtualStdin` (readable, `isTTY`, `setRawMode`, `ref`/`unref`), then `render(<KeithProvider actor session><ErrorBoundary><View/></ErrorBoundary></KeithProvider>, { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false })`.
Teardown: `instance.unmount()`, remove listeners, clear timers, drop streams; verified by a test that counts timers and listeners before and after.

**Protocol (zod in contracts):** client to server `hello`, `key { data }` (the client translates its key events into terminal byte sequences, e.g. up arrow to `ESC [ A`), `resize { cols, rows }`, `close`;
server to client `ready`, `frame { seq, text }`, `closed { reason: 'view' | 'idle' | 'revoked' | 'limit' | 'error' }`. A viewer whose session is revoked or whose person is suspended gets `closed: revoked` within one second.

**Client parsing:** frames are split into lines, each line into runs `{ text, fg, bg, bold, dim, italic, underline, inverse }`. Control characters, bidi overrides (U+202A-202E, U+2066-2069), zero-width joiner chains beyond a small cap and
lines beyond `rows` are dropped. Colours are quantized to the client's depth. The TUI panel draws the runs with Ink `Text`.

**Operations from views:** `useKeith().call('notes.search', input)` is `k.call` (ADR-0016) with the viewer's actor; `useKeith().events(type)` subscribes to the plugin's typed events filtered for that actor.

## Steps (one commit each, in order; `bun run check` green after each)

1. **Spec and contracts.** `docs/specs/plugin-views.md` (manifest slot, lifecycle, protocol, sanitiser rules, reserved keys, limits), protocol schemas and manifest `tui` validation with tests. Scope `contracts`.
   *Done in `6d8bcae` (2026-11-09).*
2. **Spike as a test.** A test that renders a small Ink component on `VirtualStdout/VirtualStdin`, sends keys and a resize, and records frames; findings go into the spec (raw mode support, `isTTY`, `columns`, resize handling, unmount cleanup, `<Static>`).
   *Done in `25cd810` (2026-11-09).*
   If a verification item below fails, the plan changes before step 3. Scope `host`.
3. **ViewHost and `useKeith`.** Lifecycle, caps, idle, error boundary, teardown test, actor binding test (two viewers, two actors), `@keith/host/tui` re-exports, `check-imports` updated. Scope `host`.
   *Done in `340e46c` (2026-11-09).*
4. **Socket dispatcher and `/plugins/views/ws`.** `compose.ts` passes one `websocket` object that dispatches on `ws.data.kind` (`node` or `view`); the nodes gateway behaviour and tests do not change; view socket does Host/Origin guard,
   *Done in `f24e9c8` (2026-11-09).*
   bearer authentication through the principal resolver, hello timeout, rate limits, revoke watcher. Specs `thalamus.md`, `plugin-views.md`. Scope `thalamus`.
5. **Client parser and `openView`.** `packages/client`: `parseFrame`, `openView({ core, credential, viewId })` returning frames and `sendKey`, `resize`, `close`; fuzz and golden tests (OSC 52, title, DSR `ESC [ 6 n`, DCS, APC, C1, bidi, huge lines, truncated sequences); property: no output string contains ESC. Specs `client.md`. Scope `client`.
   *Done in `60a216c` (2026-11-09).*
6. **TUI panel and Home menu.** `features/plugin-view/` draws runs, forwards keys and resize, shows connecting, disconnected and closed states, honours reserved keys; Home menu merges `GET /plugins/tui/menu`. Specs `tui.md`, `tui-design.md`. Scope `tui`.
   *Done in `40ee040` (views over the local socket, decision below) and `af75c1f` (panel, menu, `StyledLines`) (2026-11-09).*
7. **Built-in views.** Notes browser (list, search, read, share toggle) and Reminders list (cancel, snooze) using `useKeith()`; the P15 leak kit run through the views as an outsider viewer; theme tokens. Scope `host`.
   *Done in `59c89f1` (2026-11-09).*
8. **Operations and limits.** Audit `plugin.view.open|close` (rate limited), caps, idle teardown, `keith-core doctor` shows open views, a load test with the frame cap. Scope `core`.
   *Done in `034b071` (2026-11-09).*
9. **Docs and proof.** `docs/manual-testing.md`, smoke (plain `WebSocket`: open the Notes view, send keys, receive a frame, assert no ESC byte in the text of an untrusted view fixture), ADR index, plan to `done/`. Scope `repo`.
   *Done in the commit that moves this plan to `done/` (2026-11-09): manual scenario 16, smoke `scripts/smoke/views.ts`, ADR-0018 notes, README.*

## Deviations (2026-11-09, steps 1 to 5)

- **Spike: GO** with no heavy workaround (`docs/specs/plugin-views.md`, "Spike findings"). Facts that changed the design: `maxFps` does **not** throttle Ink's `debug` writes, so the ViewHost sink throttles (8 fps), de-duplicates and classifies writes; `interactive: true` is required for resize; chalk is level 0 in a daemon, so the host sets `chalk.level = 3` while a view is mounted and restores it after the last one closes
  (chalk 6.0.1 is now in the root catalog and a dependency of `@keith/host`); `useStdout().write` and `useStderr().write` are raw, so `@keith/host/tui` does not re-export `useStdout`, `useStderr`, `useStdin`, `render` or `Static`.
- **Plugin ids and views.** The wire id of a view is `<plugin>.<view key>`; the manifest `tui.menu[].audience` is `user` only (guests never get views); a view with no menu entry cannot be opened. The menu cap is 16 (the plan said 8 in the schema draft).
- **Protocol additions:** `ping`/`pong` (heartbeat), `closed.reason` gains `refused` (unknown view, not permitted, bad hello and hello timeout are one answer), `frame.more` (a frame over 16 KiB comes in parts of one `seq`; the 256 KiB cap closes with `limit`), `hello.params`. Server frames are held and replaced under backpressure; a client behind for 30 s is closed.
- **Packages:** `@keith/host` gains two subpaths, `./tui` (plugin-facing) and `./views` (core-facing), `ink`, `react`, `chalk` and `@keith/ui` as dependencies and a `jsx` tsconfig; `check-imports` gained `plugins-view-code-via-host-tui`, `plugins-no-host-views` and `host-ink-only-in-tui`.
- **Core wiring:** the view gateway lives in `modules/plugins/view-socket.ts` (module rule), the dispatcher in `compose-views.ts`; `PluginHost` gained `views` (menu and open check), `Core` gained `views` and `viewSockets()`; the node gateway only tags its socket data with `kind: 'node'`.
- **Revocation** is one 500 ms sweeper (running only while a view socket is open) that re-resolves the credential with a fresh `Request` and re-checks the menu permission; measured under 1.3 s in the e2e test.
- **Not done in steps 1 to 5 (still open):** `useKeith().events` has no feed-backed port yet (no-op without one); view open and close audit rows and their rate limit (step 8); `keith-core doctor` listing (step 8). The local Unix socket has **no** WebSocket upgrade, so a TUI that runs on a socket session (no token) cannot open a view: step 6 must decide (a token, or upgrades on the local socket).
- A plugin's own `.tsx` view needs the JSX runtime (`react/jsx-runtime`) resolvable from `plugins/<id>`: step 7 decides (a `react` dependency in the plugin, or `jsxImportSource`), the e2e fixture lives in `apps/core` where `react` resolves.

## Deviations (2026-11-09, steps 6 and 7)

- **Local socket decision (step 6).** The preferred option was taken: `fetchLocal` upgrades `/plugins/views/ws` on the Unix socket, with the principal resolved **as for HTTP over the socket** (one resolver with `localImplicit`: the implicit owner for `idle-lock` and `full`, a bearer for `none`), a locked socket answers `423` (no view; one open when the socket locks closes as `revoked`), and a view key or resize is activity for the idle-lock (`LocalAccess.activity()`), so typing never locks the owner out. The client takes `socketPath` (`ws+unix://<socket>:/plugins/views/ws`) and `viewMenu` and `openView` work with no token on a socket client. The guest listener has no `/plugins` and the guest screen has no menu: guests never get views. Covered by `plugin-views-local.e2e.test.tsx` (implicit owner, activity, lock, trust `none`). The fallback (a stored credential only) was not needed.
- **Panel keys.** `esc` leaves (closes the view), `ctrl+g` goes Home, `ctrl+c` stays the app's exit and is never forwarded; no mouse, wheel, focus or Kitty events go to a view. In-view "back" cannot be `esc`, so the built-in views use `b`, `←` or backspace. After a view ends the panel keeps the last screen under the reason and offers `r` (not after `revoked` or `refused`); no reconnect.
- **Home and P19.** Home is not mounted under a view, so the fade and idle hide cannot run; back on Home everything is shown and the idle timer starts fresh. `StyledLines` is a new `@keith/ui` component (the one place an outside colour is drawn; exports snapshot regenerated). `app.tsx` grew to 750 lines (limit 800): the next feature there must split it.
- **JSX in plugins (step 7).** `jsxImportSource: "@keith/host"` fails under tsc (it compiles `@keith/ui`'s tsx with the plugin's settings), so `plugins/notes` and `plugins/reminders` list `react` and `@types/react` (`catalog:`) and use `"jsx": "react-jsx"`; Ink and the look still come from `@keith/host/tui`.
- **Reminders snooze needs no new operation:** `reminders.update { id, inMinutes }` exists; the view offers it on one-time reminders the viewer made for themselves (cron would become a one-shot; another person's reminder is the owner's to move).
- **Notes share "toggle".** Widening to `@users` or `@public` needs a step-up a view cannot give, so there is no one-key public toggle: the panel lists, adds (`user:`/`group:`, `edit`) and removes entries; a widening attempt shows the core's refusal.
- **Hostile fixture** lives in `packages/host/src/testing/hostile-view.tsx` (`hostilePlugin`, exported from `@keith/host/testing`) instead of `plugins/_fixtures/hostile-view`: a `plugins/_fixtures` folder is not a workspace (the `plugins/*` glob), so `check-imports` could not resolve its imports, and it needs raw Ink access (`useStdout().write`) that only `packages/host` may load. It is not in `BUILTIN_PLUGINS`. The test driver `openTestView` is in the same kit.

## Gate evidence (2026-11-09)

- `bun run check`: exit 0, **2434 tests pass, 0 fail** (Biome, tsc of every package and scripts, bun test, check-imports 915 files, check-size, check-exports). It ran after the last code change; the later edits were the smoke scripts and docs (Biome and tsc re-run clean).
- `bun run smoke`: **SMOKE PASS, 50 steps, 38 s**. New steps: (1) the menu lists `notes.browse` and `reminders.list` for a member and answers 401 without a credential; (2) the Notes view over a plain `WebSocket`: a key moves it, the reader shows the private note, every frame holds only text, newline and SGR (no ESC outside a colour sequence, no C0 or C1 control, no bidi override); (3) an outsider's search never carries the author's private note and `plugin.view.open|close` rows exist with no content in the audit; (4) the owner opens the view on the local Unix socket (`ws+unix`) with no credential and `keith-core doctor` lists it; plus a check inside the guest steps that `/plugins/tui/menu` and `/plugins/views/ws` are 404 on the guest listener.
- Gate items: teardown after close, idle, drop, revoke and error (`view-host.test.tsx`, `plugin-views-ops.e2e.test.tsx`); two viewers, two actors, and the P15 leak kit through both built-in views as an outsider, a group member and a guest (`notes-view.test.tsx`, `reminders-view.test.tsx`); sanitiser fuzz and the hostile plugin over the real server and client (`plugin-views-hostile.e2e.test.tsx`) and a real pseudo-terminal whose raw output holds none of the attack bytes (`cli.view.pty.test.ts`); menus differ per actor and a guest gets none; the fourth view of one actor is `limit`; `esc` and `ctrl+g` never reach a view (`plugin-view.test.tsx`); the local socket (`plugin-views-local.e2e.test.tsx`); load at the caps (`plugin-views-ops.e2e.test.tsx`).
- **Not verified:** how real terminals render the panel (colours, resize, flicker) by eye; remote latency (keys and frames over a slow link); trust in third-party plugins (a view is T1 code in the core: the caps bound what it holds and sends, not what it computes); `useKeith().events` has no feed-backed port yet.

## Risks

- **Ink on virtual streams is unproven here:** step 2 is a spike with a go or no-go before the larger steps.
- **Event-loop blocking by a view (T1):** documented; error boundary, caps; subprocess tier later.
- **Chalk level is global:** run views in the daemon only, force truecolor, quantize at the client; check that the core console (a separate invocation) is unaffected.
- **Key translation fidelity** (modifiers, alt, paste, IME): start with arrows, enter, tab, backspace, printable text, ctrl keys; add as needed; bracketed paste goes as text with a size cap.
- **Resize races and flicker:** coalesce resize, send a full frame after each.
- **Resource use on the owner's laptop:** one timer per view at 8 fps, stopped when the panel closes; measure by hand (manual item) before raising the cap.
- **WebSocket hijack from a web page:** Origin check by the guard; bearer in a header, not a query string.
- **Bandwidth:** full frames are small for 80x24; frame cap 256 KiB; the cap closes the view with `limit`.

## Open verifications (how to check) — results of steps 2 to 4

1. `render(tree, { stdout, stdin })` with fake streams: `useInput` works when `stdin` has `setRawMode` and `isTTY`; Ink never touches `process.stdin`. Check in step 2 with a test that asserts `process.stdin` listener counts are unchanged. **Verified (step 2).** `useInput` works with `setRawMode`+`isTTY`; `process.stdin` listeners and `isRaw` unchanged.
2. `stdout.columns`/`rows` changes plus an emitted `resize` re-lay out the tree under `debug: true`. Check in step 2. **Verified (step 2).** Needs `interactive: true` (default is false under CI or a non-TTY) and `useWindowSize()` in components.
3. `debug: true` plus `maxFps` throttles writes; if it does not, throttle in the `VirtualStdout` (coalesce to the latest frame). **Verified (step 2): `maxFps` does not throttle.** The ViewHost sink throttles and de-duplicates.
4. A view can be unmounted without leaking timers (Ink's own `animation` timers and plugin `setInterval`): the teardown test counts active handles. **Verified (steps 2 and 3).** Zero live timers, process listeners at baseline, no late frame, after close, revoke, idle, self-exit, render error and input error.
5. The set of sequences Ink 8 itself emits in `debug` mode for typical components (colours via chalk, bold, `Box` borders): record real frames and confirm the sanitiser keeps them intact (golden test). **Verified (step 2).** Text, `\n` and SGR only; plus `ESC[?2004h/l`, `ESC[?25h` and empty writes that the sink drops. Golden test in the spike and in `parse-frame.test.ts`.
6. chalk level per instance: confirm what Ink 8 uses to decide colour support with a custom stdout (`stdout.hasColors`, env, `supports-color`), and what the daemon's environment gives. **Verified (step 2).** Process-global, level 0 in a daemon; the host sets level 3 while a view is mounted and restores it (a first full check showed a level left at 3 breaks the TUI colour-off tests that share the test process).
7. `Bun.serve`'s `websocket` object accepts a dispatcher that reads `ws.data.kind` without changing the nodes behaviour (the existing `gateway.test.ts` is the guard). **Verified (step 4).** One dispatcher on `ws.data.kind`; `gateway.test.ts` and the node e2e tests pass unchanged.

## eharness impact

None.

## Verification items for the gate

- Teardown leaves no timers, listeners or retained instances after close, idle, drop, revoke and error.
- Two viewers with different actors on the same view see different data; an outsider sees no private note through the view (leak kit).
- Sanitiser fuzz: no ESC, no C1, no bidi override in any output; OSC 52 and title sequences never reach the terminal (PTY test asserts the real terminal bytes contain none of them).
- Menu lists differ for owner, member and an actor without the permission; a guest gets none.
- Caps: the fourth open view of one actor is refused with `limit`.
- Reserved keys: `esc` never reaches the view; `ctrl+g` goes Home.
- `bun run check` and `bun run smoke` pass.

## Gate

`bun run check` exit 0 on a clean copy; PTY test opens the Notes view from Home, types a search, sees results, `esc` returns; smoke step for the WebSocket. Record counts.

## Owner to run

1. `space` on Home: the menu shows Notes and Reminders; open Notes, search, read one, press `esc`.
2. Resize the terminal while the view is open; it re-lays out.
3. Kill the core while a view is open: the panel says disconnected and offers `esc`.
4. As a member, check the menu differs (no admin entries) and a private note of someone else is invisible.
5. Revoke the session with `keith sessions`: the open view closes within a second.
6. Watch CPU for one minute with a view open and idle; it should be near zero after the idle teardown.
7. Install the test plugin that prints OSC 52 and a title sequence (`plugins/_fixtures/hostile-view`, test-only): the clipboard and window title stay untouched.
