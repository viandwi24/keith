# Client

Code: `packages/client/src` (`client.ts`, `config.ts`, `login.ts`, `socket.ts`, `view/`). Every UI (TUI now, web later) reaches the
core only through this package.

## Public API

`STOP_REASONS`, `NOTICE_CODES` and the types `KnownStopReason`, `NoticeCode` are re-exported from `eharness/codes` (pure constants, no runtime imports). The TUI may not import eharness, so this is its only source for those codes.

`createKeithClient({ baseUrl, token?, fetch? })` returns (`token` is optional: `keith-core` passes none and a `fetch` that adds `{ unix: <socket> }`, so the local socket is the login, `core-cli.md`):

- `harness`: `createHarnessClient` from `eharness/client` against `<baseUrl>/sessions` (chat,
  history, interrupt).
- `rpc`: a typed oRPC client of `keithContract` through `RPCLink` at `<baseUrl>/rpc`.
- `stepUp({ pin } | { password })`: step this client's session up (`POST /auth/step-up` with its own token and base
  URL, see "Password login and step-up"); resolves with `{ elevatedUntil }`, rejects with `StepUpError` (`unauthorized`
  when the client has no token). The TUI calls it from its step-up prompt.
- `viewMenu()` and `openView(options)`: the plugin terminal views this person may open and a connection to one (`parseFrame`, `fetchViewMenu` and `openView` are also exported on their own, with `keyBytes`, `isLeave`, `isHome` and `KeyLike`: the terminal bytes of a key event, shared by the TUI and the web client). `viewMenu` rejects with `ViewMenuError`; both need a token or the `socketPath` option (the local socket upgrades `/plugins/views/ws` as `ws+unix`; a socket whose trust is `none` needs a token, a locked one answers 423). Spec: `plugin-views.md`, "Sanitiser rules" and "Client API".
- `revokeSelf()`: log out. Calls `rpc.auth.logout()`, which revokes the credential this client uses (device, token or legacy); every later call is `401`. A no-op on the local socket. The caller deletes the stored token.
- `audit.mine(input?)`: the lines about this person (`rpc.admin.audit.mine`, every role): `{ limit?, before?, person? }` in, `MyAuditEvent[]` out (newest first; `before` is the id of the last line of the previous page; `person` is the owner showing another person their lines).
- `chat(sessionId)`: required (a person's front session is `frontSessionOf(personId)`, `personId` from
  `rpc.auth.whoami()`); an eharness `ChatSession` for AI SDK `Chat` / `useChat`,
  created with `clip: CHAT_CLIP` (2000: the core clips a tool or data payload over 2000
  characters in a history read, so a big tool history never floods a UI; `session.loadFull(id)`
  fetches one message whole) and attached with `attachChat`.
- `chat(sessionId, { notify? })`: the optional `notify(level, text)` receives the session's toasts (a failed send, a busy core);
  an error one also makes the client check whether the turn runs, as `reportChatNotice` does for a hook-made session. The browser
  entry (`@keith/client/browser`) exports `describeChatError` (eharness) beside the stop and notice codes, for the shared chat logic.
- `attachChat(session)`: keeps a chat session in step with the feed and returns a detach
  function. A session from `chat()` is attached already; call it for one a UI hook created
  (`useChatSession`). It does four things, all through the feed's own options:
  - **busy**: the feed is created with `isBusy`, true while any attached session is `busy`
    (streaming, following, sending or stopping), so the feed pings `/health` about every 5 s and
    notices a dead link while a turn runs.
  - **restart**: on a changed boot id (`onBoot(id, restarted = true)`) the session does
    `refetch()`, then `follow()` when the snapshot (`GET /sessions/:id`) says a turn runs
    (`running` or an active turn).
  - **resync**: on `subscribeResync` (any reason) it does the same. The first `connect` of a session
    that is not loaded yet is skipped (`init()` loads it).
  - **server-started turn**: on `subscribeEvents`, a `turn-started` record of this session
    (`sessionId`; any `kind`: a `wake` after a worker report, an inbox `send`, another tab) makes the
    session call `followServerTurn()` unless it is `busy` (its own send is already read); a
    `turn-ended` record of this session calls `storedElsewhere()` (refetch now, or after the turn this
    chat streams), which brings the stored message, kind messages and notices the turn saved.
    Records of other sessions are ignored. One loop per session: records that arrive while it runs
    only set a flag, so several wakes in a row never start two follows. Detaching unsubscribes.
    Without this a wake message was stored but never shown until the next resync.
  - **failed send**: `reportChatNotice(session, level)` is called from the session's `notify`. On
    `'error'` an attached session recovers: eharness treats a response stream that drops before
    the first words (no assistant message yet) as a failed send (toast, no `follow()`), although the
    core keeps running the turn. The notify level is the trigger because it is the one signal eharness
    gives for a failed send (the session state does not change and `describeChatError` is internal);
    the cost of a false positive (a busy or unrelated error) is one snapshot read and a refetch. The
    recovery waits until the session is idle (the failed send is still `sending`; it calls
    `refreshBusy()` meanwhile), probes `GET /sessions/:id` and, once the core answers, calls
    `session.followServerTurn()` (follows a running turn, else refetches). While the core does not
    answer it retries (6 probes, 0.5 s growing), and a feed resync or new boot id while the failure
    is still unrecovered runs it again. The refetch replaces the optimistic user message by its
    stored copy (by text), so the message is not shown twice. `info` notices do nothing.
  A busy session is never touched by either (its own reader and the UI's `checkStalled()` timer
  decide, see `tui.md`), and concurrent triggers coalesce into one recovery that runs once more if
  asked again meanwhile. The UI calls `session.checkStalled()` every few seconds while the chat
  shows a running turn; `interrupted()`, `continueTurn()` and `retryTurn()` are the session's own.
- `reply(text, sessionId?)`: without `sessionId`, the caller's own front session (from
  `rpc.auth.whoami()`); sends one text message and yields the assistant
  `UIMessage` as it streams (each value is the whole message so far). Yields nothing when the
  send is queued or has no body.

- `feed()`: the eharness `ActivityFeed` (`createActivityFeed({ client: harness })`) over the
  token-protected `/activity/stream` (polling fallback `/activity`). Lazy and one per client
  (every call returns the same feed); it starts with its first subscriber (or `start()`). The
  first connection delivers no history: refetch state on `subscribeResync` (e.g. `rpc.tasks.list`).
- `brainEventOf(record)`: the typed `BrainEvent` of an activity record (`parseBrainEvent` of
  `@keith/contracts`), or `undefined` for other records or a bad payload. Never throws.
- `pluginEventOf(record)`: the typed plugin event (`{ type, plugin, event, to, data }`, `parsePluginEvent`) of a `plugin.<id>.<event>` record, or `undefined`. `event: 'notice'` carries `{ text }` (`k.notify`). Never throws.

- `attention()`: the owner's inbox (`GET /attention`, `POST /attention/:id/answer`), an eharness
  `createAttentionList({ client: harness, events })`. Lazy and one per client; attached to
  `feed()` at creation, so it refetches (debounced 250 ms) on `KEITH_ATTENTION_EVENTS` (the
  library's `pending-changed`, `approval-decided`, `attention-answered`, `turn-ended`,
  `session-recovered`, `child-reported`, plus `brain.amygdala.wait`) and at once on every resync.
  Attaching subscribes to the feed but does not start it (the UI starts it, e.g. `useActivity`).
  The state is `{ items, loaded, error }` (a store: `get()`, `subscribe()`); call `refresh()` for
  the first list. An item (`AttentionItem` = `AttentionItemWire`) of a `motor_remote` approval
  carries `input.node`, `input.capability`, `input.input.command`, `agent`, `description`,
  `sessionId` (the task) and `createdAt`; the list is in the order the core gives, so a UI sorts
  by `createdAt`. Helpers on top of `answer(item, answer)`:
  - `approve(item)`: `{ kind: 'approval', approved: true }`
  - `deny(item, reason?)`: `{ kind: 'approval', approved: false, reason? }` (the reason reaches the model)
  - `approveForSession(item)`: `{ kind: 'approval', approved: true, remember: 'session' }`

  Answers are optimistic: the item leaves the list at once and returns if the call fails, except
  for 404 and 409 (answered elsewhere), where it stays gone. The promise rejects with the
  `HarnessHttpError` in both cases.

`rpc.admin.reviews.list({ status?, limit? })`, `.approve({ id })` and `.deny({ id, reason? })` (each a `ReviewView`: requester names, `plugin`, `operation`, `payload` as data, `status`, `reason`, `outcome`) hold the owner review queue (`plugins.md`): `reviews.decide` (owner only), and a remote approve or deny needs a step-up. `CONFLICT` means already decided, expired, plugin not loaded or requester suspended. The TUI shows them in the Reviews section of `keith manage` (`tui.md`).

`rpc.admin.plugins.list()`, `.views.list()` (the terminal views open now: `OpenView` `{ id, viewId, personId, openedAt }`), `.show({ id })`, `.enable({ id })` and `.disable({ id })` (`PluginInfo`, `PluginDetail`, `PluginToggle`: `state`, `nextBoot`, `restartPending`, `pendingReviews`, `effective: 'next-boot'`) are the operator view of the plugin layer (`plugins.md`): `plugins.manage` (owner only), a remote enable or disable needs a step-up, `NOT_FOUND` for an unknown id. `rpc.admin.capabilities.list()` (`people.manage`) lists the capabilities a person can be granted (core and loaded plugins); `rpc.auth.whoami().capabilities` and `rpc.admin.people.grant|grants|revokeGrant` carry capability ids as strings. No wrapper: the Plugins section of `keith manage` calls these.

The groups and audit retention have no wrapper either (the Manage section Groups, `tui.md`): `rpc.admin.groups.list()`, `.get({ group })`, `.create({ name })`, `.delete({ group })` (`{ ok: true }`), `.add({ group, person })` and `.remove({ group, person })` (each a `GroupView`: `members`, `usage`; `group` and `person` take a name, username or id), and `rpc.admin.audit.retention.get()` / `.set({ days })`. They need `groups.manage` (owner only) and, for the writes, a step-up (`KEITH_STEP_UP_REQUIRED` goes through the usual prompt; `CONFLICT` carries the count of resources that still use a group). `rpc.acl.show|share|unshare|chmod|chgrp|chown` return an `AclView`; `show` answers only the resource's owner and the instance owner (anyone else gets the `NOT_FOUND` of a missing resource).

The budget has no wrapper: `rpc.budget.get()` returns the `BudgetStatus` of the month and
`rpc.budget.set({ limitUsd })` sets (or, with `null`, removes) the monthly limit; the feed's
`budget-changed` records tell a UI to read it again.

The task board has no wrapper: call `rpc.tasks.list({ active?, limit? })` and
`rpc.tasks.stop({ id })`; the feed's `task-changed` records carry the changed task.

## Rooms

`rooms.ts` (`packages/client/src/rooms.ts`) is the client side of the shared rooms (docs/specs/corpus-callosum.md, "RPC" and "Feed, recovery, filters"). `client.rooms` (`roomsApiOf`) is one typed object over `rpc.rooms.*`: `start`, `invite`, `accept`, `decline`, `say`, `leave`, `remove`, `end`, `confirm`, `get`, `list`, `events`, `files` and `settings.get` / `settings.set`. Each method takes and returns the contract's types; it adds no logic. The room settings need a step-up from a remote client, as the core says.

`createRoomEvents({ roomId, events, feed, limit?, onError? })` keeps the transcript of one room in step with the activity feed. It is a store like `attention()`: `get()` gives `{ events, after, loaded, error }` (`after` is the last `seq` held, 0 before the first event), `subscribe(listener)` is told each change, `refresh()` reads now, and `attach()` subscribes to the feed and returns the detach. `events` is `client.rooms.events` and `feed` is `client.feed()`; the feed is not started here (the UI starts it).

- **Refetch, not payload.** A `room.event` record (`ROOM_EVENT`, `RoomEventRecordSchema`) carries no text. The controller refetches `rooms.events({ roomId, after, limit })` when a record of this room has a `seq` past the cursor, and on every feed resync (`subscribeResync`: a reconnect, a `resync` frame, a poll gap, a new boot). A record at or below the cursor, or of another room, does nothing.
- **No gap, no duplicate.** Each refetch asks for everything after the cursor, pages (`limit`, default 200) until a short page, sorts the page and keeps only the events with a `seq` past the cursor as it goes. So the events a dropped feed missed are read on reconnect, and a repeated `seq` is appended once. The server's membership rule still applies: a member who left gets `FORBIDDEN` or the events it may read, and the controller keeps whatever it already holds.
- **Coalescing.** Triggers that arrive during a refetch set one flag; the pass runs once more after it, so the transcript is never older than the newest trigger and there is no request per record.
- **Failure.** A failed refetch sets `error` (`onError` is called too), keeps the events and the cursor, and the next trigger (a record or a resync) reads from the same cursor. The error clears on the next success.

`createRoomView({ roomId, get, feed, onError? })` is the room view of one person: `client.rooms.get` kept in step with the feed. It is a store like `createRoomEvents`: `get()` gives `{ view, error }` (`view` is the last `RoomView` read, undefined before the first), `subscribe(listener)`, `refresh()` reads now, `attach()` reads at once and then again on each `room.indicator` of its room (`RoomIndicatorRecordSchema`, the indicator is not in the record), each `room.event` of its room (members and requests change with the lines) and every feed resync; it returns the detach. A record of another room, a record whose payload does not parse, and a record of another type do nothing. Triggers during a read coalesce into one more read, and a failed read keeps the last view and sets `error`. The view carries the indicator, each member's presence and the pending requests the caller may confirm (corpus-callosum.md, "RPC").

Every request carries `Authorization: Bearer <token>`; trailing slashes of `baseUrl` are trimmed.
`frontSessionOf(personId)` is `front:<personId>` (generation 0; `frontSessionOf(personId, n)` is `front:<personId>:g<n>`, see "Chat context"): get the person from `rpc.auth.whoami()` (`{ personId, name, role, via, credentialKind }`, any signed-in principal). `OWNER_SESSION` is removed: no client constant names the owner's session (P9 step 4).

## Connection monitor

`createConnectionMonitor` (`connection-monitor.ts`) is a small pure state machine over the activity feed's status, with an injectable clock (`MonitorClock`: `now`, `after`) and no I/O of its own; `watchConnection(client, { windowMs, waitMs, clock })` (`connection-watch.ts`) wires it to `client.feed()` (the status in; an attempt is `feed.stop()` then `feed.start()`) and to a `health` call that gives the last error in words (`reasonOf`: `connection refused`, `timeout`, `host not found`, `network error`, `the core answered 503`; never a URL, token or body). The eharness feed reconnects by itself and never gives up, so the monitor is what turns an outage into a state a person can read. `get()`, `subscribe(run)` (calls `run` at once, then on changes), `retryNow()` and `stop()` (cancels every timer and leaves the feed).

| State | Meaning |
| --- | --- |
| `connecting` | the feed was never live: the first connect is not an outage, nothing is timed |
| `live` | the feed is live; no timer runs |
| `reconnecting` | one window of `windowMs` (5 s) after a drop, and one per attempt; `until` is when it ends |
| `disconnected` | the window ended without a live feed; `retryAt` (epoch ms of the next attempt) and, once diagnosed, `reason` |
| `logged-out` | the feed said `unauthorized`: terminal, no retries (a new login builds a new client) |

The cycle: **drop** (status not `live` after `live`) is `reconnecting` for 5 s; not live by then it is `disconnected` for `waitMs` (15 s, with `retryAt` for a countdown); then **one attempt**, `reconnecting` for 5 s again; success is `live`, failure is `disconnected` for 15 s, and so on forever (a 20 s cycle). The feed going `live` by itself at any time makes the state `live` and clears the timers. `retryNow()` starts an attempt at once while `disconnected` (it still gets only its 5 s window) and is honoured at most once per 3 s (`RETRY_NOW_GAP_MS`); it returns whether one started. Only one timer exists at a time and none while `live`; the feed's own churn during a window changes nothing; a late diagnosis never lands on a later state. `connection-monitor.test.ts` drives all of this with a fake clock.

## Persona

`persona.ts` is the client side of the persona and the reply style (docs/specs/prefrontal.md, "RPC"). `client.persona` (`personaApiOf`) is one typed object over `rpc.persona.*`: `get`, `history`, `setTemplate`, `edit`, `restore` (owner, with the step-up of the call) and `style.get`, `style.set`, `style.read`. Each method takes and returns the contract's types and adds no logic; the server refuses an owner change without the step-up.

`watchPersona({ feed, refetch })` calls `refetch` on each `persona.changed` record (`PERSONA_CHANGED`; the record holds the version and the reason, never the text, and a payload that does not match its schema is ignored) and on every feed resync, since a change made while the feed was down is read again only by a refetch. It returns the detach function. The TUI persona screen (P33.5.3) refetches through it.

## Chat context

`chat-context.ts` is the client side of the context reset and compaction (docs/specs/chat-context.md, "RPC"). `client.chatContext` (`chatContextApiOf`) is one typed object over `rpc.chat.*`: `newContext({ flush? })`, `compact({ keepLast? })`, `generations()` and `history({ generation, limit? })`. Each method takes and returns the contract's types and adds no logic; the caller's own session is the only one a call changes.

`chatContextRefusalOf(error)` reads the reason of a refused reset or compaction (`CONFLICT` with `data.reason`: `turn-running`, `approval-pending`, `task-running`, `flush-failed`), or returns undefined for any other error or an unknown reason. The UI turns the reason into its own text.

`watchChatContext({ feed, refetch })` calls `refetch` on each `chat.context.changed` record (`CHAT_CONTEXT_CHANGED`; the record holds the generation, never the text, and a payload that does not match its schema is ignored) and on every feed resync. The current generation is the last entry of `generations()`. `frontSessionOf(personId, generation)` gives the id of a generation: `front:<personId>` for 0, `front:<personId>:g<n>` after. `watchChatContextPending({ feed, onRecord, onResync })` hands each well-formed `chat.context.pending` record (`CHAT_CONTEXT_PENDING`: `start` before a reset's flush or a compaction, `end` after it) to `onRecord`, and calls `onResync` on every feed resync, so the caller forgets a change it may have missed. The `reply` helper follows the current generation when it is given no session id.

## Dreaming

`dreaming.ts` is the client side of the memory dreaming (docs/specs/dreaming.md, "RPC", ADR-0031). `client.dreaming` (`dreamingApiOf`) is one typed object over `rpc.dream.*`: `status()`, `setMode({ mode })` (`off`, `propose` or `auto`), `runNow()`, `apply({ runId })`, `undo({ runId? })` and `diary({ date? })`. Each method takes and returns the contract's types and adds no logic. Every call acts on the caller's own memory: no argument names a person and no step-up applies.

`dreamRefusalOf(error)` reads the reason of a refused call (`CONFLICT` with `data.reason`: `too-soon`, `few-messages`, `no-model`, `budget`, `turn-running`, `staged-changed`, `nothing-to-undo`, `off`), or returns undefined for any other error or an unknown reason. A failed run (`judge`, `turn-error`) is not a refusal: its reason is on the run row. The UI turns the reason into its own text.

## Activity logs

`activity-logs.ts` is the client side of the model-call logs (docs/specs/activity-logs.md, "RPC"; ADR-0032 §9). `client.logs` (`logsApiOf`) is one typed object over `rpc.logs.*`: `status()`, `settings.get()`, `settings.set(input)`, `sessions(input?)`, `session({ id })`, `call({ id })`, `raw({ callId })` and `purge({ mode, person? })`. Each method takes and returns the contract's types and adds no logic. The input and output types of `session`, `call` and `raw` are derived from the procedures (the contract exports no type for their inputs). `settings.set` and an owner's `purge` of another person need the step-up of the call; the server refuses them without it and the client does not check. `sessions` defaults to `{}`, the caller's own sessions, first page.

## Presence reporter

`createPresenceReporter(client, { kind, label, capabilities, version, store? })` (`presence.ts`) makes this client one of the person's clients (docs/specs/parietal.md, "Reporter and clients"). The client id is a uuid kept by `fileClientIdStore(configPath, personId)` in `client-state.json` beside `client.json` (`clientStatePath`): one id per person on this machine (`clientIds[personId]`), so each person who signs in on the terminal is their own client. A person with no entry reads the legacy single `clientId` of older files; the first successful register claims it. A stored value that is not a uuid is replaced. The TUI names the person with `auth.whoami` before it creates the reporter. A `CONFLICT` for an id that belongs to another person (a stale or foreign id) gets one new id, saved for this person, and one more register; a full list (`CONFLICT`, 20 clients) does not. Known limit: two TUI processes of the same person share one id. `start()` registers and then runs one step every 20 s: it reads the core's boot id from `/health`, registers again when the boot id changed or after any failed step (a 401, a removed client, a core that is down), then sends `presence.clients.heartbeat { id, active }`, with `active: true` only when `touch()` ran in the last 30 s. The UI calls `touch()` on each key press and each chat send. `stop()` cancels the timer and releases the activity feed it holds for `onNotify`. It first waits for a step that is in flight (the first register may still be running, the environment probe takes up to about 2 s), then sends `presence.clients.goodbye` once if that step registered; the whole wait is 3 s at most. A step that finishes after `stop()` never heartbeats; if it registered after the stop gave up waiting, it sends the goodbye itself (one goodbye per reporter). The reporter never throws: a failed step is retried on the next one. The web app (kind `web`, `apps/web` `features/presence`) elects one reporting tab per browser and gives the page's client a `fetch` that marks the goodbye request `keepalive`, so it still leaves on `pagehide` (`docs/specs/web.md`, "Presence").

Rendering ids (ADR-0029 §5, P33.1.3): a client that renders Markdown declares `render.markdown` in `capabilities`; a client whose channel is
spoken declares `render.speech-only`. The ids are the closed set of `RENDER_CAPABILITY_IDS` (`presence.ts`); a client declares neither
unless it can show or speak that. The core never assumes Markdown: a client with neither gets plain text. The terminal app
declares `TERMINAL_CAPABILITIES` (`chat`, `notify`, `open.view`, `render.markdown`, `presence.ts`) on register; the TUI passes that list as its
capabilities, so the core answers it with Markdown (P33.5.1). `location.share` is not announced (opt-in, not built). The reporter sends the environment on register (`environment` option; "Client environment").

`onDeliver(capability, handler)` subscribes to the activity feed and holds it with a state subscriber, not `feed.start()`: the feed starts with that subscriber and stops about a second after the reporter's `stop()` (an explicit start would keep the stream reconnecting). It hands each `brain.parietal.deliver` record whose `clientId` is this client and whose capability matches to `handler({ deliveryId, capability, name, text? })`. `onNotify(handler)` is `onDeliver('notify', handler)`. The handler's text answer is sent as `presence.clients.ack { id, deliveryId, ok: true, result? }`. A throw is `ok: false`; a throw of `UnsupportedDelivery` is `ok: false` with `result: 'unsupported'` (`UNSUPPORTED`). A delivery of a capability this client did not declare, or with no handler, is never run and is acked `ok: false`, `result: 'unsupported'`. A record of another client is ignored. The guest client does not use the reporter.

For `open.view` the delivery's `name` is the view the client opens: `plugin:<id>:<view>` (the plugin view `<id>.<view>` of the menu) or `tasks`. The TUI opens it (`features/plugin-view/open-target.ts`) and acks `ok: true, result: 'opened'`; an unknown view, a room or protocols answer `unsupported`. The core's route sends `name` as the caller's target name (parietal.md), so the caller passes the view as that name.

## Client environment

Decision: ADR-0033 (client context). Code: `packages/client/src/environment.ts` (`detectEnvironment`, `deviceOf`, `hostOf`, `hostNameOf`, `osOf`, the probes
`defaultProbes` and the injectable `EnvironmentProbes`), the reporter option `environment` in `presence.ts`, the contract in `packages/contracts/src/presence.ts`.

- **What is sent.** `createPresenceReporter(client, { environment })` reads the environment once, on the first register, and sends it as `environment` of
  `presence.clients.register`. A reader that throws or is absent sends no environment; the reporter never throws. The terminal passes
  `detectEnvironment` (`features/presence/use-presence.tsx`).
- **Host rule.** `host` is `hostNameOf`: `os.hostname()` when it is usable, with a trailing `.local` dropped and at most 60 characters. A name
  that is empty, `localhost`, or an IP address (IPv4 or IPv6, as DHCP can leave the host name) is not usable. Then macOS asks `scutil --get LocalHostName`
  and then `scutil --get ComputerName`; Linux reads `/etc/hostname` (the same rule applies to each). When none is usable, `host` is `this computer`.
  Each probe fails alone, so the host is never an address and never missing.
- **Fields** (`ClientEnvironmentSchema`): `host` (the host rule above), `os` (`macos`, `linux`, `windows`, `other`,
  from `process.platform`), `osVersion` (at most 40: the macOS product version from `sw_vers -productVersion`; the kernel release otherwise), `arch`
  (`os.arch()`, at most 20), `device` (`laptop`, `desktop`, `phone`, `unknown`), `timezone` (`Intl`, an IANA name the platform knows, at most 60) and
  `locale` (`Intl`, at most 20). Every text loses its control characters and folds white space. A zone that does not parse, or no zone at all, means no
  environment. No IP, user name or path is sent.
- **Device rules.** macOS: `pmset -g batt` with `InternalBattery` is `laptop`, without it `desktop`. Linux: a `BAT*` entry in
  `/sys/class/power_supply` is `laptop`, without it `desktop`. Windows, a phone and a failed probe are `unknown`. A probe command runs for at most 2 seconds.
- **Failure.** Each probe may fail alone: its field is left out; `device` is `unknown`; a missing zone gives no environment.
- **Network is not sent.** The core derives `network` from the listener and the TCP peer on register (`modules/parietal/network.ts`,
  `clientNetworkOf`, the zone rule of the login): `local-socket`, `loopback`, `lan`, `tailscale` or `public`. A forwarded request is `tailscale`
  when its peer is a Tailscale address (the `tailscale-serve` proxy, or a tailnet device behind a proxy; the login zone rule, `auth.md`), and a
  Tailscale Funnel request (`Tailscale-Funnel-Request`) is `public` even then. The core stores the network, never the address or the Tailscale user.
- **Storage.** `clients.environment` (JSON) and `clients.network` (migration 0024); a re-register replaces both. A stored value that no longer parses
  reads as absent. The record (`ClientRecordSchema`) carries `environment` and `network` when known.
- **No setting.** Client context is always on (ADR-0033 amendment, Nov 12, 2026): there is no RPC, table or Me row for it.
- **Use.** The front agent's reminder reads the environment of the active client (`parietal.md`, "Client context block"), and the `client_call` description
  lists the capabilities online for the person. The environment never leaves the person's own turns and the person's own `presence.mine` and `presence.clients.list`: the owner's raw read (`admin.presence.read`) carries neither `environment` nor `network` (`RawClientRecordSchema`, ADR-0033 §3).

## Local socket

`localSocketPath(dataDir)` (`socket.ts`) is where a core on this machine listens: the path core recorded in
`<dataDir>/core.sock.path`, else `<dataDir>/core.sock`, else `$TMPDIR/keith-<sha256 of the data dir, 12 hex>.sock` when
that is over 100 bytes (the rule of `socketPathFor` in apps/core; a client cannot import apps/core). `probeSocket(path)`
says whether something answers, and `socketFetch(path)` is a `fetch` that adds `{ unix: path }`:
`createKeithClient({ baseUrl: 'http://localhost', fetch: socketFetch(path) })` needs no token. The data dir itself
(`KEITH_DATA_DIR`, `KEITH_HOME`) is resolved by the caller (`tui.md`); the client reads no env.

**The socket's lock** (`local-lock.ts`): `unlockLocal({ fetch, pin } | { fetch, password })` and `lockLocal({ fetch, token? })` call
`POST /auth/local/unlock|lock` (use `socketFetch(path)`); they reject with `LocalLockError` (`reason`: `invalid`, `throttled`
(`retryAfter`), `unavailable`, `no_pin` (`hint`), `unauthorized`, `unreachable`). `openLocalSession({ fetch, pin | password })` buys an admin session on a socket whose owner needs one (`POST /auth/local/session`; `{ credential, elevatedUntil }`; `not_applicable` when the socket serves an implicit owner). `localStatus({ fetch })` (`GET /auth/local/status`) says whether the first-owner flow is open and `setFirstOwner({ fetch, pin | password })` (`POST /auth/local/first-owner`) sets the owner's first PIN or password and returns `{ credential }` (failure reasons `refused` with the rule, `closed`). A socket session is kept in memory by the caller and never written: `removeSocketSession` only deletes the `socket-session.json` that an earlier version left next to `client.json`. `isLockedError(error)` is true for the `423` of a
locked socket (an HTTP error with `status: 423`, or an oRPC error with `code: 'LOCKED'`).

## Device login

`deviceLogin({ core, label?, onCode, signal?, fetch?, pollMs? })` (`login.ts`) logs a client in to a
core it has no credential for. It `POST`s `/auth/device/start`, calls `onCode({ code, expiresAt })` once
with the code to show (`XXXX-XXXX`, valid 10 minutes), then polls `/auth/device/poll` every `pollMs`
(default 2000, `DEVICE_POLL_MS`) until the owner runs `keith-core devices approve <code>`. It resolves
with the credential (`keith_s_…`) for the caller to store as `token` (`writeClientConfig({ core, token })`).
It rejects with `DeviceLoginError` whose `reason` is `denied`, `expired` (also a vanished request),
`aborted` (the `signal`), `rejected` (core refused the start, e.g. 429) or `unreachable` (the start
could not connect). Network errors while polling are retried until the code expires; a `429` slows the
polling down. The helper never stores anything itself. Flow and limits: `auth.md`.

## Password login and step-up

`passwordLogin({ core, username, password, label?, fetch? })` (`password.ts`) posts `/auth/login` and
resolves with the credential (`keith_s_…`, to store as `token`). It rejects with `LoginError` whose
`reason` is `invalid` (401: unknown user, wrong password, suspended or locked: core never says which),
`throttled` (429; `retryAfter` seconds from `Retry-After`), `not_allowed_here` (403: core does not
accept password login from this network; use Tailscale or the device code), `unavailable` (503: core is
busy hashing) or `unreachable`.

`stepUp({ core, token, pin } | { core, token, password }, fetch?)` posts `/auth/step-up` with the bearer
and resolves with `{ elevatedUntil }` (epoch ms, 10 minutes, fixed). It rejects with `StepUpError`:
`reason` is `invalid`, `throttled` (`retryAfter`), `not_allowed_here`, `unavailable`, `unreachable`,
`unauthorized` (the session is gone), `no_method` (no PIN or password set; `hint` is `keith-core people
pin <username>`) or `legacy_credential` (an old token cannot step up; sign in again).

`KEITH_STEP_UP_REQUIRED` (re-exported from `@keith/contracts`) is the `code` of the oRPC error that
`/rpc` answers when a call needs a step-up; the caller asks for the PIN, calls `stepUp`, and retries once
(P9 step 3 raises it from the middleware; the TUI handles it: `tui.md`, "Step-up"). The error carries `code` on both
paths, an oRPC error and an `/attention` answer (`HarnessHttpError.code`); the same holds for `KEITH_WAITING_FOR_OWNER`, which a
member gets for an item the owner answers. Neither helper stores anything.

## Sign-in controller

`createSignIn(options?)` (`sign-in.ts`, with `sign-in-types.ts` and `sign-in-requests.ts`) is the whole sign-in flow as a pure
store; the TUI screen and Home's panel only render it (P13, P14 step 9). No React, no process I/O: `fetch`, `now`, `sleep`, the
`store` that saves the credential (default `writeClientConfig` at the default path, mode 0600), the `remember` memory of the
typed identifier (default: none), a `label`, `pollMs` and an `AbortSignal` are injected. `get()`, `subscribe(listener)` (returns the
unsubscribe) and `dispose()` work like the other client stores. The caller picks the initial `address` (flag, then `client.json`,
then `DEFAULT_CORE`); `socketPath` starts the flow on `socket` when no address is given.

The flow is `address -> checking -> identify -> flow(step...) -> done`. The controller is **generic**: it draws no method of its
own. It passes on whatever the core's `methods[]`, `firstStep` and `interaction` say, so a new method (TOTP) needs no controller
or TUI code while it uses text or secret fields (`StepField.kind`: `text`, `secret`, `digits`, `code`) or the device-code wait.
`SignInMethod` is `string`; `SignInMethodItem` is the contract's `MethodDescriptor`.

States (`SignInState`, discriminated by `step`):

| step | meaning |
| --- | --- |
| `address` | asking for the core address; `problem` says why the last one was refused |
| `socket` | `unix:<path>`: the socket is the login, nothing to do |
| `checking` | `GET /health` in flight |
| `identify` | core answered (`info: { version, sha }`); asking who: `identifier` (typed, or the remembered one), `problem?` (`{ reason, message, retryAt? }`) |
| `working` | a request is in flight (`method` is `undefined` while the identifier is sent) |
| `flow` | the core listed the methods for this client: `methods`, `method` (on screen, the core's `default` first), `current` (the `Step` to draw: `fields`, `help`), `context` (`loopback`, `lan`, `tailscale`, `public`), `identifier`, `problem?` |
| `device` | `code` and `expiresAt` once core answered, `polling` true while waiting for the approval |
| `done` | signed in: `person` (`name`, `username`, `role` from `auth.whoami`, `undefined` if core did not answer in 3 s) |
| `error` | `/health` failed: `reason` (`unreachable`, `not_keith`), `message`, `retryable` |

Calls: `submitAddress(address)` normalizes (`parseSignInAddress`: http(s) only, a bare `host:port` gets `http://`, trailing
slashes dropped; `unix:` goes to `socket`), checks `/health` and moves to `identify`. `submitIdentifier(text)` posts
`POST /auth/identify` and lands on `flow` with the method the core marked `default` (else the first available, else the first).
`chooseMethod(id)` shows another method of the list (no request; tabs). `submitStep(answer)` answers the step on screen:
`answer` maps field names to what was typed. For an `interaction: 'poll'` method it starts the device code (`/auth/device/*`,
unchanged); for `token` it checks the pasted credential through `auth.whoami` (there is no server step) and saves it; for any
other method it posts `POST /auth/flow/:flowId { method, answer }` (plus the `label`). The core answers `{ credential }`, which is
saved and followed by `done`, or `{ step }`, which replaces `current` (a multi-step method). An empty field is never sent; a method
the core listed as `available: false` sends nothing and shows its `reason`. `cancel()` aborts what is in flight at once (device
polling stops, a late answer is dropped) and returns to where the request started (`flow`, or `identify` while asking). `back()`
goes one step back (`flow` to `identify` with the identifier kept, `identify` to `address`, `error` to `address`). `retry()` repeats
the health check after an `error`. `dispose()` aborts everything.

Failures (`SignInProblem`, shown inside `identify` or `flow` so the form keeps what was typed; the same words for a known and an
unknown identifier, because the core answers a decoy of identical shape): `invalid` (`401 invalid_credentials`: one line,
"sign-in failed: check your id and what you typed", never saying which part was wrong), `throttled` (`429`: `retryAt = now() +
Retry-After`, default 30 s; the UI computes the countdown and a new answer is not sent before it, also on `identify`),
`not_allowed_here` (`403 login_not_allowed_here`, or a method the core refused), `unavailable` (`503`), `unreachable`, `rejected`
(an unexpected status or body); device `expired` (also a vanished request), `denied`; token `invalid` (401 from `auth.whoami`)
versus `unreachable`; `save_failed` (signed in, but `client.json` could not be written; not retried). **An expired flow (`404
not_found`: more than five minutes, or five wrong answers, or another address) restarts at `identify` with the typed identifier
kept** and the problem `expired`. `error` exists only for the health check.

Older cores: when `POST /auth/identify` answers `404`, `405` or `401` (an auth middleware before the router; a current core
never answers `401` there), the controller falls back to the three fixed methods of the old flow: it asks `GET /auth/methods`
(5 s limit; any failure keeps all three offered), lists `device`, `password` (default when available) and `token` as descriptors,
uses `context: 'public'` (no zone is known, so no LAN warning), and signs in the password through `POST /auth/login` with the
identifier as the username. The UI is the same.

Secrets: PIN, password, token and credential are arguments of `submitStep` only (never in a state, a problem, a closure kept after
the call, or a listener payload). On success the person is checked first: `auth.whoami` with the credential in memory (3 s at most,
`whoamiTimeoutMs`; a timeout still saves, since the core accepted the login moments ago). Then the credential is saved exactly as `keith login`
does (`{ core, token }`, mode 0600, through the `store`) and only then `done`; the `store` may resolve with a note (a replaced login that could
not be revoked, `replaceClientConfig`), which `done` carries as `note`. A cancel or back during the `whoami` wait stores nothing and revokes the
fresh credential best effort (`auth.logout` with it). A `store` that throws revokes it the same way and reports `save_failed`; the store itself
removes what it wrote (the TUI forgets the vault entry when the file fails). A failure writes nothing. The label defaults to core's (`password login`, `pin login`,
or the device's) when `label` is not given; `keith login` passes the hostname, and so should the TUI.

**Remember this device** ("Remembered and saved logins"). `setRememberDevice(on)` / `rememberDevice()` (option `rememberDevice`, default **off**) say whether the sign-in is kept on
this device. When on, a password or PIN answer is sent with `remember: true` (a 30 days idle session, auth.md) and the `store` receives
`{ core, token, remember: true }`; when off the `store` receives `{ core, token }` and a UI keeps the credential in memory only (the TUI does,
tui-login.md). `canRememberDevice()` is true only for a form method answered through the flow routes (not the device code, not a pasted token, not an
older core's fixed methods), which is where the core can give the session its 30-day lifetime.

The text command has the same choice: `passwordLogin({ remember: true })` (`password.ts`) runs `POST /auth/identify` and then the password answer on
`POST /auth/flow/:id` with `remember: true`; a core without the flow route, or one that does not offer the password method, rejects with
`LoginError` reason `remember_unavailable`. Without `remember` it keeps calling `POST /auth/login`, which takes no remember flag.

**Remembered identifier.** The identifier (never a secret) is kept per core in `client-state.json` next to `client.json`
(`fileIdentifierMemory(configPath)`, mode 0600, `clientStatePath`). The controller writes it only when a sign-in reaches `done`
(a wrong guess is not remembered) and reads it when it enters `identify` with nothing typed yet, so the next start pre-fills the
box. Reads and writes never throw. Without `remember` nothing is remembered (tests inject none).

## Guest client

`createGuestClient({ baseUrl, fetch?, clientKind? })` (`packages/client/src/guest.ts`) is what an anonymous visitor's UI uses on the guest listener (`guests.md`, "Guest HTTP"). It
needs no login and no config file, writes nothing to disk and **keeps the bearer in a closure only**: no property, snapshot or `session` view carries it, and when the object is gone the
session cannot be reached (the core's sweeper ends it). `baseUrl` is the guest listener (port 7421 by default), not the owner's port.

- `status()`: `GET /guest/status` -> `GuestPublicStatus` (`enabled`, `available`, `banner`, `limits`). Rejects with `unreachable`, `not-found` or `protocol`.
- `open()`: `POST /guest/session` (`{ clientKind }`, default `tui`) -> `GuestSessionView` (`sessionId`, `expiresAt`, `limits`, `notice`; no token). Rejects with a `GuestError`.
- `session`: the open session, or `undefined` before `open()`, after `end()` and after a `410` or `401`.
- `chat(text, { signal? })`: an async generator over `POST /guest/sessions/:id/chat` (one text part). It yields `{ type: 'meta', turnsLeft, watched }` first (from `x-keith-guest-turns-left` and `x-keith-guest-watched`), then `text` (a delta), `tool` (`running`, `done`, `error`; the name only, never an input), `error` (the core's fixed sentence) and `finish` (`stop`). The core's stream is already scrubbed (`thalamus.md`); the client reads only those chunk types. A failure before the stream rejects at the first `next()`; a stream that drops rejects with `unreachable`.
- `interrupt()` and `end()`: `POST .../interrupt` and `DELETE`; neither rejects (a gone session is already stopped). `end()` forgets the bearer.

**Errors.** `GuestError { kind, status, message, details: { code?, reason?, retryAfter? } }`. Every `GUEST_HTTP_ERROR_CODES` maps to one `GuestFailureKind` (`GUEST_FAILURE_OF_CODE`, a `Record` so a new code is a type error until mapped):
`GUEST_UNAUTHORIZED` `unauthorized`, `GUEST_DISABLED` `disabled`, `GUEST_ZONE` `zone`, `GUEST_RATE_LIMITED` `rate-limited` (`retryAfter` from `Retry-After`), `GUEST_BUSY` `busy`, `GUEST_CAP` `cap`, `GUEST_UNAVAILABLE` `unavailable`,
`GUEST_SESSION_ENDED` `ended` (`reason` is the `GuestEndReason`), `GUEST_NOT_FOUND` `not-found`, `GUEST_BAD_REQUEST` `bad-request`; with no code the status decides (409 `turn-running`, 401, 410, 404, 429 `busy`, 400/413, 403, else `unavailable`).
A network failure is `unreachable`, an answer that does not parse is `protocol`. `message` is one English sentence (`guestFailureText`; a `410` uses `GUEST_END_TEXT[reason]`, one sentence per end reason). A `410` or `401` on `chat` drops the session.

**In the browser.** `createGuestClient` is in both entries (it reaches only `@keith/contracts`). It reads the answer stream with `body.getReader()` (async iteration of a `ReadableStream` is missing in some browsers); the web guest page passes `baseUrl: location.origin` and `clientKind: 'web'` (`web.md`, "Guest").

Tests: `guest.test.ts` (fake fetch: status, open with no token exposed, the chat request and every event type, the headers, interrupt and end, every error code, every end reason, bare statuses, network failure, a dropped stream).

## Browser entry

`@keith/client/browser` (`src/browser.ts`) is the entry of the web client (ADR-0035). The root entry `.` is unchanged for the TUI, CLI
and nodes. The browser entry reaches no `node:*` or `bun:*` import and no `Bun.*` API, directly or through `@keith/contracts`;
`src/browser.test.ts` walks its import graph and fails on one.

- **Contains:** the typed client (`createKeithClient`, rooms, persona, chat context, dreaming, logs, attention, feed, chat), the
  pure sign-in controller, device login, step-up, the presence reporter, plugin views (`openView`, `fetchViewMenu`, `parseFrame`, `keyBytes`), the guest client (`createGuestClient`),
  the connection monitor, and re-exports of `isClippedPart`, `HarnessHttpError`, `isHarnessHttpError`, `isNetworkError`,
  `ChatSession` and the other eharness client types, so `apps/web` never imports eharness.
- **Cookie mode:** `createKeithClient({ baseUrl?, auth: 'cookie', fetch? })`. `baseUrl` defaults to the page origin. No
  `Authorization` header is ever sent; every call goes with `credentials: 'same-origin'`, so the HttpOnly `keith_s` cookie travels by
  itself and page script holds no secret. `stepUp`, `viewMenu` and `openView` do not need a token in this mode. `stepUp` sends
  `{ pin | password, rotate: true, deliver: 'cookie' }` and accepts `{ elevatedUntil, cookie: true }`. `openView` uses the platform
  `WebSocket` with no header (the cookie goes with the same-origin upgrade; `ws` or `wss` follows the page).
- **Sign-in:** `createCookieSignIn(options?)` is `createSignIn` with `deliver: 'cookie'`: the flow and the device poll ask for the
  cookie, `{ cookie: true }` ends the sign-in, nothing is stored by the page, and a pasted token is checked with `auth.whoami`
  and then turned into the cookie (`POST /auth/web/adopt`, `remember` from `setRememberDevice`). A cookie answer to a body-mode
  sign-in, or an approved device poll with no credential in body mode, is an error. A core without the flow routes is refused
  in cookie mode.
- **Session calls:** `adoptToken(credential, remember?)` (`POST /auth/web/adopt`, `WebSessionError` `invalid` for a refused
  token) and `logout()` (`POST /auth/web/logout`: revokes the session and clears the cookie; `revokeSelf` does not clear it).
- **Browser pieces:** `WEB_CAPABILITIES` (`chat`, `notify`, `open.view`, `render.markdown`);
  `detectBrowserEnvironment(navigator?)` (time zone and locale from `Intl`; OS, browser name and `phone` from `navigator`, with
  `userAgentData` first; no fingerprinting, no IP, no high-entropy hints; the host is `<browser> browser`; a laptop and a desktop
  are not told apart, so the device is `unknown`); `localStorageClientIdStore()` and `localStorageIdentifierMemory()` (every access
  in a try/catch, memory when the storage is blocked).
- **Injection instead of defaults:** `createSignIn` (sign-in.ts) takes `store` and keeps nothing without one; `createPresenceReporter`
  (presence.ts) takes `store` and defaults to `memoryClientIdStore()`. The root entry exports wrappers (`sign-in-node.ts`,
  `presence-node.ts`) that add the file defaults (`writeClientConfig`, `fileClientIdStore`), so callers there see no change.
- **Node-only (root entry only):** `config.ts` (the login file), `environment.ts` (host probes), `identifier-memory.ts`,
  `socket.ts` (the local socket) and the Node defaults named above. `local-lock.ts` serves the local socket and the CLI, so the browser entry does not export it (`guest.ts` is exported: it uses no Node API). `deviceLogin`,
  `passwordLogin` and `stepUp` are in both entries (they take `fetch`).

## Config file

`readClientConfig(path?)` / `writeClientConfig(config, path?)` use `path`, default `~/.keith/client.json`; the TUI passes `KEITH_CLIENT_CONFIG` or `KEITH_HOME/client.json` here (the client reads no env)
(`{ core, token, remember? }`; `token` is the credential, whichever kind; `remember: true` is written only by a sign-in made with "remember this device"
and is what the interactive app needs to use the file without asking, `isRemembered(config)`; a file without it is a saved login of the earlier kind: `keith login`,
a pasted token, a file written by an earlier version. Commands and scripts use either kind; the interactive TUI start uses only a remembered one, tui.md). The file is written with mode 0600 in a 0700 folder because the token is a
credential, and atomically (`writeFileAtomic`: a temp file beside it, then a rename), so a crash leaves the old file whole. A missing file or one without string `core` and `token` reads as `undefined`.
`DEFAULT_CORE` is `http://localhost:7420`. `writeClientConfig` resolves with the entry it replaces (`undefined` for a first write or a damaged file).

**A new login replaces the old one.** Every save of a login that goes through the app or `keith login` (`replaceClientConfig`, `apps/tui/src/sign-out.ts`) writes the new entry first and then, when the replaced entry holds another credential, revokes that credential on its own core (`auth.logout` with the old token, 3 s at most; an already revoked one is fine). The new login is kept either way: a failed revoke gives a note (`could not revoke the previous login on <core>: keith-core devices revoke <id>`) that the caller shows. The same credential written twice revokes nothing. The sign-in controller hands the same note back in `done` (`note`), through `SignInStore.write`.

## Errors

HTTP failures surface as the `harness` errors (e.g. `status: 401`/`404`) and oRPC errors from
`rpc` (`UNAUTHORIZED`, `BAD_REQUEST`). The client does not retry.

## Tests

`view/key-bytes.test.ts` (the xterm bytes of every key, modifiers, paste filtering, the reserved keys; moved from the TUI),
`sign-in.test.ts` and `sign-in-methods.test.ts` (the sign-in controller against a fake core with `sign-in-fake.ts`: address and health, identify (zone, default method, decoy-shaped answers identical for known and unknown identifiers, 429 with a waiting resend, 503, unreachable, bad body), flow answers (PIN, password, 401, 429, 403, 503, expired flow restarting at identify, save failure, a multi-step method with an unknown id), device code, token, an older core without `/auth/identify` (404, 405, 401), `client.json` mode 0600, the remembered identifier, secrets absent from every state snapshot),
`password.test.ts` (passwordLogin and stepUp against a fake fetch: request shape, every failure reason, retry-after, hint; `client.stepUp` uses the client's token),
`login.test.ts` (device login against a fake core: code reported once, polling until approved, retries on network errors, denied/expired/aborted/rejected/unreachable; the real flow is `apps/core/src/modules/auth/device.test.ts`), `client.test.ts` (every call carries the bearer token, against a fake server), `socket.test.ts` (path rules, a probe and a tokenless call over a Unix socket), `config.test.ts`
(round trip, private file mode, atomic write leaves no temp file, the client id kept in `client-state.json`), `presence.test.ts` (the reporter against a `Bun.serve` fake: one register, heartbeats with `active` only after `touch`, re-register after a boot change and a 401, goodbye once on stop, a down core never throws, the id kept, deliveries acked with the answer, a throwing handler acked `ok: false`), `attention.test.ts` (against a `Bun.serve` fake: one list per client, `GET /attention` with the
token, the three answers and their bodies, the reason, the optimistic removal, 409 stays gone and
500 puts the item back, feed events refetch: `pending-changed` and `brain.amygdala.wait` do, other
records do not), `reconnect.test.ts` (against a `Bun.serve` fake: an error notice follows a running turn, is retried while the core is unreachable, and `info` does nothing; history is read with `clip=2000`; a boot change refetches an idle session and follows it only when the snapshot says it runs; a busy session is left alone; the feed pings `/health` while a chat is busy), `feed.test.ts` (the feed streams typed brain events with the token, dedupes by seq, reads `boot`; `rpc.tasks.list` round trip), and `apps/core/src/e2e.test.ts` (the client drives a real core).
