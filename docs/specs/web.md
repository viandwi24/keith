# Web client

Code: `apps/web/src` (`routes/`, `lib/features/<feature>/`). Decision: `docs/decisions/0035-web-client.md`. Plan: `docs/plans/active/P38-web-client.md`.
The browser client of Keith: a SvelteKit 3 single-page app (Svelte 5 runes, `adapter-static`, fallback `200.html`, `ssr = false`) that the
core serves at `/app` on its own origin. It reaches the core only through `@keith/client/browser`, takes types only from `@keith/contracts`
and the look only from `@keith/ui/tokens`. State today: W6 (sign-in, shell, chat, approvals, Inbox, step-up, Home with the orb, command palette, inspector, presence, and the screens: Tasks, Nodes, Budget, Presence, Brain, Me and Memory, Rooms, Help), W8 (plugin views as the terminal grid, the guest page) and the web side of W9 (PWA, Web Push subscription). Manage is W7.

## Routes (base `/app`)

| Route | Screen |
| --- | --- |
| `/app/login` | Sign in (`?next=<path>` is where to go after it) |
| `/app/` | Home: the orb, brain wave, subtitle, quick ask, summary cards (see "Home") |
| `/app/chat` | Chat with the front session (W3) |
| `/app/chat/history` | Earlier conversations; `?g=<n>` opens one read only |
| `/app/tasks`, `/app/tasks/<id>` | Tasks and one task (see "Screens") |
| `/app/nodes`, `/app/budget`, `/app/presence`, `/app/brain` | Nodes, Budget, Presence, Brain |
| `/app/me`, `/app/me/memory` | Me (style, persona) and Memory (dreaming) |
| `/app/rooms`, `/app/rooms/<id>` | Rooms and one room |
| `/app/help` | Help |
| `/app/inbox` | Inbox (approvals) |
| `/app/manage` | Manage: the sections this person may open (see "Manage") |
| `/app/manage/<section>` | One Manage section (a table, its actions and drawers) |
| `/app/manage/logs`, `/logs/<session>`, `/logs/<session>/<call>`, `/logs/<session>/<call>/raw` | The four Logs levels |
| `/app/apps` | Apps: the plugin views this person may open (see "Apps") |
| `/app/apps/<plugin>/<view>` | One plugin view as a terminal grid (view id `<plugin>.<view>`) |
| `/app/guest` | The guest chat (served by the guest listener, not the owner's app; see "Guest") |
| `/app/more` | The phone's list of every destination |

`src/routes/+layout.svelte` is the **session gate**; `src/routes/(app)/+layout.svelte` mounts the shell, the connection monitor and the
privacy notice. Routes are thin: they compose feature components.

## Features (`src/lib/features/<feature>/`, public through `index.ts`)

| Feature | Holds |
| --- | --- |
| `session` | The one client (`getClient()`: `createKeithClient({ auth: 'cookie' })`), `session` state (`loading`, `signed-in`, `signed-out`, `error`; `me` is `auth.whoami`), `gateAction`, `loginUrl`/`safeNext`/`afterSignIn`, `appBase()` |
| `login` | The sign-in screen: identify, method tabs, device code, throttle countdown, LAN warning, remember checkbox |
| `shell` | Colour tokens as CSS, theme override and `theme` state (the theme on screen), `motion` (still orb), nav model, top bar (palette button), rail, tab bar, avatar menu, placeholder; the inspector arrives as a snippet from the layout |
| `live` | The activity feed as state (`live`: brain state and lamps, the brain trace, tasks, nodes, budget) and the pure view models (`lampRows`, `budgetBar`, `nodeRows`, `taskRows`, `summaryCards`) |
| `manage` | Manage: the section list and shell, `SectionStore` (the shared model read through the client), `ActionFlow` (forms, confirmations, notes), the table, drawer and dialogs, the provider form, the Logs levels and charts |
| `home` | The orb and brain-wave canvases, subtitle, caption, quick ask, summary cards, `orbState` |
| `inspector` | The right column and the drawer |
| `palette` | The command palette: item model, filter, key model, actions |
| `presence` | Presence kind `web`: leader election, the reporter, `notify` and `open.view`, the notification opt-in |
| `connection` | The connection monitor (`watchConnection`) as state, the pill, the offline banner with Retry |
| `toasts` | The toast queue and stack |
| `chat` | The conversation: controller, Markdown, tool cards, composer, history (see "Chat") |
| `tasks`, `nodes`, `budget`, `brain`, `me`, `rooms`, `help` | The screens of "Screens"; each is a folder with its pure view model (`*-view.ts`, tested), its store when it needs one and its Svelte parts |
| `confirm` | `ConfirmButton`: a button that asks before it acts (inline question, confirm and cancel) |
| `tasks`, `nodes`, `budget`, `brain`, `me`, `rooms`, `help` | The screens of "Screens"; each is a folder with its pure view model (`*-view.ts`, tested), its store when it needs one and its Svelte parts |
| `confirm` | `ConfirmButton`: a button that asks before it acts (inline question, confirm and cancel) |
| `identity` | The elevated pill, the privacy notice, `remaining` and `initialsOf` |
| `apps` | Apps and the terminal view: `grid.ts`, `runs.ts`, `key-map.ts`, `phase.ts`, `end-text.ts`, `routes.ts` (pure, tested), `ViewSession`, `TerminalView` |
| `guest` | The guest page: `guest-state.ts` (pure, tested), `GuestChat` (runes), `GuestScreen` |
| `push` | Web Push of this browser: `push-model.ts` (pure, tested), `devicePush`, `PushPanel`, `registerServiceWorker` |
| `pwa` | `sw-logic.ts`: the pure part of the service worker (routes, cache name, notification plan), tested |

Pure logic lives in plain `.ts` files with a `.test.ts` beside them (`redirect`, `gate`, `pill`, `elevation`, `toasts`, `nav`, `tokens`,
`login-text`, `sign-in-view`); components stay thin. Reactive state is in `.svelte.ts` classes.

## Auth

The session is the HttpOnly `keith_s` cookie (`docs/specs/auth.md`, "Browser sessions"): the page never holds a credential.

- **Gate.** On load the root layout calls `auth.whoami`. `401` or `UNAUTHORIZED` is signed out and goes to `/app/login?next=<wanted>`; success
  shows the shell; any other failure shows an error with "Try again" and keeps a known person through a blip. A signed-in visit to the login
  screen goes to `next` (only a path under `/app/`, with no `//`, `\`, scheme or control character, and never the login screen) or Home.
- **Sign in.** `createCookieSignIn({ remember: localStorageIdentifierMemory() })` with the page origin as the address (there is no address
  field), so the flow is identifier first, as in the TUI (`docs/specs/tui-login.md`): "Who", then the methods the core offers as tabs (PIN,
  password, device code, token), the fields drawn from the core's step description. A throttled answer disables the button and counts
  down (`retryAfter`). "Remember this device for 30 days" is off by default and shown only when `canRememberDevice()` is true. The LAN
  warning (`plain HTTP on this network: …`) shows next to a secret when the core sees a `lan` client or the page is plain HTTP off loopback
  (`isPlainLan`). Socket-only flows (unlock, first owner) do not exist here: when no method is usable or the core cannot be asked, the
  screen says to run `keith-core setup` on the core machine.
- **Sign out.** The avatar menu calls `logout()` (`POST /auth/web/logout`), shows a `signed out` toast and goes to `/app/login`.
- **Elevated.** The top bar shows `elevated m:ss` from `whoami.elevatedUntil`, ticking each second, and nothing once it ends. After a step-up the page reads `auth.whoami` again, so the countdown starts from the core's `elevatedUntil`.
- **Privacy notice.** After sign-in the shell asks `admin.audit.notice.get`; an unseen notice opens a dialog "Your privacy" and "Got it" calls
  `admin.audit.notice.ack`. Any failure counts as seen: the notice never blocks the app (same rule as the TUI).

## Connection and toasts

The shell starts `watchConnection(client)` and the activity feed; the top bar pill reads `connecting`, `live`, `reconnecting`, `offline` or
`logged out` (glyphs `◐ ● ◐ ✕ !`, tones muted, success, warning, danger, danger). While `disconnected` or `reconnecting` an offline banner
says `cannot reach the core (<reason>)`, a retry countdown and a Retry button (`retryNow`, once per 3 s). A `logged-out` link ends the
session and the gate goes to sign-in. Toasts follow the TUI (tui-design 5.20): at most three, newest last, 5 s by default, glyphs `· ✓ ! ✕`
for info, success, warning, error, top right under the bar; text is always plain text. Texts so far: `signed in as <name>`, `signed out`.

## Tokens and look

`@keith/ui/tokens` (`packages/ui/src/tokens.ts`: `DARK`, `LIGHT`, `PALETTES`, `G`, no Ink or React) is the source. At startup
`features/shell/tokens.ts` writes `--k-<token>` custom properties: dark by default, light under `prefers-color-scheme: light`, and
`data-theme="dark|light"` on `<html>` wins over the media query (the avatar menu offers system, dark, light; remembered in `localStorage`
with a guarded access). `src/app.css` derives surfaces and borders from those tokens and holds no colour literal. Text is system UI (the
core's CSP allows no external font), codes and glyphs use the system mono stack. Focus rings are visible, `prefers-reduced-motion` removes
animation, and menus, dialogs and tabs come from `bits-ui` (headless; styled by the app's CSS).

`@keith/ui/orb` (`packages/ui/src/orb/index.ts`) is the orb model for a browser: `Orb` (particles and modes), `BrainTrace`, `orbPaletteOf` (the
same colours as the terminal, from the tokens), the typewriter steps and a word wrap that takes its width function (`wordWrapWith`, with
`pureCells` for the browser). It imports no Bun API, `node:`, Ink or React (`orb-subpath.test.ts` walks the import graph); the terminal-only
ANSI width helpers live in `orb/ansi-width.ts`.

## Chat

`features/chat`; routes `/app/chat` and `/app/chat/history`. The shared logic (items from messages, tool lines, notices, slash forms, the
context-pending state, history rows, dream dividers, question state) is `@keith/app-model` (`docs/specs/app-model.md`); the web adds only
rendering and the browser state.

- **The person's words inside a turn.** A `data-eh.input` part with `source: 'user'` (an approval note such as "ya" to the front agent's own pending call, or a steer) is a user bubble at its position: `toItems` splits the assistant message around it (question, tool card, the person's bubble, continuation). Other sources are not rendered. `MessageRows` needs no special case (`message-split.test.ts`).

- **Session.** `ChatController` (`chat.svelte.ts`, runes) reads the person's current generation (`chatContext.generations`, again on
  `chat.context.changed` and on resync) and binds `client.chat(frontSessionOf(personId, generation), { notify })` to `Chat` from
  `@ai-sdk/svelte` (`session.chatInit`, `bind`, `init`). A new generation rebinds. The session's `busy`, the chat status and the time of
  the last visible change give the phase `idle | thinking | streaming | stalled` (`status.ts`; 20 s without progress is `stalled`).
  While a turn runs an effect calls `session.checkStalled()` every 3 s. A refused send (409) puts the text back in the draft with a warning
  line; a `/compact` that ended re-reads the messages so its divider shows.
- **Rendering.** No `{@html}` anywhere. `@keith/ui/markdown` parses (headings, lists, tables, quotes, fences, bold, code, links);
  `markdown-nodes.ts` builds a node tree and Svelte components draw elements. A link is followed only for `http`, `https` and `mailto`
  (`target="_blank" rel="noopener noreferrer"`); any other scheme shows as text. Code blocks have a copy button; there is no syntax
  highlighting yet. A tool call is a collapsible card: glyph, name, the TUI summary line (`toolLineOf`), state, input and output as JSON in a
  `<pre>`, and "Load full" when the core clipped a payload (`session.loadFull`). A delegation links to `/app/tasks/<id>` when the task is on
  the board. `eh.notice` rows, `/compact` and dream dividers, dream running line, context-pending line and ask-tool question cards (option
  buttons and a free-text answer through `protocols.answer`) follow the TUI. An interrupted turn shows its notice with Continue and Retry.
- **Composer.** A textarea that grows: Enter sends, Shift+Enter is a new line (not during IME composition), Esc closes the menu, then stops a
  running turn (also from anywhere on the page); a Stop button replaces Send while a turn runs. Typing `/` opens the command menu (Tab
  or Enter picks, arrows move): `/new [--no-flush]`, `/compact`, `/history`, `/tasks`, `/manage`, `/whoami`, `/continue`, `/retry`,
  `/help`. TUI-only commands are not offered; an unknown command is never sent to the agent. A plain message waits (kept in the
  draft) while a `/new` or `/compact` runs. The composer is disabled while the link to the core is down.
- **Scrolling.** The messages sit in a column of at most 760 px; the composer is pinned under them (above the phone tab bar). New content follows
  only when the view is at the bottom (48 px slack) or after a send; otherwise "Jump to latest" shows. Scrolling to the top reads older
  messages (`loadOlder`) and keeps the view on the same message.
- **History.** `/app/chat/history` lists the generations (`historyRowsOf`); a past one opens read only from `sessions.messages` with
  the same rendering and paging; the running one links to the chat.
- **Tests.** `markdown-nodes`, `status`, `scroll`, `slash`, `composer-keys` and `tone` as pure `.test.ts` files.

## Approvals and step-up

`features/approvals`, `features/stepup`. The logic is shared (`docs/specs/app-model.md`: `approval-state`, `step-up-state`, `step-up-controller`);
the web adds `card.ts` (the card model) and the Svelte parts.

- **Feed.** The `(app)` layout starts one store (`approvals`) over `client.attention()`, which is already attached to the activity feed, so events
  and resyncs refetch it. Items are the approvals only (`approvalsOf`), oldest first. `answerable` leaves out a member's own request that waits for
  the owner (`extra.waitingFor === 'owner'`).
- **Card.** `cardOf(item, now)`: the sentence (`askOf`), the tool or capability, the node, the whole command in monospace (never clipped), a
  `desktop.input` call as one row per action in words, any other input as clipped JSON, `task  <description>`, `asked 3 h ago` and a live
  `expires in m:ss` (`h mm` over an hour, `expired` at the end; the line is amber two hours before the expiry). Buttons: Allow once, Allow for task
  (only when `extra.scopable`: the core drops a grant on a member's request), Deny, Deny with reason (an inline field; Enter or the Deny button
  sends, Esc cancels). A member's own request shows `Waiting for the owner to approve` and no buttons.
- **Consent routes (ADR-0036 §7).** `routeOf` (app-model) classifies each item from `extra.consent`. `ApprovalBar` pins a card above the composer only
  for `legacy` items (an old core, no field), the old behaviour. Every other request has no card in the chat: `ConsentLine` (`lineView`, `consent-line.ts`) draws one
  quiet line above the composer, `Keith is waiting for your yes or no · <summary> · expires in m:ss` with a `details` link to its Inbox card
  (`/inbox#approval-<id>`), or `Confirm in the Inbox · <summary>` for a `device` or another person's request; typing and sending a message answers a
  `conversation` request. A request for the Inbox also raises the toast `Confirm in the Inbox` with an `Open the Inbox` link, once each. The Inbox
  keeps the card with its buttons for all of them (a `conversation` card says Keith also asked in the chat and has no single-key shortcuts). The card
  headline is the human phrase of the tool (`actionOf`); `Allow for task` is hidden for persona, model, style and status tools and for every
  `conversation` request (`offersTaskGrant`).
- **Placement.** (Old core) the oldest answerable `legacy` approval is pinned above the chat composer with `N more waiting in the Inbox` when others wait.
  `/app/inbox` lists every pending approval (other kinds join later). The Inbox item is built; the rail and the phone tab bar show the count
  (`inboxBadge`: nothing at zero, `99+` above 99).
- **Keys.** Never a page-wide shortcut. A card is focusable (Tab); only when the card element itself is the focused target do `y` allow, `n` deny,
  `N` deny with a reason and `a` allow for the task (scopable only) answer. A text field (the composer, the reason field), a modifier key, a busy or
  read-only card answer nothing (`cardKeyAction`, `isTypingTarget`). This is the TUI's rule (the bar takes keys only after Tab).
- **Answering.** Every answer runs through `stepUp.guard`. A remote client's shell approval or a `STEP_UP_TOOLS` approval is refused by the core with
  `KEITH_STEP_UP_REQUIRED`; the web does not decide that itself (the TUI does not either): the dialog opens and the answer is sent once more.
- **Toasts.** `allowed`, `allowed for the task`, `denied` (success) after an answer; `request expired` (warning, once per approval, when it passes
  `extra.expiresAt` while on screen; the core denies it at its next sweep); failures with the TUI's texts: `Failed to answer: <message>` and
  `Waiting for the owner to approve` (`KEITH_WAITING_FOR_OWNER`).
- **Step-up dialog.** `StepUpDialog` (bits-ui Dialog; a bottom sheet under 640 px) titled `Confirm it's you`, with PIN and Password tabs, a masked field,
  inline danger text (`Wrong PIN or password.`, `Too many attempts. Try again in N s.`, the core's texts) and Cancel. `stepUp.guard(fn)` runs `fn`;
  on `KEITH_STEP_UP_REQUIRED` it opens the dialog, calls the browser client's `stepUp` (cookie mode: `rotate` and `deliver: 'cookie'`, the core
  sets the new cookie) and runs `fn` once more; a second refusal is the caller's error; cancel rejects with `StepUpCancelled`. Several waiting
  actions share one dialog. A PIN session cannot confirm with its PIN (`403 pin_session_cannot_step_up`): the dialog shows the core's text
  (`StepUpError` reason `pin_session`) and switches to Password. No PIN or password set, or an old token, is a dead end with only Close.
- **Tests.** `consent-line.test.ts` (the quiet line, its link, the toast, the consent card), `card.test.ts` (card model, countdown, key policy with a text field, expiry, texts, badge); the guard, cancel and PIN-session cases in
  `packages/app-model/src/step-up-controller.test.ts`.

## Home

`features/home`, route `/app/`. One screen, top to bottom: a greeting, the orb, the brain wave, the subtitle and caption slot, the quick ask,
four summary cards.

- **Orb.** `OrbCanvas` draws the `@keith/ui/orb` model on a `<canvas>` (particles grouped by brightness into nine opacity steps, colours from
  `orbPaletteOf(theme.name)`, so the light and dark themes follow the tokens). The mode comes from the signals the TUI reads
  (`orbModeFor`, `orb-signals.ts`, on top of app-model's `orbModeOf`): alert when the link is down or logged out **or an approval waits
  for an answer** (the web's addition), else speaking (a turn runs and the answer streams), thinking (a turn runs), listening (a draft
  is waiting), idle. It runs at most 30 frames a second on `requestAnimationFrame`, stops while the tab is hidden and skips a canvas
  that is not displayed. With the **still orb** setting (avatar menu, `localStorage` `keith.stillOrb`, guarded) or
  `prefers-reduced-motion` it draws one fixed frame in the colour of the mode and runs no loop (`orbIsStill`).
- **Brain wave.** `TraceCanvas` draws the newest samples of a `BrainTrace` as bars mirrored around the middle line. `live` fires the trace
  from every brain event (`regionOf`, `strengthOf`); Home steps it each frame, and while Home is not mounted a 100 ms timer keeps it
  decaying.
- **Subtitle.** The plain words (`plainText`) of the newest assistant message, typed out (`advanceShown`, `retargetShown`) in two reserved
  rows wrapped for the width, held for 8 s after the turn (`SUBTITLE_HOLD_MS`) and then cleared. A reply that was there when Home opened is
  not new and stays quiet (`subtitleOf`, `baseline`).
- **Caption.** One slot under the subtitle (`captionOf`): signed out (links to sign-in) or core down (danger), approvals waiting (links
  to the Inbox), `dreaming…` while no turn runs. The room banner (`bannerOf`, from the `rooms` store; links to the room, after the alerts and before `dreaming…`) takes the slot; the heir's line has no web source yet. An open invitation is a notice above the quick ask (`InviteNotice`: who invites, Accept, Decline).
- **Quick ask.** A field that is the front chat's own draft (`frontChat.ctl.draft`): Enter sends, a slash command works as in the chat,
  Esc or Stop ends a running turn, a failed send or a command's notice shows under it, and "Open chat" links to `/app/chat`. The chat
  controller is **one per app** (`chat/front.svelte.ts`, started by the layout): the chat page, Home and the orb read the same turn.
- **Cards.** Tasks (running of the board, `/tasks`), Nodes (online of paired, `/nodes`), Budget (percent of the limit, tone from 80 %,
  `/budget`), Approvals (waiting, `/inbox`): `summaryCards`.

## Manage

`features/manage`, routes `(app)/manage/` (`+layout` is the shell, `+page` the index, `[section]/+page` a table section, `logs/[...rest]/+page` the Logs
levels). The logic is `@keith/app-model/manage` (docs/specs/app-model.md): the web draws what the TUI's Manage draws and calls the same
`client.rpc.*` procedures; there is no web-only server call.

- **Who sees what.** `sectionsFor(me)` keeps the sections whose read capability `whoami` lists (`visibleSections` of app-model), so a member has
  no People, Groups, Plugins, Reviews, Persona, Access or Succession, exactly as in the TUI. A hidden section opened by URL says "Your role does
  not include it" and loads nothing; the server stays the authority on every call.
- **Layout.** A wide screen has a section list at the left and the section at the right; a phone has list (`/manage`), then the section (a
  "‹ Manage" link back), then a drawer for one row. The index lists the sections with one line each.
- **A table section.** `SectionStore` reads the section's model (`load`, then `build`) and keeps the last good rows when a read fails. The
  screen shows the info lines (label and value), a sortable, searchable table (`table.ts`: words match cells and detail; a column with 2 to 30
  repeated values, not the first, gets a filter select; numbers sort as numbers; a phone shows each row as a labelled card), the section's actions
  as buttons and Reload. A row opens a drawer (cells, detail, its actions). Audit reads 500 events and its EVENT, ACTOR and VIA columns are the
  filters; People filters on role and status.
- **Actions.** `ActionFlow` follows the TUI's dialog state: an action with no fields or confirmation runs at once; fields open a form drawn
  from the `FieldSpec`s (a select for `options`, a text area for `multiline`, a hidden input for `secret`; a required field shows its problem after
  it was left or the form was submitted); a destructive action asks first, and when the action names a word (transfer ownership) the button stays
  off until it is typed. Every call goes through `stepUp.guard`; a cancelled step-up reads "Not confirmed.". The secrets leave the form's state when it
  is sent. A result message is a toast; a note (plugin details, a review request) is a dialog. A token or pairing code (`once`) is shown one time with a
  Copy button and is dropped from state when the dialog closes. The rows are read again after every action, a failed one included.
- **Providers.** The add-connection form is drawn from `providers.describe` (`providerFieldSpecs`: auth, endpoint, then advanced; a hidden input for a
  secret, a select for an enum or a boolean; record, array and JSON settings stay with `keith-core`), validated inline (`missingSetting`,
  `providerSettings`), sent with `providers.put` through the guard, then tested.
- **Logs.** The level is in the URL (`parseLogsRoute`, `logsHref`): sessions (filter by id start, kind, the owner's audited "everyone" scope, paging
  with `LogsState`), one session (the fact lines of the TUI, two inline SVG bar charts, tokens in and out and cost per generation, each bar a link,
  and the generations with the `↓` low-cache mark), one generation (`callLines`) and its raw request and response JSON (pretty-printed, copy buttons,
  the truncation and "bodies off" notes). A level that is gone (`NOT_FOUND`) says so.
- **Not shown.** Logs settings, retention and purge (the TUI has none either), editing a provider connection's settings after it was added.

## Command palette

`features/palette`. ⌘K or Ctrl+K opens and closes it from anywhere, a text field included; the top bar button does the same. No other
key is a page-level shortcut. `bits-ui` Dialog around a filter field and a listbox (`role=combobox`, `aria-activedescendant`). The model
(`model.ts`, pure): `paletteItems` lists **Go to** (the nav), **Actions** (new conversation `/new`, compact `/compact`, switch theme, still
orb, desktop notifications, step up, sign out) and the TUI's two-level menu from app-model's `menuTree` as sections (People & access, Apps,
Models & budget, System, Menu; a person gets the Manage sections their capabilities show (`sectionsFor`, as in the TUI), a member only System and Help; a Manage entry opens `/manage/<section>`);
`filterItems` needs every word to match (label start, word start, label, then group and keywords; ties keep the list order);
`paletteKeyAction` maps ArrowUp/Down and Ctrl+N/P to moving (wrapping), Enter to run and Esc to close, and ignores keys during IME
composition. `/new`, `/compact` and Help run the chat controller's slash form with the draft put back, then open the chat.

## Inspector

`features/inspector`: the right column from 1100 px, the drawer (top bar button) below it, nothing under 640 px. A mini orb with the mode
word; the **eleven region lamps** (`lampRows`: lit, working or idle from brain events and the fade, `cortex ×n` for running workers,
`amygdala ×n` for approvals that wait); running tasks with their status; nodes online and offline; the budget bar with the `! over 80% of
the limit` / `! limit reached` line; the pending approvals count linking to the Inbox. All of it is `live`: listeners are added, then the
feed starts (the feed sends no history), and every resync reads tasks, nodes and the budget again; a poll refreshes the budget each minute.
The layout passes the inspector to the shell as a snippet, so the shell imports neither Home nor the live data.

## Presence

`features/presence`. The tab reports as client kind `web` through `createPresenceReporter` of `@keith/client/browser`
(`detectBrowserEnvironment()`, `WEB_CAPABILITIES`, `localStorageClientIdStore()`: one browser profile is one client).

- **One tab reports.** `electLeader` takes the lock `keith.presence` through the Web Locks API (the tab that holds it leads; the browser
  hands it on when that tab closes). Without Web Locks a BroadcastChannel election runs (`election.ts`, a pure state machine: claim after
  600 ms of silence, a beat every tick, lowest id wins a tie, a silent leader is replaced after 5 s, a leaving leader resigns). A tab that does
  not report forwards its input to the one that does (channel `keith.presence.touch`).
- **Touch.** `pointerdown`, `keydown`, `wheel` and `touchstart` call `touch()` at most once a second (`shouldTouch`), so the heartbeat says
  `active`.
- **Goodbye.** On `pagehide` the reporter stops and sends `presence.clients.goodbye`; the browser client's `fetch` marks that one request
  `keepalive` (`session/keepalive.ts`) so it still leaves while the page unloads. A page restored from the back-forward cache takes part again.
- **`notify`.** Always a toast; when the tab is hidden **and** the person turned notifications on **and** the browser allows them, also a
  system `Notification` (`decideNotify`). The toggle is in the avatar menu and the palette; `Notification.requestPermission()` runs only
  from that click, and a blocked browser is told so. The choice is `localStorage` `keith.notify` (guarded).
- **`open.view`.** `tasks` opens `/tasks`, `protocols` opens `/manage/protocols`, `room:<id>` opens `/rooms/<id>`, `plugin:<id>:<view>` opens `/apps/<id>/<view>` when the
  view is in the person's menu (`viewMenu()`; a view they may not open is as unknown as any other name); anything else is acked `unsupported` (`UnsupportedDelivery`).

## Screens

Each screen takes the TUI's texts and shows more: tables, filters, details. Pure rows live in `*-view.ts` next to a `.test.ts`; the logic both clients share is
`@keith/app-model` (`docs/specs/app-model.md`). A write that the core may answer with `KEITH_STEP_UP_REQUIRED` runs through `stepUp.guard`.

- **Tasks** (`/tasks`, `/tasks/<id>`). `taskBoard` reads `tasks.list` (50) and merges `task-changed` events, read again on a resync. Filters All, Running, Done,
  Failed (failed, timed out), Stopped (stopped, interrupted) with counts; running first, then newest. Columns: status, agent (without `cortex.`), task, time
  (counting up while it runs). The detail has the agent, status, steps, the task text, the result as Markdown or `No result yet.` / `No summary.`, the
  `Failed: ` line, the times and the parent session. Stop is a two step button (`Stop this task?`), through the step-up guard; toasts `Task stopped.`,
  `Failed to stop: <message>`, `Not confirmed.`.
- **Nodes** (`/nodes`). The `live` node list (feed events) as a table: status, name, platform, version, last seen, shell policy (`shell allowed` / `shell off`),
  one line per driver (`desktop 0.1.0 · screenshot input`) and `refused: <id> (<reason>)` lines. A member gets no node events, so the page reads the list
  again every 30 s while open (the TUI's rule). Pairing and revoking stay on the core machine.
- **Budget** (`/budget`). The owner sees the global limit rows and a person table; a member sees `Your cap`, spent, remaining (`set by the owner`). A bar
  with the percent, the `! over 80% of the limit` / `! limit reached` line, the reserved amount, models without a price, and for the owner an SVG bar
  chart per person (`role=img`, a label with spend, cap and share; a tick marks the cap) beside the same numbers as a table.
- **Presence** (`/presence`). `presence.mine`, read again on `brain.parietal.presence` and a resync: the state line with the where hint, the stated status,
  the clients (state, kind, name, where it runs and the network, last seen, last active) and a select of the level (`none`, `state`, `detail`) per audience
  through `presence.disclosure.set`. The status form sends `presence.setStatus`: busy or out, a note (200 characters), a start (now or a time) and an end
  (after N minutes up to 24 h, a time, or none); Clear sends `busy: false`.
- **Brain** (`/brain`). The eleven region lamps large (`lampRows`, lit, working, idle; the cortex counts workers, the amygdala counts approvals), the last
  event or `dreaming…`, and the trace (`/brain trace`) as a table, newest first, filterable by region.
- **Me** (`/me`). The style form with the TUI's checks (`persona.style.get` and `set`: address through `checkAddress`, language, brevity, formality, up to five gentle
  topics; only changed fields are sent). The owner also sees the persona (template and version, every field and the two fixed lines) and a template switch through
  the step-up guard; editing the fields is Manage's Persona section. **Memory** (`/me/memory`): the dreaming mode, last run, next run, Dream now, Undo, the staged plan
  with its entries and expiry and Apply, and the latest diary, all through `client.dreaming` (Apply and Undo ask first; refusals are the TUI's plain words).
- **Rooms** (`/rooms`, `/rooms/<id>`). The `rooms` store (started by the layout) reads `rooms.list` on every `room.event` and `brain.corpus-callosum.*` record and on a resync;
  it feeds the Home banner and the invitation notice (a toast once per room). The list has filters All, Active, Invitations, Ended, each room's state, who started it and its
  members, plus Accept and Decline and a form that starts a room (`rooms.start`). A room (`RoomController`: `createRoomView` and `createRoomEvents`, `roomViewOf`) shows the
  members with presence dots, the transcript (Keith's lines as Markdown, joins and leaves as muted lines), the indicator, the one confirmation to answer (`rooms.confirm`),
  the composer (Enter sends, Shift+Enter is a new line; a reply to Keith's last line sets `replyToKeith`), Leave, and for the initiator End room, Remove and Invite.
- **Help** (`/help`). Keyboard shortcuts, the slash commands of the composer, the terminal commands that have a page here, what each screen does and links to the docs.

## Apps (plugin views)

`features/apps`; routes `/apps` and `/apps/<plugin>/<view>`. The core runs the view (`plugin-views.md`); the page draws its terminal grid and sends keys. No plugin
JavaScript runs in the browser, and a frame is never turned into markup (ADR-0035 §7).

- **List.** `/apps` reads `client.viewMenu()` (already filtered by the core) and links each view; a failure says the core may be unreachable.
- **Route.** The view id `<plugin>.<view>` is two path segments, never `notes.list`: the core reads a dot in the last segment as a file name and answers a missing file with
  `404`, not the shell (`thalamus.md`, "Web client"). `viewRoute` and `viewIdOfRoute` (`routes.ts`) convert.
- **Size.** A hidden probe holds 20 `M` in the grid's font; one cell is its width over 20 by its height (`cellOf`). The box is observed (`bind:clientWidth` and
  `clientHeight`) and `gridOf` gives whole cells clamped to the protocol's 20 to 400 columns and 4 to 200 rows. The first known size is the `hello`; a later change is
  `resize` (the client coalesces for 50 ms). Colour depth is 24.
- **Drawing.** `parseFrame` (the client's sanitiser) already left only text and SGR. `rowsOf` turns the runs into rows of spans (neighbours of one style join, an empty line is one blank
  cell); the component writes them as text nodes inside a `<pre>` with a `style` attribute built from validated values (`styleOf`). Colours: `#rrggbb` as is, `ansi256(n)` computed,
  the 16 names mapped to tokens (`red` is `--k-danger`, `green` `--k-success`, `yellow` `--k-warning`, `blue` `--k-accent`, `magenta` `--k-region-wernicke`, `cyan` `--k-info`, `white` `--k-text`,
  `black` `--k-bg`, `blackBright` `--k-text-muted`; a bright name is its plain colour), so a view follows the theme. Bold, italic, underline, strike, dim (opacity) and inverse (swapped, falling back to
  the page colours). A value that is not one of these forms is dropped (`cssColorOf`).
- **Keys.** The grid is a focusable `role="textbox"`; while it has focus a `keydown` is mapped by `keyLikeOf` to the shape `keyBytes` of `@keith/client` reads, so the web sends the
  TUI's bytes (arrows as `ESC [ A`, `alt` as a prefix, `ctrl+letter` as a control code). Not sent, and left to the browser: `ctrl+c` and `ctrl+g` (reserved), the command key,
  lone modifiers, function keys, IME composition; a character typed with AltGr is text and `alt+letter` on a Mac uses the physical key. A paste sends its text (the client splits it and drops
  controls). **Esc hands the keyboard back** to the page (focus moves to the "Apps" link), because the grid takes Tab. A phone's soft keyboard does not drive the grid yet.
- **States.** `reduceView` (`phase.ts`): `connecting` (a "still waiting" line after 400 ms), `open`, `ended` with the reason and `timeout` after 10 s without `ready`. The last frame stays on screen
  under the reason text (`endText`, the TUI's words); "Open again" is offered unless the view was `refused` or `revoked`; "Back to Apps" always. No reconnect, no replay.
- **Tests.** `grid`, `runs` (colours, styles, a hostile frame stays text), `key-map`, `phase`, `routes`.

## Guest

`features/guest`; route `/guest` in the SvelteKit app, served at `/app/guest` by the **guest listener** (`guests.md`, "Guest page"; `thalamus.md`, "The guest listener"), not by the owner's port. It needs no sign-in: the
root layout skips the session gate for that one path (`isGuestPath`) and never calls `auth.whoami`.

- **Client.** `GuestChat` (runes) holds a `createGuestClient({ baseUrl: location.origin, clientKind: 'web' })` from `@keith/client/browser`; the bearer lives in that object, so a reload is a new chat and nothing is stored.
  `open()` on mount, `send`, `stop` (`interrupt`), `leave` (`DELETE`, never when the last message ended the chat: the core ends it with `turn-cap`), `dispose` on `pagehide`.
- **Page.** The banner (`session.notice`, else `GUEST_BANNER`), the watched notice (`The owner is watching this live chat.`), a muted line `19 of 20 messages left  ·  ends in 1 h 58 min` (the core's `x-keith-guest-turns-left`, the expiry
  ticking every 15 s), the conversation (an answer as Markdown through the chat feature's `Markdown`, tool calls as one muted line with their name only, an `error` chunk as an alert), the empty text
  (`Ask about the owner's public notes.`), a composer (Enter sends, Shift+Enter is a new line, Stop while a turn runs) and "End chat". There is no name field: a guest is anonymous and the start body is only `{ clientKind }`.
- **States.** `refusalOf` and `sendFailureOf` (`guest-state.ts`) are the TUI's rules: a busy, capped, rate-limited, unreachable or unavailable start may be tried again; a disabled or zone refusal may not; an ended or invalid chat is over with its
  end text (`GUEST_END_TEXT`), a busy turn is one line and the chat stays usable; the last message shows `This chat reached its message limit.`.
- **Words.** `GUEST_EMPTY`, `WATCHED_TEXT`, `leftText` and `endsText` are copies of the TUI's `guest-text.ts` (an app cannot import another app); a change to one is a change to both.
- **Tests.** `guest-state.test.ts` (streaming, failures, texts), `gate.test.ts` (`isGuestPath`); the serving is `apps/core/src/modules/thalamus/guest-web.e2e.test.ts`.

## PWA

- **Manifest** (`static/manifest.webmanifest`, linked from `app.html` through `%sveltekit.assets%`): name and short name `Keith`, `display: standalone`, `start_url` and `scope` `./` (so `/app/`), icons 192 and 512 (`any`) and a maskable 512, `theme_color` and `background_color`
  the dark `bg` token (`#16181d`; a test keeps them equal to `DARK.bg`). `app.html` also has `theme-color` for dark and light (`DARK.bg`, `LIGHT.bg`), `apple-touch-icon` and the iOS web-app meta tags.
- **Icons** (`static/icons/`): the eight-spoked asterisk (the `✳` mark) in the `accent` token on the dark `bg`, drawn once by a one-off script (supersampled, PNG written by hand); `icon-192`, `icon-512`, `icon-maskable-512` (full bleed, the mark inside the safe zone) and `apple-touch-icon` (180). The generator is not kept.
- **Service worker** (`src/service-worker/index.ts`, SvelteKit's `$app/manifest` and `$app/service-worker`; its own `tsconfig.json` extends `$app/tsconfig/service-worker`, the app's tsconfig excludes the folder and `check-types` also runs `tsc -p` on it). The page registers it
  (`registerServiceWorker`, from the `(app)` layout, scope `/app/`, not in `vite dev`); `serviceWorker.register` is off in the SvelteKit config so the **guest page never registers one**.
  - **Caches the app shell only.** Install precaches `/app/` (the shell page) and every immutable file of the build into the cache `keith-shell-<hash of the file list>` (`cacheNameOf`, so a new build drops the old cache on activate).
  - **`routeOf`.** A request is answered by the worker only when it is a `GET` inside the scope: a precached file is cache first (`asset`), a page load is network first with the cached shell when offline (`navigate`). Everything else is `pass`:
    no API answer is ever stored (`/rpc`, `/auth`, `/sessions`, the feed and the guest API are outside the scope), nothing outside the precache list is put in the cache.
  - **`push`.** `planOf(event.data.text())` builds the notification from `{ title, body, url, tag }` (`push.md`): one clipped line each (title 80, body 200, tag 100), the neutral body `Keith has something for you` when there is no readable body, no data or bad JSON; `url` is kept only
    when it stays inside `/app/` (any other origin or path falls back to the app).
  - **`notificationclick`.** Closes the notification, reuses an open window of the app (`windowToFocus`: navigates it to the target and focuses it) or opens one.
- **Serving.** The core serves `manifest.webmanifest` as `application/manifest+json` and `service-worker.js` as JavaScript, both `no-cache` (an update is seen at the next load); no `Service-Worker-Allowed` is needed because the scope is the file's own folder; the page CSP (`default-src 'self'`) covers the manifest, the worker and the icons (`web-static.e2e.test.ts`).
- **Install.** A browser offers "Install" itself once the manifest and worker are valid; on iOS the person adds the page to the Home Screen from Safari's share sheet.

## Push

`features/push` (the toggle, the devices and the preview switch) over `@keith/client/browser` (`pushPublicKey`, `applicationServerKeyOf`, `subscribePush`, `unsubscribePush`, `listPush`, and `presence.push.preview.get` and `.set`); the core side is `push.md`.

- **Where.** The avatar menu item "Turn on notifications on this device" and the "Notifications on this device" panel of `/presence`. Desktop notifications of a hidden tab (the existing `notify` toggle) are a different, older switch; push reaches the device when no tab is open.
- **Availability** (`availabilityOf`, in this order): `insecure` (not a secure context: push needs HTTPS, or localhost), `needs-install` (iOS and not running from the Home Screen: Web Push there needs iOS 16.4 or later and an installed app), `unsupported` (no service worker, `PushManager` or `Notification`),
  `blocked` (permission denied), else `ready`. The panel says the reason in words (`AVAILABILITY_TEXT`) and always notes the HTTPS and iOS rules.
- **Toggle** (`toggleStep`, a small state machine): off and `ready` subscribes; on unsubscribes (also when the browser has since been blocked); nothing happens while a step runs or when it cannot be turned on.
  Subscribing runs inside the click: `Notification.requestPermission()` first (a refusal is a toast and stops), then `registerServiceWorker()` and `serviceWorker.ready`, `pushPublicKey` -> `applicationServerKeyOf` -> `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
  (an `InvalidStateError` from an older key drops the old subscription and tries once more), then `subscribePush` with the label `<browser> (web)`, the presence client id and the user agent; if the core refuses, the browser subscription is dropped again. Off: `unsubscribePush({ endpoint })` then `subscription.unsubscribe()`.
- **Devices.** `listPush` as rows (`deviceRowsOf`): label, `this device` (the record's `clientId` equals this browser's presence client id; shown first), `added 3 days ago`, `last message 5 min ago` or `no message yet`, a warning for failed sends in a row, and Remove (asks first; removing this device also unsubscribes the browser). The core never returns an endpoint or key.
- **Preview.** "Show message text in notifications" (`push.preview`, off by default) with the note: off, a notification says only that Keith has something for you; on, it shows the start of the message, which anyone who sees the lock screen can read; the push service sees only encrypted data either way.
- **Tests.** `push-model.test.ts` (availability order, the toggle machine, labels, failure sentences, device rows) and `sw-logic.test.ts` (precache list and cache name, `routeOf` for assets, pages, API paths, writes and other origins; payload to notification; click target and window; manifest and `app.html` against the tokens).

## Layout

| Width | Layout |
| --- | --- |
| 1100 px and up | Top bar, collapsible left rail (icons and labels), content, right inspector column |
| 640 to 1099 px | Icon rail; the inspector is a drawer opened from the top bar |
| under 640 px | Bottom tab bar (Home, Chat, Inbox, More); no rail, no inspector |

## Development

`bun run --cwd apps/web dev` serves the app at `http://localhost:5173/app/` and forwards `/health`, `/auth`, `/rpc`, `/sessions`,
`/activity`, `/attention`, `/presence`, `/guest` and `/plugins` (WebSocket) to `http://127.0.0.1:7420`. The proxy rewrites `Host` and `Origin`
to the core's address so the Host and Origin guard accepts the call; the cookie stays on the dev server's host. Start the core separately.

## Tests

`bun test ./apps/web` (pure modules): plugin views (`apps`: cell measure and grid size, frame to spans, key mapping, view phases, routes), the guest page (`guest-state`, `isGuestPath`), push (`push-model`) and the service worker logic (`pwa/sw-logic`); approval card model and key policy, redirect safety, gate decisions, connection pill and offline text, elevation countdown, toast queue,
Manage (sections by capability, table search, facets and sort, the Logs path), nav model, token CSS and theme mode, sign-in texts and view helpers; Home (orb signals, still orb setting, subtitle, caption, orb and trace drawing against a fake canvas), live view models, palette model and keys, presence (election, notify decision, opt-in, view paths, touch throttle) and the keepalive goodbye `fetch`; the screens (task filters and rows, node rows and the member poll rule, budget bars and tones, presence rows and the status form, trace rows, the memory loader and view, persona rows, room rows, invitations and composer keys, help content against the nav). Gate: `bun run --cwd apps/web check-types` and `build`.

## Not built yet

Manage is W7 (another section of this file). A declarative plugin web slot, a soft-keyboard path for the terminal grid and passkey step-up are later (ADR-0035).
