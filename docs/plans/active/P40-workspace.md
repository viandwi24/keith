# P40 — Workspace: modes, desktops and windows Keith can drive

Status: proposed (Nov 15, 2026) · Owner: viandwi24 · Decisions: ADR-0037, ADR-0038 · Branch: `main`

## Goal

The web client works like Jarvis: one full-screen stage with the orb, a workspace of desktops and windows that lives in the core and
follows the person to every device, and a Keith that sees what is on the screen and opens, arranges and shows windows with manners
written in code. Plugins add window apps through an extension point of the plugin `web`, and their code runs sandboxed. The acceptance
case: "where is Surabaya?" in the web client opens a new desktop with the Maps window on Surabaya.

## Phases

Each phase updates its specs in the same change, has its own tests, and passes the targeted tests of the areas it touches. The full
`bun run check` and `bun run smoke` run once after the last phase (and before each commit the owner asks for).

**Final run (Nov 15, 2026), after P40.5:** `bun run check` (lint, types, 6797 tests pass and 13 skip, imports, size, exports) and
`bun run smoke` (110 steps) pass. The first full run failed four tests in `budget.e2e.test.ts` and `plugins-reminders.e2e.test.ts`:
their input price (1000 USD per 1M) made the ledger's up-front reserve (prompt size × input price + 4096 output tokens) cross the 20
USD limit once the `workspace` tool grew the front prompt past ~11.8k tokens. Their prices now keep a step at the same cost with cheap
input, so the reserve no longer tracks the prompt length.

### P40.0 The stage (already built)

**Built (Nov 15, 2026), not committed.** The legacy shell is switched off behind `LEGACY_SCREENS`; the home page is the stage: the voice
orb as layer 0 (`@keith/ui/orb`, `VOICE_ORB_PALETTE`) and HUD panels floating left and right, the brain panel compact with an
expand toggle remembered per browser. Evidence: `features/stage/*.test.ts`; spec `web.md` "Redesign in progress (the stage)".

### P40.1 Local window manager and app registry

**Built (Nov 15, 2026), not committed.** Ambient, workspace and overview modes on the stage; the document and its operations, layout
presets, window frames with drag and resize, the dock and the overview in `features/workspace`, kept in this browser. The eight old
screens open as `web:*` windows from the dock (the palette stays off with the legacy shell; the dock's launcher replaces it for now).
Evidence: `model.test.ts`, `layout.test.ts` (every preset, 1 to 12 windows, 375/960/1440 px, no overlap), `dark-tokens.test.ts`;
checked by hand at 1440, 960 and 375 px against the test core; spec `web.md` "Workspace (P40.1)". Not yet: the dock subtitle, detail
views inside a window (links still lead back to the stage).

- `features/workspace` in `apps/web`: the three modes (ambient, workspace, overview) as view state; desktops and windows held locally;
  layout presets (`focus`, `split`, `stack`, `grid`, `free`) as pure functions from a desktop to slot rects; drag and resize that end in
  one move; the dock with the small orb and the subtitle.
- An app registry in the SPA with the built-in apps of `web` (`web:chat`, `web:tasks`, `web:nodes`, `web:memory`, `web:budget`,
  `web:inbox`, `web:rooms`, `web:brain`), each the old screen wrapped as a window; the command palette opens apps.
- Specs: `web.md` (modes, window manager, built-in apps).

Done when: every old screen opens as a window, presets lay out 1 to 12 windows without overlap at 375, 960 and 1440 px, and the layout
functions are tested as pure code.

### P40.2 The workspace document in the core

**Built (Nov 15, 2026), not committed.** Schemas and the pure `applyWorkspaceOps` in `@keith/contracts` (the web re-exports them);
migration 0028 `workspaces` with a compare-and-set repo; the parietal workspace service and `workspace.get`/`workspace.apply`;
`workspace-changed` on the person's front session; the client view on the presence heartbeat (memory only); the web syncs
optimistically with replay on conflict. Evidence: `workspace.test.ts` (contracts, core), `workspaces.test.ts` (db),
`workspace.e2e.test.ts`, `service.test.ts` and `presence.test.ts` (the view), `sync.test.ts`; spec `workspace.md`.

- Contracts: workspace document, the twelve operations, `workspace-changed`, the client view (`packages/contracts`).
- Migration `workspaces` (additive); store with `apply(baseVersion, ops)` answering the new version or a conflict; limits (6 desktops,
  12 windows, 4 KB params) enforced on write.
- Operations `workspace.get` and `workspace.apply` over the client; `workspace-changed` on the person's activity feed; the SPA applies
  optimistically, drops its echo, refetches on conflict or resync; the client view (`mode`, `desktopId`, `focusWindowId`) reported to
  presence, throttled.
- Specs: new `workspace.md`, `web.md`, `presence` section of the spec that owns it, `contracts.md`.

Done when: a reload keeps the workspace, a second browser sees changes within a second, two concurrent applies end in one conflict and
a clean retry, and another person's workspace is unreachable (test).

### P40.3 Keith drives the workspace

- The `workspace` tool (look, open, close, arrange, move, set params, add or rename a desktop) applying operations with `by: keith`.
- The reminder line "On screen now: …" for the active client that declares `render.workspace`; none otherwise.
- The client capability `workspace.show` with the 10-second ack; the rendering id `render.workspace`; the waiting chip in the dock
  (the ADR-0034 hold) when the person is typing or idle.
- Etiquette as code: free, ask, never (ADR-0037 §7); 20 Keith operations a minute; audit kind; `brain.parietal.workspace`; undo from the
  dock (inverse operation).
- Specs: `workspace.md`, `parietal.md` (capability), `prefrontal.md` (reminder line), `audit` section.

Done when: scripted-model e2e tests show Keith opening a window with no client online, showing it when the person asked, holding it as a
chip when the person is typing, refusing to close a window the person opened without asking, and the TUI getting text and no window.

Built: the `workspace` tool in `apps/core/src/modules/parietal/workspace-tool.ts` (actions, singleton built-in apps, `personAgreed` for
the person's windows, 20 operations a minute, audit `workspace.keith`, `brain.parietal.workspace`, an undo through `undoKeith`), the
"On screen now" line (`onScreenLine`), `workspace.show` (delivery name = target, `workspaceShowName`) and `render.workspace` declared by
the web, the web's held chip, ambient prompt and `UNDO KEITH`, `workspace.undoKeith` RPC. One workspace service in `wireFront` serves the
router and the tool. Tests: `workspace-tool.test.ts`, the two P40.3 cases of `workspace.e2e.test.ts`, `tool-sources.test.ts`. The
"holding as a chip when typing" decision is the web's (`deliverShow`); the e2e acks `held` as the web would.

### P40.4 Desktops, overview, phone and keyboard

**Built (Nov 15, 2026), not committed.** `desktop.move` in contracts; the overview renames in place, reorders with `◀ ▶` or by dragging
a card, and prints the shortcuts; `keys.ts` (Alt+1…6, Alt+←/→, Alt+Shift+←/→, Alt+J/K, Alt+O, Alt+W, Alt+N, Alt+H, read by `code`);
`PhoneDesktops` and `phone.ts` below 600 px (swiped pages with scroll snap, full-height cards, slim rows for minimised windows).
Evidence: `keys.test.ts` (shortcuts, steps, cycling, the phone pages and cards), the `desktop.move` case of `workspace.test.ts`;
checked by hand at 375 px (cards, a swipe that changes the desktop shown, Alt+3 scrolling its page in) and 1440 px (overview, the
shortcut list, a reorder kept by the core). There is no DOM test environment in `apps/web`, so there are no component tests; the
components were checked by hand. Also fixed: `client_call` sends `input.view` as the `open.view` delivery name (`deliveryNameOf`).

- Overview mode (choose, add, close, reorder desktops); desktop switcher in the dock; keyboard shortcuts (switch desktop, cycle windows,
  overview, close); the phone renders desktops as swipeable pages of full-screen cards.
- Specs: `web.md`.

Done when: the PTY-free browser tests (pure functions and component tests) cover the shortcuts and the phone layout, and the manual test
scenario for the workspace passes at 375 and 1440 px.

### P40.5 Extension points, plugin web apps and Maps

**Built (Nov 15, 2026), not committed; the real-model acceptance case is not run yet.** `@keith/host`: `extensionPoints`,
`contributes`, `web`, `ctx.contributions`, `k.contributions`, boot planning (an unknown point or an entry that does not fit fails the
contributor with one line and the core keeps booting; a declaring plugin that is off makes its contributions ignored with a warning,
ADR-0038 §3 over §2). `plugins/web` declares `web.window` and `web.hud`, contributes the eight screens and `browser`, `doc`, `media`,
`tui`, and has one read operation `apps`. The core builds its window-app catalog from `web.window` (`parietal/web-apps.ts`): the
`workspace` tool lists the apps and their params each turn and parses params, the service refuses `unknown-app` and `bad-params`,
`workspace.apps` lists them for the SPA. Static bundles at `/plugins/<id>/web/` with a CSP per app (`thalamus/plugin-web.ts`); the SPA
CSP gains `frame-src 'self' https:`. The SPA: `PluginFrame` (sandbox `allow-scripts` only) and the bridge (`bridge.ts`), the built-in
viewers, the launcher from `workspace.apps`. `plugins/maps`: `maps_search` (Nominatim) and the `maps:map` window (a dependency-free
OpenStreetMap page). Evidence: `contributions.test.ts`, `host.test.ts`, `plugin.test.ts` (web), `maps.test.ts`, `tiles.test.ts`,
`plugin-web.test.ts`, `web-apps.test.ts`, the plugin-app cases of `workspace-tool.test.ts`, the P40.5 case of `workspace.e2e.test.ts`,
`bridge.test.ts`, `apps.test.ts`, `builtin/params.test.ts`; by hand: the core loads `web, notes, reminders, maps`, the map page renders
Surabaya with its tiles, marker and attribution and answers `init` with `setTitle`, `maps.search` over the cookie finds Tunjungan Plaza.

Different from the plan: the workspace store and its operations stay in the core's parietal region instead of moving into
`plugins/web` (they lean on presence and sessions, and were built and tested there in P40.2 and P40.3; `plugins/web.md`, "Not here").
Not verified: the map inside the workspace window (the desktop app's browser pane refuses every sandboxed frame,
`ERR_BLOCKED_BY_CLIENT`; check it in a normal browser), and the acceptance turns with a real model ("where is Surabaya?", then "zoom to
Tunjungan Plaza"), which spend OpenRouter credit and wait for the owner's go-ahead. Known gaps: the cannot-frame card of `web:browser`
relies on an 8 s load timeout (a blocked frame often still fires `load`); the map's attribution is plain text (the sandbox has no
`allow-popups`, so a link could not open).

- `@keith/host`: `extensionPoints`, `contributes`, `ctx.contributions`, `k.contributions`, boot planning (ADR-0038 §1–2); `plugins.md`.
- `plugins/web`: moves the workspace store and operations into the plugin; declares `web.window` and `web.hud`; contributes its
  built-in apps. Core services for presence and the client route are offered to it.
- Static plugin web bundles under `/plugins/<id>/web/` with the per-app CSP; the SPA's CSP gains `frame-src`.
- The iframe host and the bridge in `apps/web` (`init`, `params`, `call`, `setParams`, `setTitle`, `ready`, `error`), validated by zod,
  calls limited to the contributor's own operations and rate-limited per window.
- The built-in apps `web:browser` (with the cannot-frame card), `web:doc`, `web:tui` and `web:media`.
- `plugins/maps`: the `maps_search` operation and the `maps:map` window (OpenStreetMap tiles in `network`).
- Specs: `plugins.md`, `workspace.md`, `web.md`, new `plugin-web-apps.md`, `plugins/maps` README.

Done when: a contribution to an unknown point fails its plugin with a one-line reason and the core keeps booting; a plugin app cannot
read the cookie or call an operation outside its `calls` (tests); and, with a real model, "where is Surabaya?" in the web client opens a
new desktop with `maps:map` on Surabaya, and "zoom to Tunjungan Plaza" moves the same window.

### Later

A shared room desktop (ADR-0026) and a `/workspace` text list in the TUI; each needs its own decision.

## Owner to run

1. Stage: reload the home page, toggle the brain panel, check 375 and 1440 px.
2. Workspace: open three apps, switch presets, reload, open the same account on the phone.
3. Keith: ask for a map while typing and while idle; check the chip, the undo and the audit row.
4. Maps: the Surabaya case end to end; open a site that refuses framing in `web:browser`.
