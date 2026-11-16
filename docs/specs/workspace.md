# Workspace: desktops and windows of one person

Code: `packages/contracts/src/workspace.ts` (schemas and the pure `applyWorkspaceOps`, shared by the core and every client),
`apps/core/src/modules/parietal/workspace.ts` (service), `workspace-procedures.ts` (RPC), `workspace-tool.ts` (Keith's tool and the
"On screen now" line), table `workspaces` (`db.md`, migration 0028,
repo `packages/db/src/repos/workspaces.ts`). Client side: `apps/web/src/lib/features/workspace` (`web.md`, "Workspace").
Decisions: ADR-0037 (modes, desktops, windows Keith can drive), ADR-0038 (the plugin `web` and window apps; the store moves into it in
P40.5). Plan: `docs/plans/active/P40-workspace.md`.

Status: P40.1 (the web's window manager), P40.2 (this document in the core, the RPC, the feed record, the client view) and P40.3
(Keith's tool, the reminder line, `workspace.show`, the undo) are built.

## Document

One workspace per person: `WorkspaceDoc { version, desktops }`.

- **Desktops**: 1 to 6 (`MAX_DESKTOPS`), each `{ id, name (1..40), layout, windows }`. `layout` is a preset: `focus`, `split`,
  `stack`, `grid`, `free` (how a client draws them: `web.md`).
- **Windows**: at most 12 per desktop (`MAX_WINDOWS`), each `{ id, app, title (1..80), state, z, rect?, params?, openedBy }`. `app` is
  `<plugin>:<app>` (`web:chat`, later `maps:map`); `state` is `normal`, `min` or `max`; `z` orders the windows (the focused one is the
  visible one on top); `rect` is a normalised rect used while the layout is `free`; `params` is what the window shows (JSON, at most
  4096 bytes), never a copy of the data it points at; `openedBy` is `person` or `keith`, stamped by the core from who applied the
  change, never sent by a client.
- Ids are 1..40 characters of `[A-Za-z0-9_-]`, made by the client that adds the desktop or opens the window, unique in the workspace.
- A person with no row has the empty workspace: one desktop `d1` named `Desktop 1` with layout `split`, version 0.

## Operations

`desktop.add`, `desktop.rename`, `desktop.remove`, `desktop.move` (puts it at `index`, clamped; the others keep their order),
`desktop.layout` (optional `rects` per window when going `free`, so nothing
jumps), `window.open`, `window.close`, `window.focus` (restores a minimised window), `window.setState`, `window.move` (clamps the rect
to at least 10 % and inside the area, and turns its desktop `free`), `window.setParams`, `window.toDesktop`.

`applyWorkspaceOps(doc, ops, by)` applies them in order, all or none, without mutating its input. A refusal names the operation (`at`)
and why: `unknown-desktop`, `unknown-window`, `duplicate-id`, `desktop-limit`, `window-limit`, `last-desktop` (the last desktop is
never removed); the service adds `unknown-app` and `bad-params` ("Window apps"). A call that changes the desktops bumps the version by exactly one; one that leaves them as they were (the layout
they already had, a focus on the window on top) keeps the document and its version.

## RPC

Every signed-in person (`chat`); the person is the principal, so nobody reads or changes another person's workspace (a guest has
none).

- `workspace.get` → `WorkspaceDoc`.
- `workspace.apply({ baseVersion, ops (1..20), clientId? })` → `{ status: 'applied', doc }`, `{ status: 'conflict', doc }` (the
  document moved on since `baseVersion`; the newest is sent so the caller applies again on it) or `{ status: 'refused', error, at, doc }`
  (nothing written). A malformed input (an app id that is not `<plugin>:<app>`, params over 4 KB, 21 operations) is the usual
  validation error. `clientId` is a tag of the sending tab (at most 64 characters), echoed in the feed record.
- `workspace.undoKeith()` → the same result: takes back Keith's latest change while nothing changed after it (the document before it
  is written as a new version and announced `by: 'person'` with no operations), else `{ status: 'refused', error: 'nothing-to-undo' }`.
  Kept in memory per person: any change by the person, or a restart, forgets it.
- The write is compare and set on the stored version: of two applies on the same version, one lands and the other is a conflict.

## Feed

An applied change that changed the document writes `workspace-changed { version, ops, by, clientId? }` on the person's current front
session (own only, `thalamus.md`). A client drops a record with its own `clientId`, and reads `workspace.get` again for a newer version
and on every resync.

## Client view

What a client shows is its own (ADR-0037 §4): `ClientView { mode: 'ambient' | 'workspace' | 'overview', desktopId?, focusWindowId? }`
rides on `presence.clients.heartbeat` (`view`) and is kept in memory by the parietal service (taken even from a beat that comes too
soon; gone on goodbye, removal or restart). The web app also beats at once when its view changes (`reportNow`), so Keith's next turn
sees a switch between the orb, a desktop and the overview without waiting for the 20 s cadence. `presence.clients.list` shows it on an
online client; the owner's raw read never does (`parietal.md`). The "On screen now" line reads it (below): on the orb it says the
workspace is out of sight until Keith opens, focuses or shows something.

## Keith

The front agent's `workspace` tool (`workspace-tool.ts`, ADR-0037 §6, §7); never a worker's, a room's or a guest's. The person is the
principal, never an argument. Metadata `{ risk: 'write', reversible: true, source: 'trusted' }`: it runs in a clean turn and is asked
in conversation in a tainted one (ADR-0036).

- Actions (`action`): `look` (desktops, windows with `openedBy` and `focused`, the screens and their views), `open { app, title?,
  params?, desktop? (an id or "new"), desktopName?, layout?, show? }`, `close`, `focus { windowId, show? }`, `params { windowId,
  params, show? }`, `move { windowId, desktopId }`, `arrange { desktopId, layout }`, `desktop { name }` (adds one), `rename`,
  `remove { desktopId, personAgreed? }` (deletes a desktop and its windows), `show { desktopId? | windowId? | overview? | orb? }`. `app` is a
  window app of the catalog (below, "Window apps"); its params are parsed with the app's schema (defaults filled in) before anything is
  applied (`unknown-app`, `bad-params`, `not-allowed` for an app whose `permission` the person lacks; `options.can`). An app marked
  `singleton` that is open is brought to the desktop and focused; any other opens a new window each time. `params { windowId, params }`
  is parsed with the window's app too. The tool description is built each turn from the catalog (`workspaceDescription`, `appsLine`:
  each app's id, what it shows and the JSON Schema properties of its params); every app is listed and `permission` is checked when
  the tool runs.
- `open` puts the window on the desktop the person's active workspace screen shows (its view), else the first desktop. It works with
  no screen online: the window waits in the workspace.
- Changes go through `workspace.apply(…, 'keith')` on the newest version, again up to three times after a conflict, so every window
  Keith opens is `openedBy: 'keith'`.
- **Manners in code.** Free: open, focus, arrange, add, rename or remove a desktop that holds only Keith's windows, and close, move or
  change Keith's own windows. Ask first: a window the person opened is closed, moved, changed or removed with its desktop only with
  `personAgreed: true` (the model asks in its reply first); without it the answer is `ask-first` and nothing is written. The approve
  hook never reads live state, so the flag is in the input. Never: the last desktop is not removed (`last-desktop`: close its windows
  instead), and the tool never sees another person's workspace. A removal is undone like any other change.
- At most 20 operations a minute per person (`KEITH_OPS_PER_MINUTE`, a sliding minute counted in operations); over it the answer is
  `rate-limited` and nothing is written.
- Every call but `look` writes the audit row `workspace.keith { person, action, ok }` and the event `brain.parietal.workspace
  { action, ok }` on the turn's session (`brain-events.md`). A call that changed the document records an undo (`undo_last`) that runs
  `undoKeith`; the dock offers the same undo.
- `open`, `focus` and `params` bring the person's screen to that window by default, from the orb too: unless `show: false` (Keith
  prepares something quietly) or the screen already shows that desktop (and, for `open`, that window on top), they ask `workspace.show`
  after the change and answer `shown`, `held` or `no-screen` with it. `show { orb: true }` sends the screen back to the orb.
- `show` asks the person's online clients that declare both `render.workspace` and `workspace.show`, the active one first, through
  `parietal.callClient('workspace.show', …)`. The delivery `name` carries the target (`workspaceShowName`: `overview`, `:ambient`,
  `<desktopId>` or `<desktopId>/<windowId>`, read back by `parseWorkspaceShowName`; ids never hold `:`). The client acks `shown` or
  `held` (it holds a desktop or the overview as a dock chip while the person types or the tab is hidden; back to the orb is never held);
  the tool answers that, or `no-screen`.

**The "On screen now" line.** Each front turn whose person has a workspace screen online gets one reminder line (`onScreenLine`):
the active screen's label, its mode, and in `workspace` mode the desktop, the focused window and the open windows' titles. Titles
and labels lose control characters, are clipped to 40 characters, quoted, and the line says they are data, not instructions. No line
when no online client declares `render.workspace`.

## Consent

The `workspace` tool declares `risk: 'write', reversible: true, source: 'trusted'`, but the consent hook reads the effect of each call
from `workspaceConsentEffect(name, input)` (`parietal/consent-effects.ts`, part of `effectOf`, ADR-0039). A workspace action changes only
what the person sees, can be undone and sends nothing anywhere, so every call is `none` and is never asked, also after outside content in
the turn (a `maps_search`, a page). Exception: an `open` or `params` whose params hold a destination (a string with a scheme right before a
non-space such as `https:` or `mailto:a@b`, or `//host`, or holding `://`, at any depth; a label like `Route: Surabaya` is not one) is `egress` with those strings as `url` targets: it runs when the person wrote the
host ("open detik.com") or the turn is clean, and after outside content the person answers yes or no before Keith opens a URL it did not
get from them (`web:browser`, `web:media`). Plugin pages reach only the origins their
plugin declared, so their other params are safe. Decided from the input alone (`tool.approve` is re-run on re-validation).

## Window apps (P40.5, ADR-0038)

The catalog (`modules/parietal/web-apps.ts`) is the contributions to `web.window` (`PluginHost.contributions`, read on each call):
each becomes `<contributor>:<id>` with its parsed `WindowAppContributionSchema` entry. The plugin `web` (`plugins/web.md`) contributes
the built-in apps; when it is off there is no contribution and the eight screens of `BUILTIN_WINDOW_APPS` stand in as singletons with
no params, so the workspace keeps working.

- `workspace.apply` checks `window.open` (a known app, params that fit) and `window.setParams` (params that fit the window's app, also
  a window opened earlier in the same list) before applying: `{ status: 'refused', error: 'unknown-app' | 'bad-params', at }`. A
  window of an app that went away (its plugin turned off) keeps its params and can still be closed or moved.
- `workspace.apps()` → `WebApp[]`: the apps the caller may open (no `permission`, or one in the caller's capabilities), with `entry`
  `{ builtin }` or `{ url: '/plugins/<contributor>/web/…' }`, `network`, `calls` as full names (`maps.search`), `singleton`,
  `minSize` and the params as JSON Schema (`z.toJSONSchema`, input side). The SPA side is `plugin-web-apps.md`.

## Storage and removal

`workspaces` holds one row per person (`person_id`, `version`, `doc` as JSON, `updated_at`). A stored document that no longer reads
(or whose version disagrees with the row) is logged and read as the empty workspace at the row's version, so the next write still
lands. A removed person's row is kept in the presence file of the kept folder and deleted at the purge (parietal removal part).

## Tests

`packages/contracts/src/workspace.test.ts` (operations, limits, refusals, no-op, batches, params, schema), `packages/db/src/repos/
workspaces.test.ts` (compare and set, per person, delete), `apps/core/src/modules/parietal/workspace.test.ts` (empty, apply and
announce, conflict and retry, refused, isolation, `openedBy`, a broken stored document), `apps/core/src/workspace.e2e.test.ts` (RPC and
the feed record), `service.test.ts` (the view on the heartbeat), `packages/client/src/presence.test.ts` (the view reader),
`consent-effects.test.ts` (consent effect per call: none unless params name a destination), `workspace-tool.test.ts` (open by keith, singletons, a new desktop and a held show, no screen, ask first, the per-minute cap, the undo,
`look`, the "On screen now" line), and the P40.3 case of `workspace.e2e.test.ts` (a scripted turn opens and shows a window, the
reminder line, the held ack, the events, `undoKeith` and `nothing-to-undo`); P40.5: `web-apps.test.ts` (fallback, ids, the SPA view,
permission, the tool line, params, `checkAppOps`), the plugin-app cases of `workspace-tool.test.ts` (a new desktop with parsed params,
a second window, params moving the same window, refusals and the person's own apply), and the P40.5 case of `workspace.e2e.test.ts`
(`workspace.apps` from the plugin `web`, `unknown-app`, `bad-params`).
