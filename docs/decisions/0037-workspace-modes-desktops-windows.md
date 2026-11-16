# 0037. Workspace: modes, desktops and windows that Keith can drive

Status: Proposed (2026-11-15). Plan: `docs/plans/active/P40-workspace.md`. Concept with mockups: the "Keith Workspace" artifact
(owner's gallery). Amends ADR-0035 §1 (the core side of the web client's workspace is the plugin `web`, ADR-0038) and §7 (plugin code
may run in the browser, sandboxed, ADR-0038). Builds on ADR-0023 §5 (clients are nodes for a person), ADR-0025 (presence), ADR-0033
(client context), ADR-0034 (reach, hold) and ADR-0036 (consent).

## Context

The web client is being redesigned around one full-screen page: the voice orb as the background and HUD panels floating over it (the
"stage", `docs/specs/web.md`). The owner wants the web client to work like Jarvis: Keith can open, arrange and show things on the
person's screen, for example a map when the person asks where a city is. The old screens (chat, tasks, nodes, memory, budget, inbox,
rooms) are switched off during the redesign and need a new home.

Keith can already ask a client to do something: the client capability registry has `open.view`, and `client_call` routes a call to the
person's active client and waits for an ack (`docs/specs/parietal.md`). It cannot see what is on the person's screen, and nothing on
the screen persists outside the browser tab.

## Decision

1. **Three modes in the web client.** *Ambient*: the stage (orb as layer 0, HUD panels left and right). *Workspace*: desktops holding
   windows; the orb shrinks into the dock and pulses while Keith speaks, with a subtitle above the dock. *Overview*: every desktop at
   once (choose, add, close). The mode is view state of one client (item 4).
2. **One workspace per person.** A workspace holds at most 6 desktops; a desktop has a name, an order, a layout (`focus`, `split`,
   `stack`, `grid`, `free`) and at most 12 windows. A window is an app id (`<plugin>:<app>`, ADR-0038), its params (validated by the
   app's schema, at most 4 KB), a title, a slot in the layout (or a normalised rect `0..1` when the layout is `free`), a state
   (`normal`, `min`, `max`), a z order and `openedBy: person | keith`. A window points at data (`docId`, a place); it never copies it,
   and the data is read with the viewer's rights (ADR-0015).
3. **The core keeps the workspace document.** One versioned document per person in the core (table `workspaces`: person id, version,
   document as JSON validated by zod on write and read). Every change is a small operation (`desktop.add`, `desktop.rename`,
   `desktop.remove`, `desktop.reorder`, `desktop.layout`, `window.open`, `window.close`, `window.move`, `window.focus`,
   `window.setState`, `window.setParams`, `window.toDesktop`) applied with the base version: `apply(baseVersion, ops)` answers the new
   version or a conflict, and the caller fetches the newest document and applies again. Each applied change is broadcast on the person's
   activity feed as `workspace-changed { version, ops, by, clientId? }`; a client drops its own echo and refetches on resync. The
   document survives a reload, follows the person to every device and is what Keith reads.
4. **Each client keeps its view.** Pixels, drag in progress, animation, hover and scroll stay in the client; a drag sends one
   `window.move` at its end. What a client shows (`mode`, `desktopId`, `focusWindowId`) is reported to presence, throttled, as that
   client's view: two devices may show different desktops of the same workspace. The phone renders the same document as swipeable
   desktops and full-screen cards, not floating windows.
5. **Keith reads the screen in its reminder.** The front agent's turn reminder gets one line for the person's active client: "On screen
   now: <client>, <mode>, desktop <name>, focused <title>, open: <titles>" (titles only, capped, cleaned as data, never in the system
   prompt). No line when no client that renders a workspace is online.
6. **Two paths for Keith.** *Changing the content* is the tool `workspace` (look, open, close, arrange, move, set params, add or rename a
   desktop): it applies operations to the document with `by: keith`, works with no client online and is audited. *Changing what the
   person sees* is a new client capability `workspace.show` (switch desktop, focus a window, open overview), routed by `callClient` to
   the active client with the 10-second ack, exactly like `open.view`. A client renders windows only when it declares the rendering id
   `render.workspace`; the TUI does not, so Keith answers in text there and opens no window.
7. **Keith's manners on the screen are code, not prompt.** Free: open, arrange and move windows; close windows it opened; add a desktop
   while under the limit. Asked first: `workspace.show` when the person did not ask for it in this turn; closing or moving a window the
   person opened; removing a desktop that holds the person's windows. `workspace.show` unasked is allowed only while presence is active
   and the person is not typing; otherwise the client holds it as a chip in the dock ("Keith · 1 waiting") that the person opens (the
   hold of ADR-0034). Never: another person's workspace (the owner reads a member's only through the audited path), or a risky app
   without the approval of ADR-0036. Limits: 20 Keith operations a minute per person; every Keith operation is audited, emits
   `brain.parietal.workspace` and can be undone from the dock.
8. **Windows are laid out by presets first.** Keith arranges by meaning ("next to the chat", "focus on this"), so a desktop uses a
   layout preset with named slots; dragging a window switches that desktop to `free`. The old screens become apps of the plugin `web`
   (chat, tasks, nodes, memory, budget, inbox, rooms, brain) and run natively in the SPA; plugin terminal views become the app
   `web:tui`.
9. **Ambient panels are not windows.** The HUD panels of the stage (brain, today) are widgets of the ambient mode: Keith does not drive
   them and they are not in the workspace document. Their expanded state stays a per-browser convenience.

## Alternatives rejected

- **Workspace state only in the browser.** Keith could not read or change it, it would not follow the person to another device, and a
  reload would lose it.
- **One workspace per device.** The person would see different content on the laptop and the phone, and Keith would have to pick a
  device for every open. The view (item 4) is per device instead.
- **Event sourcing with a full operation log.** A versioned document plus small operations is enough for one person's screen; the audit
  keeps Keith's operations, and undo uses the inverse operation.
- **Free floating windows as the default.** Keith would have to compute pixels for every screen size; presets keep its arrangements
  stable and readable.

## Consequences

- New contracts (workspace document, operations, `workspace-changed`, client view), a migration (`workspaces`), a capability
  (`workspace.show`), a rendering id (`render.workspace`), a reminder line and an audit kind.
- The plugin `web` (ADR-0038) needs two core services from the platform: presence (client views, active client) and the client route.
- The legacy screens of the web client return as windows; the redesign's `LEGACY_SCREENS` switch is removed when the last one has an
  app.
- The TUI gains nothing visible at first; a text list (`/workspace`) is a later choice.
- Revisit when shared rooms (ADR-0026) want a shared desktop, or when a second client kind renders a workspace.

## Note (2026-11-16): Keith shows what it opens

In use, "asked first: `workspace.show` when the person did not ask for it" left the owner on the orb while Keith opened a map out of
sight. Amended item 7: `open`, `focus` and `params` bring the screen to that window by default (`show: false` prepares quietly), and
`show` can send the screen back to the orb. The guard that keeps the screen from jumping stays in the client: while the person types or
the tab is hidden, a desktop or the overview is held as a chip (going back to the orb is never held). Keith may also remove a desktop;
one that holds windows the person opened still needs their agreement, and the last desktop stays. In the web app the workspace floats
over the orb (dimmed, blurred backdrop) instead of replacing it, and a view change is reported at once. Specs: `workspace.md`
("Keith", "Client view"), `web.md` ("Workspace").
