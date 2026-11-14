# Guests (anonymous, incognito)

Code: `packages/contracts/src/guests.ts` (schemas, defaults, limits, audit kinds, the HTTP shapes), `apps/core/src/modules/guests/` (settings, procedures,
budget wiring, registry, agent factory, sweeper), `apps/core/src/modules/thalamus/guest-*.ts` (the guest listener: `thalamus.md`, "The guest listener"). ADR: `docs/decisions/0017-guest-mode.md`. Plan:
`docs/plans/done/P17-guest-mode.md`. Status: steps 1-9 (contract, settings and admin, budget wiring, registry, guest HTTP, public tools, audit and redaction, peek and banner, the guest client and the TUI: `client.md`, "Guest client"; `tui.md`, "Guest mode"); the leak gate, the smoke steps and the owner scenario (`manual-testing.md`, scenario 15) are steps 10 and 11. All eleven steps are done.

## Purpose

An owner who enables it lets anonymous visitors chat with a tiny read-only Keith about the owner's public things. Nothing a guest says is
stored, the owner pays inside hard caps, the owner can watch a live session (guests are told), and a test proves nothing leaks.

## Who is a guest

A guest is not a person: no `people` row, no credential, no durable identity. It exists as an in-memory registry entry (`GuestRegistry`)
and a bearer `keith_g_<32 random bytes, base64url>` (`GUEST_BEARER_PREFIX`). Its ACL actor is `{ kind: 'guest' }` (guest ceiling, `acl.md`). A
guest session id is `guest:<random>`; `personOfSession` returns `undefined` for it (it does not start with `front:`), so no per-person path
(memory, tasks, budget scope, dead letters) can pick it up.

## Settings (`guests.*`, `GuestSettingsSchema`, strict)

| Key | Default | Bounds |
| --- | --- | --- |
| `enabled` | `false` | enabling needs a priced `guest` model role (below) |
| `zones` | `['lan']` | subset of `loopback, lan, tailscale, public`; `public` only with an `https:` public URL (ADR-0014) |
| `port` | 7421 (`DEFAULT_GUEST_PORT`) | 1..65535 |
| `hosts` | `[]` | up to 20 extra Host names for the guest listener |
| `maxConcurrent` | 3 | 1..50 |
| `sessionsPerIpPerWindow` | 5 per 10 minutes | 1..100 |
| `maxTurns` | 20 | 1..200 |
| `idleMs` | 30 minutes | 1 min..24 h, at most `absoluteMs` |
| `absoluteMs` | 2 hours | 1 min..24 h |
| `dailyUsd` | 0.50 | > 0, at most 1000 |
| `monthlyUsd` | 5 | > 0, at most 10000 |
| `sessionUsd` | 0.10 | > 0, at most 100 |

Stored one key each in `settings` (`guests.<name>`); a missing or invalid stored value reads as its default (never throws). The kill switch is
`guests.killed` (boolean). Not settings (`GUEST_LIMITS`): input 2048 characters, `maxSteps` 3, 800 output tokens per turn, the 10 minute
window, the owner floor of 25 percent.

**Behind a proxy.** By default the guest listener trusts no proxy: it uses the TCP peer as the address, so behind a reverse proxy every visitor shares one address and one per-IP window. The owner may name the proxy (ADR-0027 §21): `guests.trustedProxy` is `none` (default), `cloudflare` (`CF-Connecting-IP`) or `x-forwarded-for` (the right-most entry that is not a proxy), with `guests.proxyAddrs` (IPs or CIDRs, at most 16, non-empty unless `none`). The header counts only when the TCP peer is inside `proxyAddrs`; the address then keys the per-IP windows, the bearer bind and `ipHash`. The zone is still decided from the TCP peer and the forwarding-header rule, so a proxied visitor is `public`. Set it with `keith-core guests set --trusted-proxy <value> --proxy-addr <cidr>` (owner, step-up, audited with before and after). `keith-core doctor` warns when the `public` zone is on and `trustedProxy` is `none`. Per ADR-0027 §22 (in code): `registry.open` rechecks the kill switch and `enabled` after its await, `GET /guest/status` reads limits without seeding the ledger and has its own per-IP limit, and the TUI lets the server end a session at the turn cap so the reason is `turn-cap`; (§20) a dead letter of a guest session is only logged.

## Model role `guest`

`ModelRoleSchema` is `front | cortex | guest`; `ModelRolesSchema.guest` is `ref | null` (optional on the wire for older cores). Unlike the
other roles it has **no default**: `roles().guest` is `null` until the owner picks one (`models.roles.set`, `keith-core model set guest ...`; for `guest` it needs `guests.manage`, and `models.roles.get` shows the field only to holders of it). Enabling guests is refused with `BAD_REQUEST` while the role is unset or its model is **unpriced** in the catalog (the ledger
would be blind: `W_MODEL_UNPRICED`, cost counted as 0). A manual price (`models.price.set`, `keith-core model price set`) makes the model priced. `PRIMARY_MODEL_ROLES` (`front`, `cortex`) is what setup asks for.

## Budget (owner paid, caps)

A guest turn reserves on three scopes, never on a person scope: `owner` (the global scope, so guests count in the owner's true total),
`guests` (the month) and `guests:day:<YYYY-MM-DD>` (UTC). The ledger's period is the calendar month, so the per-day scope is simply a scope
whose name changes each day. **A ledger scope without a limit always accepts spending**, so `guestConfig()` seeds every scope with
`setBudgetLimit` before use (`guests` = `monthlyUsd`, today's = `dailyUsd`) and entry refuses when a guest scope has no limit (`no-limit`; the owner's global scope may be unlimited, the guest scopes still cap).
Entry is also refused when the owner's global scope has less than 25 percent of its monthly limit left (`owner-floor`; an owner with no limit
is never floored). Per turn the agent also carries `maxTurnUsd = min(sessionUsd, 0.05)` (`GUEST_TURN_USD`) and `maxSessionUsd = sessionUsd`. Implemented in `modules/guests/guest-budget.ts` (`createGuestBudget`: `scopes`, `seed`, `config`, `block`, `view`) and `gate.ts` (`createEntryGate`, the owner-side entry order).

`GuestBlock` (first match wins, in this order): `killed`, `disabled`, `no-model`, `unpriced-model`, `no-limit`, `owner-floor`, `daily-cap`,
`monthly-cap`, `full` (concurrency). Host, zone and per-IP checks come before these on the HTTP path (`thalamus.md`, "The guest listener").

## The session agent (`modules/guests`)

`createGuestRegistry(options)` (`registry.ts`) owns every live session in a `Map` and is the `GuestSessionsPort` of the owner surface. `core.guests`
is that registry (the HTTP layer of step 5 opens sessions through it). API:

- `open({ zone, ipHash, clientKind? })` -> `{ ok: true, session, expiresAt }` or `{ ok: false, block }`: the owner-side gate (`createEntryGate`), then
  concurrency checked again and the entry inserted **with no await in between** (50 parallel starts give at most `maxConcurrent`), then a new agent.
  `GuestSession` = `{ id, sessionId: 'guest:<id>', zone, ipHash, clientKind, agent, limits, info() }`; `id` is 16 random bytes (base64url).
- `get(id)`, `touch(id)` (a request arrived: the idle clock restarts), `size`, `list()` (`GuestSessionInfo[]`), `end(id, reason)`, `endAll(reason)`,
  `sweep()` (ends idle and absolute sessions; the timer calls it every `sweepEveryMs`, default 15 s, `unref`'d), `close()` (stops the timer and ends all
  with `restart`).
- `onEnd(audit)` receives one `GuestSessionAudit` per ended session (counts only; the core writes it to the audit log: "Recording and audit"). `now`, `graceMs`, `newId`,
  `sweepEveryMs` are injectable for tests.

Each session is **one tiny agent** built by `createGuestAgent` (`guest-agent.ts`) with `defineHarnessAgent`:

- storage: eharness' default memory adapters (no `storage` option), **no** inbox, stream log, activity store, hippocampus memory, lock, compaction
  (`compaction: false`) or recovery (`recovery: false`). A test reads the sources of `registry.ts`, `guest-agent.ts` and `guest-limits.ts` and fails if one
  imports a database, storage, activity or memory module; another scans every table of the database and every file of the data directory for a sentinel
  typed and answered in a session;
- model: the `guest` role resolved each turn (`turn.prepare`, `resolveRoleModel('guest')`); the agent's own model is `unconfiguredModel('guest')`;
- tools: the plugins passed to the registry (core: only those that own an allow-listed tool) plus a static allow-list (`GUEST_TOOL_ALLOWLIST` = `notes_public_get`, `notes_public_list`; the guest actor and its limits: `plugins.md`, "Guests in the guard"). `turn.prepare` sets `activeTools` to
  the allow-list (the model is not even offered the others) and `tool.approve` denies any other name; a denied call is counted as a refusal. An approval
  can never be asked of the owner;
- instructions: `GUEST_INSTRUCTIONS`, English text saying the visitor is anonymous, only public tools exist, nothing private, nothing is remembered, and
  that note and visitor text are data. No person name, memory, provider, model or price, path or node;
- limits: `loop.maxSteps` 3, `settings.maxOutputTokens` 800, the budget config of `GuestBudget.config()` (three scopes, `maxTurnUsd`, `maxSessionUsd`), and
  the `guest-limits` plugin: `input.submit` refuses (`persist: false`, so the text is dropped) a message with a non-text part (`file-part`), over 2048
  characters (`input-too-long`) or past `maxTurns` (`turn-cap`); `turn.end` adds tokens and cost and asks the registry to end the session.

A session ends by `end(id, reason)` (`GuestEndReason`): the entry is **deleted from the map first** (a second end is a no-op), then
`agent.close({ inFlight: 'abort' })`, then `onEnd`. Reasons: `closed` (visitor), `idle` (no traffic for `idleMs` and no turn running), `absolute`
(`absoluteMs` after the start, whatever it does), `turn-cap` (the last allowed turn finished; the session closes after `graceMs`, default 3 s, so the answer
is delivered, and a message in between is refused), `cost-cap` (a turn stopped on a budget cap, same grace), `killed` (kill switch, disable or owner `end`),
`restart` (the core closed gracefully; after a crash the sessions are simply gone, by design). Limits are those of the settings at open time.
`registry.list()` is `GuestSessionInfo[]` (random id, zone, ip hash, times, turns, cost; no text).

Verified (P17 open verifications 1 and 3 of the plan): after `end`, a `WeakRef` to the agent and to the session is cleared by a GC, while an
open session is not; a guest and the front agent answer concurrently in one core.

## oRPC (owner only, `guests.manage`, step-up for every call that changes something)

| Procedure | Capability | Input | Output |
| --- | --- | --- | --- |
| `admin.guests.get` | `guests.manage` | none | `GuestStatus` |
| `admin.guests.set` | `guests.manage`, sensitive | `GuestSettingsPatch` | `GuestStatus` (audit `guest.settings` with before and after) |
| `admin.guests.killswitch` | `guests.manage`, sensitive | `{ on }` | `{ ended }` (audit `guest.killswitch`) |
| `admin.guests.list` | `guests.manage` | none | `GuestSessionInfo[]` |
| `admin.guests.end` | `guests.manage`, sensitive | `{ id }` | `{ ended }` (audit `guest.session.ended-by-owner`) |
| `admin.guests.peek` | `guests.manage`, sensitive | `{ id }` | `GuestPeek`: the live transcript (last 100 messages, text and tool names), audit `guest.peek` `{ guestId, messages }` (never text); `NOT_FOUND` when the session is gone |

`guests.manage` is in `OWNER_ONLY_CAPABILITIES`. `set` validates the merged settings (idle at most absolute, `public` needs `https:`), refuses
`enabled: true` when the model is missing or unpriced, and **disabling ends every live session**. `enabled: true` through `set` or the CLI also
lifts the kill switch; `killswitch({ on: true })` ends every session and refuses entry until then.

CLI: `keith-core guests status|enable|disable|kill|list|peek <id>|end <id>` (`core-cli.md`).

## Guest HTTP (step 5)

The second listener, its routes, the entry order, the bearer rules and the scrub of the stream are in `thalamus.md` ("The guest listener"). What a client needs:

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /guest/status` | none | `GuestPublicStatus` `{ enabled, available, banner, limits }` |
| `POST /guest/session` | none (zone, per-IP window) | `201 GuestStartResponse` `{ sessionId: 'guest:<id>', token: 'keith_g_...', expiresAt, limits, notice }` |
| `POST /guest/sessions/:id/chat` | `Authorization: Bearer <token>`, same address | UI message stream (SSE), `409` while a turn runs, `410` when ended |
| `GET /guest/sessions/:id/chat/stream` | same | resume of the active turn, `204` when none |
| `POST /guest/sessions/:id/interrupt` | same | `{ target }` |
| `DELETE /guest/sessions/:id` | same | `{ ended: true }` |

Errors are `{ error: { code, message, details? } }` with `GUEST_HTTP_ERROR_CODES`: `401 GUEST_UNAUTHORIZED`, `403 GUEST_DISABLED | GUEST_ZONE`, `429 GUEST_RATE_LIMITED | GUEST_BUSY | GUEST_CAP`
(`Retry-After`), `503 GUEST_UNAVAILABLE`, `410 GUEST_SESSION_ENDED` (`details.reason` is a `GuestEndReason`), `404 GUEST_NOT_FOUND`, `400 | 413 GUEST_BAD_REQUEST`. The banner (`GUEST_BANNER`)
says: anonymous, read-only, not stored by Keith, the owner can watch a live session, the model provider receives your messages.

**The failed-turn text (P33.3.4).** An `error` chunk of a visitor's stream carries the persona's `guestUnavailable` line (`prefrontal/lines.ts`,
`guestUnavailableLine`), read when the error is scrubbed, so a template switch applies at once. A missing, empty, blank or over-long stored line
falls back to the `professional` template's line (`The assistant is unavailable. Please try again.`). The provider's own error text never reaches a visitor.
Wiring: `compose-regions.ts` passes the line to `createGuestFetch` (`compose-guests.ts`) and `createGuestApp` (`guest-app.ts`), which hands it to `scrubResponse`.

## Peek and banner (step 8)

- **Peek.** `registry.peek(id)` reads the session's memory messages at the moment of the call (`GuestPeek`: the newest 100, text parts and tool names, oldest first, `truncated`; a visitor's text and tool names are stripped of control and escape sequences, newlines kept, and `keith-core guests peek` indents each continuation line so a visitor line cannot pose as `keith:`; the stored message is not changed, FD10-02),
  marks the session **watched** and does not count as traffic (the idle clock is untouched). `admin.guests.peek` is owner only and sensitive (a step-up over TCP; the socket is always stepped up),
  and records `guest.peek` with the random id and a message count only. Nothing is stored: the transcript lives in the agent's memory and the owner reads it live.
- **Banner.** `GUEST_BANNER` says: anonymous, read-only, not stored by Keith, the owner can watch a live session, the model provider receives your messages. It is in `GET /guest/status`,
  in the `notice` of the start answer and, short, in the `x-keith-guest-notice` header of every guest response; a client shows it first (`keith --guest`: `tui.md`, "Guest mode").
  Once a peek has happened every chat response also carries `x-keith-guest-watched: 1`.
- **Ending.** A chat response carries `x-keith-guest-turns-left` (0 on the last allowed message; the session closes after `guestGraceMs`, 3 s, so that answer is delivered). A request for a session that
  ended is `410 GUEST_SESSION_ENDED` with `details.reason` (`closed`, `idle`, `absolute`, `turn-cap`, `cost-cap`, `killed`, `restart`) for the right bearer from its address, `401` otherwise (`thalamus.md`).
- Tests: `guests-peek.e2e.test.ts`.

## Recording and audit (step 7)

Allowed in the audit log, and nothing else of guests:

- the owner's changes: `guest.settings`, `guest.killswitch`, `guest.session.ended-by-owner`;
- **`guest.session.end`**, one row per ended session, whatever the reason (actor `guest:<random id>`, via `tcp`): the detail is `GuestSessionAuditSchema` (strict): random id, zone, ip hash (12 hex characters of an HMAC whose key is random per process and **rotates every UTC day**, never stored, so hashes cannot be linked across days or restarts), client kind, start and end, end reason, turns, input and output tokens, cost, calls per tool name, refusals per kind. A record that does not parse is not written (a warning without data instead);
- **`guest.session.denied`**, one row per address hash per minute (actor `guest`): `GuestDeniedAuditSchema` (strict) `{ ipHash, windowStart, count, reasons }` where `reasons` counts `disabled`, `zone`, `rate` and each `GuestBlock`. Windows are written when their minute is over (every 15 s) and on close;
- never text, a raw IP, a user agent, a title, a tool input or an answer. Budget ledger rows are the only other record.

**Owner notification.** When a spending cap is hit (a start refused for `daily-cap` or `monthly-cap`, or a session that ended `cost-cap`) the owner's feed gets one activity event `guest-cap` (`GUEST_CAP_EVENT`, no session, so only the owner receives it) with `{ cap, count, at }`: at most one per hour, `count` is how many caps were hit since the previous notice. No text.

**Redaction.** The guest agent logs through `createGuestLogger` (`{ code, guestSession, ipHash }` only: `logging.md`, "The guest path"). Code: `modules/guests/guest-audit.ts`, `guest-logger.ts`; wiring `compose-guests.ts` (`onEnd` and the HTTP layer's `onDenied`); `core.close()` ends sessions (`restart`, one row each) and then writes the pending refusal windows. Tests: `guest-audit.test.ts`, `guests-audit.e2e.test.ts` (every way a session ends writes its row; refusals aggregate; the cap notice is once; the sentinel, address and user agent are in no table).

## Limits

Every limit of the guest listener, in one place (doc gap 2b). Keyed address hashes are daily-salted (`ipHash`).

| Limit | Where | Value | Answer when hit |
| --- | --- | --- | --- |
| Start per address | `POST /guest/session`, `guest-limiter.ts` (start bucket) | `sessionsPerIpPerWindow` per 10 minutes (`GUEST_LIMITS.ipWindowMs`); every attempt past the zone check counts | `429 GUEST_RATE_LIMITED`, `Retry-After` |
| Status per address | `GET /guest/status`, `guest-limiter.ts` (status bucket) | 30 a minute (`GUEST_LIMITS.statusPerIpPerWindow`, `statusWindowMs`) | `429 GUEST_RATE_LIMITED`, `Retry-After` |
| Concurrency | the entry gate | `maxConcurrent` sessions | `429 GUEST_BUSY` |
| Chat turns | the session | `maxTurns` per session; the last answer carries 0 turns left and the session ends `turn-cap` | `410 GUEST_SESSION_ENDED` |
| Message size | the chat route and the guest agent | 2048 characters (`maxInputChars`), text only, one part; body at most 16 KiB | `413 GUEST_BAD_REQUEST` |
| Start body | `POST /guest/session` | at most 1024 characters | `400 GUEST_BAD_REQUEST` |
| Spend | the ledger scopes | `dailyUsd`, `monthlyUsd`, `sessionUsd`, per turn 0.05 USD, owner floor 25 percent | `429 GUEST_CAP` or `503 GUEST_UNAVAILABLE` |
| Session end | the registry | idle `idleMs`, absolute `absoluteMs`; a tombstone answers `410` for 10 minutes (at most 1000), then `401` | `410` or `401` |
| `GET /health` | the guest listener | unlimited and data-free (`{ status: 'ok' }`) | none |

## Invariants

- A guest never touches a durable store: no SQLite table, file or log line holds what a guest said.
- Guest spending is on `owner`, `guests` and `guests:day:*` only; never on a person scope.
- No guest id resolves to a person (`personOfSession`, `AclActors.of`).
- Disabled and killed both end entry at once, and a start that was still reading the model price when the kill or disable landed is refused (`killed` or `disabled`, the entry gate's `recheck()` after its awaits; ADR-0027 §22); a restart ends all sessions.
- The guest agent shares nothing with the front agent: not its memory, plugins, storage or lock.

## Tests

`packages/contracts/src/guests.test.ts`; `modules/guests/settings.test.ts`, `guest-budget.test.ts` (scopes, seeding, floor, caps, the entry gate order, a real
turn billed to guest scopes only), `registry.test.ts` (answers, tool allow-list, 50 parallel starts, input and turn caps, cost cap, idle, absolute, kill
switch, restart, sentinel in no table, memory freed, no durable import); `guests-admin.e2e.test.ts` (admin procedures, step-up, audit, refusals);
`guests-session.e2e.test.ts` (a guest and the front agent in one core, billing, owner list and end, sentinel in no table or file);
`cli/guests-command.test.ts`; `guests-leak.e2e.test.ts` (the leak gate: a runtime-built sentinel typed by the visitor and echoed by the model, then after each way a session ends (visitor DELETE, idle, absolute, turn cap, kill switch, abrupt disconnect in a live core; cost cap and a graceful stop with a turn in flight, each in a core of its own) every table of the database (47 or more), the WAL and every file of the data folder hold nothing, one `guest.session.end` row exists with exactly the fields of `GuestSessionAuditSchema`, a control proves the scan finds a durable owner setting, the owner floor over HTTP, the per-address window and the concurrency cap on a fake clock). The core takes a test-only `guestClock` (`createCore` option, `bootCore`) for the session clock and the start window.
