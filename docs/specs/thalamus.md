# Thalamus

Code: `apps/core/src/modules/thalamus/app.ts` (`createApp`), `apps/core/src/compose.ts`
(`createCore`: shared machinery, boot order), `compose-regions.ts` (front and HTTP edge wiring),
`compose-timers.ts` (timers, reconcile and prune ticks), `apps/core/src/platform/{version,rpc,db}.ts`.

## Purpose

The single entry of the core: one Hono app that authenticates and routes every request.

## Routes

| Route | Auth | Handler |
| --- | --- | --- |
| `GET /health` | none | JSON `Health` |
| `/sessions/*` | credential, or the implicit owner of the local socket (opt-in local trust, `auth.md`) | `createHarnessHttp` (`eharness/http`): chat send/stream, messages, interrupt |
| `/rpc/*` | credential, or the implicit owner of the local socket (opt-in) | oRPC `RPCHandler` for `keithContract` with context `{ principal, via, ip, record }` |
| `POST /auth/device/start`, `POST /auth/device/poll` | none (code and poll secret) | `device` option: device login (`auth.md`); body at most 4 KB |
| `GET /auth/methods` | none | `auth` option: which login methods this caller's address may use; static, no audit (`auth.md`) |
| `POST /auth/login` | none (the password is the credential) | `auth` option (`createAuthRoutes`): username + password → device credential; network rule, throttling, body at most 4 KB (`auth.md`) |
| `POST /auth/step-up` | credential (a `device` or `token` session) | `auth` option: PIN or password → `elevatedUntil` (`auth.md`); same network rule and counters |
| `POST /auth/web/adopt`, `POST /auth/web/logout` | none (the credential in the body) / cookie or bearer | `auth` option: turn a credential into the session cookie, end the session and clear it (`auth.md`, "Browser sessions") |
| `GET /app`, `GET /app/*`, `GET /` | none | the web client build ("Web client" below), only when `web` is set; `/` redirects a browser (`Accept: text/html`) to `/app`, an API client gets the usual 404 |
| `/activity`, `/activity/*` | credential with `chat` | activity feed of `eharness/http` (stream and resync), only when `activity` is set; filtered per principal ("`/activity/*`" below) |
| `/attention`, `/attention/*` | token with `approvals.answer` | what waits for a person (approvals), `eharness/http` `attention`, only when `attention` is set (`amygdala.md`) |
| `POST /plugins/<id>/<op>`, `GET /plugins/openapi.json`, `GET /plugins/tui/menu` | credential, or the implicit owner of the local socket (opt-in) | `plugins` option (`createPluginRoutes`, `plugins.md`): thalamus resolves the principal and hands over `{ principal, via }`; the plugin module runs the operation through the same guard as the AI tool and answers; body at most 64 KB; every refusal of a hidden or denied operation is one `404`; the menu is the terminal views the caller may open (`plugin-views.md`) |
| `POST /nodes/join` | none (the pairing code) | `join` option: exchange a pairing code for a node token (`nodes.md`) |
| `GET /nodes/ws` | node token | not Hono: the core `fetch` upgrades it to a Bun WebSocket before Hono (`nodes.md`) |
| `GET /plugins/views/ws` | credential (bearer header, or the session cookie from the same origin) | not Hono: upgraded by the core `fetch` like `/nodes/ws`; also the one upgrade the local Unix socket serves (`fetchLocal`: 423 while locked, a bearer when trust is `none`); a plugin terminal view per socket (`plugin-views.md`) |

`createApp({ agent, tokens, credentials, router, health, audit?, device?, auth?, now?, lock?, activity?, attention?, plugins?, join?, web? })` builds it. It is a
`Hono<{ Bindings: CoreBindings; Variables: { principal } }>`: the server passes `{ via, ip, forwarded, keepAlive }` as `env` (`via`: `'local'` for the Unix socket, else TCP; `ip`: the socket peer address (`'local'` on the socket), used by the rate limits of `/nodes/join` and device login and by `last_ip`, never a forwarded header; `forwarded`: the request carried proxy headers; `keepAlive`: lifts the server idle timeout for this request). `lock` is the shared
`SessionLock` (SQLite, owned by the core's instance id, `resume.md`) passed to every session. With the stream log configured, `GET /sessions/:id/chat/stream` also replays turns that run in another process (`resume.md`). `activity` is `{ store, bootId, warn? }`.

### Local socket and the principal (resolved once)

`createCore` returns `fetch` (TCP: `/nodes/ws` upgrade, then Hono with `via: 'tcp'`) and `fetchLocal`
(Hono with `via: 'local'`, no WebSocket). `listenLocal` (`modules/local-socket`) serves `fetchLocal` with
`Bun.serve({ unix })` on `<dataDir>/core.sock`: the file is chmod 0600 after listen, a stale file
(nothing answers) is unlinked on start, a live one refuses the start (`core already running`), and
stop removes it. The socket has the TCP server's idle timeout (`SERVER_LIMITS.idleTimeout`, 30 s; `listenLocal` `idleTimeout`):
a connection that sends nothing for that long is closed, and an authorized request lifts it for its lifetime (`keepAlive` of `fetchLocal`), so a chat stream or the activity feed over the socket stays open. Without the option Bun's 10 s default would cut them. When `<dataDir>/core.sock` is longer than 100 bytes (macOS limit ~104) the path is
`$TMPDIR/keith-<12 hex of sha256(dataDir)>.sock`, recorded in `<dataDir>/core.sock.path`;
`socketPathFor(dataDir)` computes it for the server and every CLI. `probeSocket(path)` says whether
something answers. A Unix `Bun.serve` has no `idleTimeout` option; the body cap is passed.

A middleware on every route except `/health`, `/nodes/join`, `/nodes/ws`, `/auth/device/*`, `/auth/login` and `/auth/methods` resolves the principal with
`createPrincipalResolver(tokens, credentials).resolve(request, env.via, env.ip)`: `via: 'local'` is the owner with no token,
else the bearer header is checked (a `keith_s_` credential, or a legacy token; `auth.md`). The answer is stored per `Request` object, so the `authorize` hook of
`eharness/http` and the `/rpc` handler reuse it (`c.var.principal`): one lookup per request.

### Host allowlist, Origin and proxies

`Core.fetch` (every TCP request, before Hono, and the `/nodes/ws` upgrade) runs `createRequestGuard`
(`modules/thalamus/guard.ts`) first. Requests over the local socket skip it.

- **Host.** Allowed: `localhost`, `127.0.0.1`, `[::1]`, each only with the port core listens on (the
  `server.port` of the request, else the announced one; when neither is known the port is not
  compared); the host of the public URL (`access.publicUrl`, else `KEITH_PUBLIC_URL`, read per request
  so `access` applies live) on any port, so a proxy on 443 works; and every name in
  `KEITH_ALLOWED_HOSTS` (comma list, lower-cased; same any-port rule). Anything else, or a malformed
  Host, is `421` with a short text. A request built in process without a Host header uses its URL's host.
  This also stops DNS rebinding when core binds wider than loopback, and works with
  `tailscale serve` (Host `<machine>.ts.net`, set as the public URL).
- **Origin.** A request with an `Origin` header whose host is not allowed by the same rule (or `null`)
  is `403`. Requests without `Origin` (the CLI, nodes) are unaffected.
- **Proxies.** Core trusts no proxy. A request with `Forwarded`, any `X-Forwarded-*` or any
  `Tailscale-User-*` or `Tailscale-Funnel-Request` header is marked `env.forwarded = true` (`isForwarded`). It is still a TCP request
  (only the socket is local, so it is never owner-without-token) and needs a credential; its audit
  events carry `forwarded: true`. `X-Forwarded-For` is never used as the client address.
  `keith-core access remote --proxy tailscale-serve` stores setting `access.proxy` (`none` default),
  which the password routes use (`auth.md`, network rule): `tailscale-serve` lets a loopback peer with
  forwarding headers log in and logs `Tailscale-User-Login`; a Funnel request never may.

### The guest listener (`/guest/*`, a second port)

Guests (`guests.md`, ADR-0017) are served by a **second listener**, never by the main one: the main app has no `/guest` route (404), and a guest
bearer (`keith_g_<43 chars>`) is no credential there (`parseCredential` and the legacy token pattern do not match it: 401 on `/rpc`, `/sessions/*`,
`/activity`, `/attention`, `/nodes/*`, `/plugins/*`, `/auth/step-up`). Code: `modules/thalamus/guest-{app,http,listener,bearer,limiter,scrub}.ts`,
wiring `compose-guests.ts` (`createGuestFetch`), `Core.guestHttp` (`fetch(request, server)` and `plan()`), `run-core.ts` (`createGuestListener`).

- **Listener.** `createGuestListener` opens `Bun.serve` on `guests.port` (default 7421) **only while guests are on and not killed**, checks the settings
  every 2 s (`runCore` also calls `reconcile` at boot), closes the port when guests are disabled or the kill switch is on, and moves it when the port
  changes. The bind is `127.0.0.1` when `guests.zones` is only `loopback`, else `0.0.0.0` (the zone check is on the TCP peer). Body limit 64 KiB, idle
  timeout 30 s (a valid bearer lifts it, like the owner's). A bind failure is logged once per address and never stops the core. `RunOptions.guestPort`
  overrides the port (tests: 0).
- **Host guard of this listener.** `createRequestGuard({ literalIps: true, extraHosts: () => guests.hosts + machine names })`: a **literal IP address**
  (`192.168.1.5`, `[fd00::2]`) with the listening port, loopback names with the port, the machine's own names (`os.hostname()`, its short name,
  `<short>.local`; any port), `guests.hosts` (read per request) and the public URL host. Anything else is `421`, an Origin outside the same set `403`.
  A literal address cannot be DNS-rebound, so accepting one does not weaken the rebinding guard; names need the list. The main listener's guard is
  unchanged (a literal LAN address is still `421` there). **Verified on this machine** (dialling its own `en0` address: Host `10.x.x.x:port`, peer in
  zone `lan`); **not verified** against a phone or another computer (what Host header a given OS or `mDNS` resolver sends).
- **Routes** (everything else, `/rpc/*` included, is `404 GUEST_NOT_FOUND`): `GET /health` (`{ status: 'ok' }`), `GET /guest/status` (open, read-only, per-IP window of 30 a minute with its own bucket, `429 GUEST_RATE_LIMITED`: `GuestPublicStatus`
  `{ enabled, available, banner, limits }`, `enabled` false from a zone the owner did not allow, nothing about the owner or the model),
  `POST /guest/session` (start), `DELETE /guest/sessions/:id` (end, reason `closed`), and `createHarnessHttp` under `basePath: '/guest'`:
  `POST /guest/sessions/:id/chat[?ifBusy=]`, `GET /guest/sessions/:id/chat/stream`, `POST /guest/sessions/:id/interrupt`. `:id` is the `sessionId` of the start
  answer (`guest:<id>`, URL-encoded or not). No session list, snapshot or stored messages (they carry the model id and cost), no attention, no activity.
- **Start order** (`POST /guest/session`, body `{ clientKind? }`, at most 1 KiB): kill switch or disabled (`403 GUEST_DISABLED`) -> zone from the TCP peer
  with proxy headers never trusted (`zoneOf` with `proxy: 'none'`: a loopback peer carrying `Forwarded`, `X-Forwarded-*`, `Tailscale-*` or the Funnel header is `public`;
  not in `guests.zones`: `403 GUEST_ZONE`) -> per-IP window (`sessionsPerIpPerWindow` per 10 minutes on the keyed address hash, every attempt counts:
  `429 GUEST_RATE_LIMITED` with `Retry-After`) -> the owner-side gate and concurrency inside `registry.open` (`full` `429 GUEST_BUSY`; `daily-cap`, `monthly-cap`
  `429 GUEST_CAP`; `no-model`, `unpriced-model`, `no-limit`, `owner-floor` `503 GUEST_UNAVAILABLE`, one message for all) -> `201 GuestStartResponse`
  `{ sessionId, token, expiresAt, limits, notice }`. Messages are generic per code: a visitor learns nothing of the owner's setup.
- **Bearer.** `keith_g_` + 32 random bytes base64url, shown once. The store keeps `SHA-256(token)` and a keyed hash of the peer address (key random per process,
  never stored) per session, in memory. A request to `/guest/sessions/:id/*` needs the right token **from the address that started the session** and a zone
  still allowed; anything else, unknown sessions included, is `401 GUEST_UNAUTHORIZED` (one answer, no oracle). A session that ended answers `410 GUEST_SESSION_ENDED`
  `{ details: { reason } }` to its right bearer from its address for 10 minutes (a tombstone holds the hash and the reason, at most 1000), then `401`.
  An authorized request restarts the idle clock and lifts the idle timeout.
- **Chat.** One text part per message, 2048 characters (`413` over, `400` for a non-text part, both before a turn exists); only `send` (regenerate, edit and
  respond are refused); `?ifBusy=reject` only: a message while a turn runs is `409` (verified: it works for a session with no lock); body at most 16 KiB.
  Responses carry `x-keith-guest-notice` and `x-content-type-options: nosniff`.
- **Scrub.** The answer stream is filtered by an allow-list of chunk types (`guest-scrub.ts`): text, tool-call chunks, turn shape and the `data-eh.status` indicator pass;
  `data-eh.usage`, `data-eh.context`, notices, warnings and anything unknown are dropped, message metadata is cut to `{ eharness: { stop } }` (no model id, tokens, cost,
  duration, turn id), and an `error` chunk's text is replaced by the persona's guest line (`guestUnavailable`, read at the error; default the `professional` line; P33.3.4, guests.md). A provider error never reaches a visitor.
- **Rate-limit memory** holds at most 10 000 address hashes; past that a new address is told to slow down.
- **Guest page** (`/app/guest`, `createGuestFetch({ web })`, set from `config.web` and `config.webDir` unless `KEITH_WEB=off`). The listener serves the guest chat page of the web build with the same static helper as the owner's `/app`
  (`createWebStatic(dir, { guestOnly: true })`, `web-static.ts`): `/app/guest` and `/app/guest/` get the shell (the SPA starts on that route), files only under `/app/_app/` (the build's own assets, the same files as the owner's; none holds a secret) and `/app/favicon.svg`;
  every other path under `/app` (`/login`, `/chat`, the manifest, the service worker, `200.html`, the shell for any other route) is `404`, so this port never answers as the owner's app and the page has no service worker. `GET /` with `Accept: text/html` redirects to `/app/guest`; any other `/` is `404 GUEST_NOT_FOUND`.
  Same rules as the owner's `/app`: `GET`/`HEAD` only (`405`), the Host guard first (`421`), the CSP with the hash of the inline bootstrap script, the security headers. The owner routes stay `404` here (`guest-web.e2e.test.ts`). With `KEITH_WEB=off` there is no page and the guest API is unchanged.

### Audit hooks

`createApp` takes `audit` and passes each rpc call `record(kind, detail)` bound to the principal and
`via`; `platform/rpc.ts` has the middleware that records settings and node changes after a call
succeeds. Around `POST /attention/:id/answer` the app records `approval.answered` after the core
accepted the answer (`modules/audit/attention.ts`, never throws, no free text). See `auth.md` (Audit).

### `/activity/*`

With `activity` set, `createHarnessHttp` gets `activity: { store, bootId, filter: activityFilter }`
and the two routes are mounted. They use the same `authorize` hook as `/sessions/*`: no valid token
is `401`. The feed is filtered per principal (`activity-filter.ts`; the cursor still advances over
hidden records):

- everyone gets `node-changed` (the node list is shared by every person with `nodes.read`, ADR-0027 §9).
- everyone gets the events of their own sessions: `front:<theirId>` and the worker sessions
  `front:<theirId>:agent:<task>` (turns, tools, memory, tasks, `task-changed`, their approvals). The
  person comes from the record's session id alone; `emit` also stamps `personId` into every brain
  payload (`brain-events.md`);
- plugin events (`plugin.<id>.<event>`, one record per recipient, `plugins.md`) go only to the person named in the payload's `to`, and to everyone when it is `*`; the owner gets no one else's (they are sessionless, so this rule runs before the system-event rule);
- shared rooms (`corpus-callosum.md`, "Transport"): a `room.event` and a `room.indicator` go only to the person named in `to` (the owner
  who is not a member gets neither); the owner gets the room
  lifecycle records (`room.*` other than `room.turn.*`) and no turn record; a record of a room session (`room:` id) or of the room's turn
  brain event reaches no one through this path. These rules run before the session rule, because a room session is no person's;
- the owner (by role, so it follows a transfer) also gets **system events** (no session: `node-changed`,
  global `budget-changed`) and `brain.amygdala.wait` of another person's session when the item is
  one the owner answers (`motor_remote`, `amygdala.md`). That event holds the tool name, session id
  and a count, never a message preview;
- nothing else of another person reaches the owner: no `brain.thalamus.routed` (previews), no turns,
  tasks or memory events of members. A member gets no system events.

**Open streams** (P23.1.10, `open-streams.ts`): `/activity/*`, the `/sessions/*` streams and
`/attention` are handed to eharness through a registry (`createOpenStreams`) that keeps
`{ personId, credentialId, role, grants key, controller }` per request and gives eharness a copy of the
request whose `signal` is a child of the controller (eharness listens only to `request.signal`). A
stream ends (the client reconnects, is resolved again and gets 401, or a new filter after a grant
change) when: the credential is revoked (`credentials.revoke` and `tokens.revoke`, wrapped in
`compose-identity.ts`, so every call site counts); the person's sessions are revoked (suspend, role
change, owner transfer, password change; `revokeSessions`); the person is removed; a capability is
granted or revoked. All of them go through `onAccessChanged(personId, reason)`. A backstop sweep every
30 s re-checks credential (revoked, idle and absolute expiry), person (`active`), role and capability
set against the values at open and fails closed (a throw closes). Every request is authorised again on
arrival, so a reconnect and a `resync` never use an old answer. The same hook writes the record
`identity.changed` (`IdentityChangedRecordSchema`: `personId`, `reason` of `grant`, `revoke`,
`suspend`, `role`, `transfer`, `remove`, `can_login`, `credential`; nothing else) on the person's front
session id, so `activityFilter` shows it to that person only. (`can_login` is reserved: it has no
writer yet.)

The feed
carries no history, so a client loads `tasks.list` on boot and on resync (`client.md`). Without
`activity` the routes do not exist.

### Activity feed records

Every record the feed can carry, by type. "Receives" is the rule of `activityFilter`
(`apps/core/src/modules/thalamus/activity-filter.ts`): **own** = the person of the record's session
(`personOfSession`); **owner** = the owner by role, for sessionless system records. Records with a Keith
contract parse with `ACTIVITY_RECORD_SCHEMAS` (`packages/contracts/src/activity.ts`) or the schema named
in the row. Every record type the core writes is in this table; a new writer adds its row in the same commit.

| Record | Written by | Receives | Payload contract |
| --- | --- | --- | --- |
| `node-changed` | `nodes/registry.ts` (connect, offline, revoke), `nodes/pairing.ts` (pair) | everyone with `nodes.read` (first rule of the filter) | `NodeChangedPayloadSchema` `{ node }` (`nodes.ts`), no session |
| `budget-changed` (global) | `budget.set` | owner only (no session) | `BudgetChangedRecordSchema` `{ status }` (`activity.ts`), no `personId` |
| `budget-changed` (person cap) | `budget.setPersonCap`, on the person's front session | that person only; the owner never gets it | `BudgetChangedRecordSchema` `{ status, personId }` |
| `task-changed` | `tasks/board.ts`, on the task's parent session | own (the delegating person) | `TaskChangedPayloadSchema` `{ task }` (`tasks.ts`) |
| `identity.changed` | `compose.ts` (`onIdentityChanged`), on the affected person's front session | that person only; the TUI reads `whoami` again on it (`tui.md`) | `IdentityChangedRecordSchema` `{ personId, reason }` (`activity.ts`); reasons `grant`, `revoke`, `suspend`, `role`, `transfer`, `remove`, `can_login`, `credential`; `can_login` has no writer yet |
| `persona.changed` | `modules/prefrontal/service.ts` (P33.2.3, once per persona version written: `setTemplate`, `edit`, `restore`); no writer before that step | everyone with `chat`; a global record with no session and no text (the feed shows "the owner changed Keith's persona") | `PersonaChangedRecordSchema` `{ version, reason }` (`persona.ts`); no persona text |
| `delivery.failed` | `delivery/delivery.ts` (`finalFailure`), on the recipient's front session | the recipient only (no text) | `DeliveryFailedRecordSchema` `{ personId, deliveryId, source, reason }` (`delivery.ts`) |
| `plugin.<plugin>.<event>` (also `plugin.<id>.notice`, `plugin.reviews.<event>`) | `plugins/feed.ts`, one record per recipient | `to` only; `to: '*'` for everyone; the owner never gets another person's | `PluginEventPayload` `{ plugin, event, to, data }` (`plugin-events.ts`) |
| `chat.context.pending` | `wernicke-broca/context-service.ts` (`newContext`, `compact`), on the person's current front session: `start` before the flush or compaction, `end` in a `finally` | own only (the session rule; the owner never gets another person's) | `ChatContextPendingRecordSchema` `{ kind: 'new' \| 'compact', state: 'start' \| 'end', ok? }` (`chat-context.ts`), no text |
| `brain.thalamus.routed` | `thalamus/app.ts` (`chat.validate`) | own; the owner never gets it (previews) | `ThalamusRoutedPayloadSchema` (`brain.ts`) |
| `brain.wernicke.start` | `brain-events/plugin.ts` (front `turn.start`) | own | `WernickeStartPayloadSchema` |
| `brain.broca.start` | `brain-events/plugin.ts` (front `turn.start`) | own | `BrocaStartPayloadSchema` |
| `brain.broca.end` | `brain-events/plugin.ts` (front `turn.end`) | own | `BrocaEndPayloadSchema` |
| `brain.cortex.start` | `tasks/board.ts` (worker `turn.start`) | own | `CortexStartPayloadSchema` |
| `brain.cortex.step` | `tasks/board.ts` (worker `step.end`) | own | `CortexStepPayloadSchema` |
| `brain.cortex.end` | `tasks/board.ts` (worker `turn.end`) | own | `CortexEndPayloadSchema` |
| `brain.motor.act` | `brain-events/plugin.ts` (`step.end` tool results) | own | `MotorActPayloadSchema` |
| `brain.amygdala.decide` | `brain-events/plugin.ts` (`approval.decided`) | own | `AmygdalaDecidePayloadSchema` |
| `brain.amygdala.wait` | `amygdala/pending.ts` (`watchPending`) | own; the owner also gets a member's `motor_remote` wait | `AmygdalaWaitPayloadSchema` |
| `brain.amygdala.expired` | `amygdala/expiry.ts` (sweeper) | own | `AmygdalaExpiredPayloadSchema` |
| `brain.ras.deliver` | `ras/proactive.ts` (`turn.end` of a wake) | own | `RasDeliverPayloadSchema` |
| `brain.hippocampus.write` | `hippocampus/hippocampus.ts` (`memory({ onWrite })`) | own | `HippocampusWritePayloadSchema` |
| `brain.hippocampus.recall` | `brain-events/plugin.ts` (`step.end`) | own | `HippocampusRecallPayloadSchema` |
| `pending-changed`, `approval-decided`, `attention-answered` | eharness `activity()` and `answerAttention()` | own (the session's person) | eharness spec 25 §2 (no Keith schema) |
| `turn-started`, `step-finished`, `turn-ended`, `child-reported`, `session-recovered`, `compaction` | eharness `activity()` (`wernicke-broca/agent.ts`, `cortex/workers.ts`) | own | eharness spec 25 §2 (no Keith schema); `message-saved` is off (`messages: false`) |
| `room.event` | `corpus-callosum/transport-text.ts` (`createRoomFeed`, one record per active member of the room, at each line) | the person named in `to` only; a non-member and the owner (unless they are `to`) get nothing | `RoomEventRecordSchema` `{ to, roomId, seq }` (`activity.ts`); no text, the client refetches `rooms.events` |
| `room.indicator` | `corpus-callosum/transport-text.ts` (`createRoomFeed.notifyIndicator`, one record per active member when the indicator changes) | the person named in `to` only; a non-member, an invitee and the owner (unless `to`) get nothing | `RoomIndicatorRecordSchema` `{ to, roomId }` (`activity.ts`); no indicator value, the client refetches `rooms.get` |
| `room.*` lifecycle (`room.create`, `room.end`, `room.owner-end`, the other audit kinds of the rooms) | the room service (P30.2.4) | the owner only; never `room.turn.*` | no Keith contract yet (the audit kinds carry theirs, `audit.ts`) |
| `brain.corpus-callosum.turn` | the room service, one per room turn | nobody through the feed (a turn's text is read by the room's members through `room.event`) | `CorpusCallosumTurnPayloadSchema` (`brain.ts`) |
| `brain.parietal.presence` | `parietal/service.ts` (recompute on a signal or every minute, on a change of state) | own (the person's front session) | `ParietalPresencePayloadSchema` |
| `brain.parietal.deliver` | `parietal/client-route.ts` (`parietal.callClient`, one per client route) | own; only the client named in `clientId` acts on it | `ParietalDeliverPayloadSchema` |
| `brain.hypothalamus.fire` | `hypothalamus/journal.ts` (a protocol run starts) | own (the run's person); a `keith`-owned run goes to the owner's front session | `HypothalamusFirePayloadSchema` (`brain.ts`) |
| `brain.hypothalamus.step` | `hypothalamus/journal.ts` (a step outcome is written; `started` is not written) | own; `keith`-owned runs as above | `HypothalamusStepPayloadSchema` |
| `brain.hypothalamus.wait` | `hypothalamus/journal.ts` (a run starts waiting: `wait`, `ask`, quiet hours, a delayed event) | own; `keith`-owned runs as above | `HypothalamusWaitPayloadSchema` |
| `brain.hypothalamus.end` | `hypothalamus/journal.ts` (a run ends) | own; `keith`-owned runs as above | `HypothalamusEndPayloadSchema` |


### `brain.thalamus.routed`

The `chat.validate` option runs after `authorize` on the sanitised body. For `kind: 'send'` it emits
`brain.thalamus.routed` (`{ region: 'thalamus', sessionId, preview }`, first 120 characters of the
last user message) through the fire-and-forget `emit` and never denies. The same `send` calls `onRouted(personId)`, which the
parietal service turns into one `activity` signal of that person (`parietal.md`). A guest message does not pass here (the guest
listener is its own app), so it writes no signal. See `brain-events.md`.

With `consent` set (`ChatMessagePort`, `amygdala.md` "Asked in conversation") the same `validate` first hands every `send` (the text of the newest user message, the principal, the listener `tcp` or `local` that
the tracked request came in on) to `consent.message`. It records the client's step-up and, when a request asked in conversation waits, may answer it from the message; a message that was only the answer is
not sent to the agent and the route answers `202 { inboxId, delivered: 'steer', target: 'local', consent }` (the shape of a queued message). Every other message goes on as before. It never throws.

### `/attention/*`

With `attention` set (`attentionOptions`, `amygdala.md`) `createHarnessHttp` gets it and the two
routes are mounted. Same `authorize` hook: no valid token is `401`; the per-session check is the
`canAnswer` of the attention options (the session is in the body, not in the path).

### `POST /nodes/join`

With `join` set, `POST /nodes/join` calls it with the request and the caller's address
(`c.env.ip`, else `unknown`). It needs no token: the pairing code is the credential. Everything
else about it is `nodes.md`. The body is capped at 16 KB (`413 TOO_LARGE`).

### Idle timeout and body size

The same middleware calls, for a resolved principal (a valid token, or the socket), `env.keepAlive()` (`server.timeout(request, 0)`), so authorized streams (`/sessions/*`,
`/activity/stream`, `/attention`, oRPC) never idle out. A request without a valid token keeps the
server's idle timeout (30 s), so a connection that never authenticates is closed. `Bun.serve` also
sets `maxRequestBodySize` to 1 MB (`SERVER_LIMITS` in `platform/net.ts`). The node WebSocket has
its own idle handling (Bun's websocket `idleTimeout`; node heartbeats keep it busy).

### `/sessions/*` authorization

The `authorize` hook of `eharness/http` calls `verifyAuthorization` on the `authorization`
header:

- no valid token: `{ deny: 401 }`;
- a valid token and a `sessionId` other than the caller's current front session, `frontSessionId(personId, current
  generation)` (`front:<personId>` or `front:<personId>:g<n>`, see `chat-context.md`): `{ deny: 404 }` (a person reaches
  only their own current front session, and does not learn that others exist; an older generation id of their own
  answers 404 as well, ADR-0030 §6);
- otherwise the `Principal`.

### Capabilities

`createApp` takes `capabilities` (`Capabilities`: role table plus grants; default the role table).
The `authorize` hook of `eharness/http` maps the route to a capability (`chat` for sessions and the
activity feed, `approvals.answer` for `/attention`, none for `/health`) and answers `403 FORBIDDEN`
when the principal lacks it. `/rpc/*` puts `capabilities.of(principal)` in the call context; the rpc
middleware checks each procedure's metadata (`permissions.md`).

### Web client (`/app`, `modules/thalamus/web-static.ts`, ADR-0035)

`web: { dir }` (set by the composition unless `KEITH_WEB=off`) serves the SvelteKit build (`adapter-static`, fallback `200.html`, base
path `/app`) from `KEITH_WEB_DIR` (default `<repo>/apps/web/build`). The route needs no sign-in (the page is public; every call it makes is
authenticated) and runs after the Host and Origin guard.

- **Files.** `GET`/`HEAD` of `/app` or `/app/*` (anything else is `405`). The path is URL-decoded, normalised, refused when it holds a NUL or a
  backslash or leaves the folder, and the real path of the file (symlinks resolved) must stay inside the real folder. A file is served with
  its type; `/app`, `/app/` and any path without a file extension fall back to `200.html` (client routing). A missing asset (a path under
  `/_app/`, or with an extension) is a `404`, never the shell, so a stale tab never receives HTML where it expects JavaScript.
- **PWA files.** `manifest.webmanifest` is `application/manifest+json` and `service-worker.js` is JavaScript; both are `no-cache` (an update of the worker is fetched at the next load). The worker's scope is its own folder, `/app/`, so no `Service-Worker-Allowed` header is sent; the page CSP covers the manifest, the worker and the icons (`web.md`, "PWA").
- **Cache.** Under `/app/_app/immutable/`: `Cache-Control: public, max-age=31536000, immutable`. HTML and every other file: `no-cache`.
- **Not built.** When the folder or `200.html` is missing, every `/app` request is `404` with a short text naming
  `bun run --cwd apps/web build`.
- **Headers on every `/app` answer.** `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; connect-src 'self';
  img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. SvelteKit's single-page shell has one inline
  bootstrap `<script>`, so the core computes the SHA-256 of every inline script of `200.html` when it loads the file (again whenever the
  file changes) and lists the hashes in `script-src`: no `'unsafe-inline'` for scripts, and `apps/web` needs no `kit.csp`.
- **Config** (`platform/config.ts`): `KEITH_WEB` (`on` default, `off` removes `/app` and the `/` redirect; the API is unchanged) and
  `KEITH_WEB_DIR` (an absolute or relative folder).
- **Cookie rules** of the middleware (`cookie-guard.ts`): the CSRF refusal of a cookie-authenticated write and the clearing of a rejected
  cookie (`auth.md`, "Browser sessions").

### `/rpc/*`

Without a valid token the response is `401` with
`{ "error": { "code": "UNAUTHORIZED", "message": "missing or invalid token" } }` and the handler
never runs. With one, an unmatched path is a plain 404. Procedure errors follow `providers.md`.

### `/health`

`{ status: 'ok', version, sha, boot }` (`HealthSchema`). `version` is the root `package.json`
version. `sha` is `KEITH_BUILD_SHA`, else `git rev-parse --short HEAD` at boot, else `unknown`.
`boot` is a UUIDv7 created at core start: a changed value tells a client the core restarted.

## Composition (`createCore`)

Order: open database (`assertMigrated`; an unmigrated database refuses boot of `createCore` with "run `bun run
db:migrate`"; `runCore` migrates first, see "Composition" below) → vault (warn on dev key) → `ensureOwner` (creates the owner person, no token) →
provider service (`ready()`) → activity store (wrapped by `watchPending`, `amygdala.md`), the parietal service (`createParietal` in `compose-parietal.ts`: presence tables, removal part; `parietal.md`), tasks repo, `buildInfo`, nodes (`createNodes`: registry, gateway, pairing, in-process `core`), Cortex and front agent (SQLite message/state/
inbox adapters, delegation wired, both get the node registry) → plugins (`createPlugins`: the loader boots each built-in plugin in isolation, registers capabilities and kinds, compiles them for the front agent; `plugins.md`; the host is built before the agent) → reconcile, presence recompute (`parietal.recomputeAll`) and prune once, then their timers (reconcile, expiry, prune, and the presence recompute every `CoreTiming.presenceEveryMs`) → health and router
(`health.get`, `providerProcedures`, `adminProcedures` (`auth.logout`, `admin.access|tokens|devices|audit.*`), `tasks` and `nodes` procedures) → `createApp` with `sqliteLock`, `activity`, `attention` and `join`. `Core` exposes
`fetch`, `fetchLocal`, `websocket`, `acl`, `kinds`, `plugins` (the plugin host: `status()`, `loaded()`, `guard`), `network()` (effective bind host, port and public URL: env, then `access.*` settings, then defaults), `announce(bound)` (the listener reports where it bound; `admin.access.get` and the node join URL use it), `health` and `close()` (clears the timers, closes the node sockets and
stops their sweeper, closes the front agent and the workers, stops the plugins (reverse boot order), disposes the manager, closes SQLite). `runCore`'s `stop` closes the guest listener, the TCP and socket servers and then `close()`; `core.lock` is released in a `finally`, so a failing step still leaves no lock (`logging.md`, Shutdown and crash).
`fetch(request, server?)` first applies the Host/Origin guard, then answers `/nodes/ws` and `/plugins/views/ws` itself (authenticate, `server.upgrade`; `426` without a
`server`) and gives everything else to Hono with `{ via: 'tcp', forwarded, ip: server.requestIP(request) }`. A caller must
pass both `fetch` and `websocket` to `Bun.serve`. `websocket` is **one dispatcher** (`compose-views.ts`, `dispatchSockets`): it hands every event to the node gateway or to the view gateway by `ws.data.kind` (`'view'`, else a node socket, whose data has `kind: 'node'` or none); neither handler knows the other, and the node gateway's behaviour and tests are unchanged. `Core.views` (`snapshot()`) and `Core.viewSockets()` report the open views and view sockets.
`CoreTiming` (tests shorten it): `inboxPollMs`, `reconcileEveryMs`, `pruneEveryMs`, `nodeHeartbeatMs`,
`nodeHeartbeatTimeoutMs`, `nodeSweepEveryMs`, `pairingTtlMs`, `nodeTimeoutGraceMs`, `removedKeepMs`, `deliveryTickMs` and `deliveryRetryMs` (the delivery retry tick and waits, `delivery.md`), `retention` (the periods of
`db.md` "Retention", `platform/retention.ts`). The prune tick (`pruneEveryMs`, also once at boot) runs in this order: activity
feed, owner reviews, audit retention, device logins, the removed-person purge, then `pruneRetention` (ended credentials, client
tokens, finished tasks, dead letters, closed budget reservations; one `data.pruned` row per table that lost rows), then the stream
log's `purgeExpired` (expired turns' chunks). Delivered and failed deliveries are pruned there too (`deliveriesMs`, 7 days). Boot: `delivery.start()` runs one retry tick right after the plugins' schedules start, then every `deliveryTickMs`; `close()` stops it.
Details of the delegation parts: `cortex.md`, `tasks.md`.
`run-core.ts` (`runCore`, used by `keith-core start` and `main.ts`) refuses an ahead, diverged or unreadable database (`dbState`, P26.1.6) before anything else touches it, creates the data folder private, takes `<dataDir>/core.lock`, migrates a new database or snapshots and then migrates a behind one (`migrateWithBackup`), runs `createCore`, serves TCP with `Bun.serve({ hostname, port, fetch, websocket, ...SERVER_LIMITS })` (host and port from `core.network()`: `KEITH_HOST` then the `access.host` setting then `127.0.0.1`; `KEITH_PORT`, default 7420), serves the socket, and logs both. The backup of ADR-0027 §3 is in place: `<dataDir>/backups/keith-<timestamp>.db` through `VACUUM INTO` before any migration of a behind database; `db migrate` takes `core.lock`. A non-loopback bind logs a warning (no TLS: use Tailscale or a private network; `bindWarning`). It prints no token. `main.ts` only calls `bootstrap()` (`platform/bootstrap.ts`: umask 077, config, logger) and `runCore`. Config is read only in `platform/config.ts`.

## Invariants

- The core binds to loopback unless `KEITH_HOST` says otherwise.
- The owner API exists on the main listener only; the guest listener serves `/health` and `/guest/*` and nothing else.
- Only `/health`, `POST /nodes/join` (pairing code), `GET /nodes/ws` (node token) and `POST /auth/device/start|poll` (code and poll secret) `POST /auth/login` (the password, behind the network rule of `auth.md`) `POST /auth/web/adopt` (a credential in the body), `GET /app/*` (the web client build) and `GET /auth/methods` (a static answer) are reachable without a credential or the local socket.
- No TCP request with a Host or Origin outside the allowlist reaches a route.
- `/app` is the only unauthenticated static route; a cookie-authenticated write is same-origin or refused.
- `via: 'local'` comes only from `fetchLocal`, which only the Unix socket listener calls.
- A person never reaches another person's session.
- No business logic in `compose.ts` or `main.ts`.

## Tests

`apps/core/src/e2e.test.ts`: refusal of an unmigrated database, first token and open `/health`
with build info, 401 on `/sessions` and `/rpc` without a token, 404 for another person's session,
streaming chat, model switch, credentials never in clear, history surviving a restart.
`apps/core/src/delegation.e2e.test.ts`: `/activity` feed with `brain.thalamus.routed` first, `tasks.*` over `/rpc`.
`modules/thalamus/principal.test.ts`, `modules/local-socket/local-socket.test.ts`: socket mode 0600, owner over the socket without a token, 401 over TCP, stale and live socket files, path fallback.
`modules/auth/methods.test.ts`: `GET /auth/methods` (loopback, local, Tailscale, public, forwarded headers, funnel, `access.proxy`, `KEITH_INSECURE_LOGIN`, no account data, no audit, open on a running core, foreign Host 421).
`modules/auth/login.e2e.test.ts`: `/auth/login` and `/auth/step-up` over a real listener (network rule matrix, `KEITH_INSECURE_LOGIN`).
`modules/thalamus/guard.test.ts`: foreign Host refused on `/health`, `/rpc` and `/nodes/ws`, loopback port rule, public URL host (env and live `access`), `KEITH_ALLOWED_HOSTS`, Origin, socket unaffected, forwarded headers never local, `access --proxy`.
`modules/thalamus/guard.test.ts` also covers the guest listener's guard (literal addresses, listed names, per request list, the main guard unchanged). `guests-http.e2e.test.ts`: the guest routes in a booted core (isolation matrix: no credential, wrong or owner bearer, another address or session, guest bearer on every owner route, 410 after an end, kill switch, zones, per-IP window, busy 409, banner, no model or cost in the stream); `modules/thalamus/guest-{bearer,scrub,listener}.test.ts` (bearer and IP hashes, the stream scrub, a real listener that opens and closes with the settings and dials the machine's LAN address).
`modules/thalamus/web-static.e2e.test.ts`: `/app` (shell, fallback, immutable cache, CSP hash, traversal and symlink refusal, 404 for a missing asset, missing build, `KEITH_WEB=off`, the `/` redirect, Host guard); the cookie rules are in `modules/auth/web-session.e2e.test.ts`.
`apps/core/src/serve.test.ts`: 413 on a large join body, idle timeout. `platform/net.test.ts`: loopback and bind warning.
`apps/core/src/node-pairing.e2e.test.ts`, `motor.e2e.test.ts`: `/nodes/join`, `/nodes/ws`, `/attention` over a real server.
