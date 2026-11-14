# P17 — Guest mode (anonymous, incognito)

Nov 8, 2026 · status: **done, all 11 steps (Nov 9, 2026)** · ADR-0017 · specs touched: new `guests.md`; `auth.md`, `permissions.md`, `budget.md`, `thalamus.md`, `client.md`, `tui.md`, `tui-login.md`, `core-cli.md`, `plugins.md`
Order: P14 -> P15 -> P16 -> **P17** -> P18. Needs: zone function and `Actor` (P14), guest ceiling and leak kit (P15), `audience: 'public'` and Notes (P16).
P18 does not offer plugin views to guests.

## Goal

An owner who enables it lets anonymous visitors on the local network chat with a tiny read-only Keith about the owner's public things. Nothing a guest says is stored, the owner
pays within hard caps, the owner can watch a live session (and guests are told), and a test proves nothing leaks.

## Verified starting point (the guest report's citations were re-read; Nov 8, 2026)

- Durable stores of the front agent are built at `apps/core/src/compose.ts` (lock, `messages`, `state`, `inbox`, `streams` around lines 162-170; the activity store at `watchPending(...)`).
- `apps/core/src/modules/thalamus/app.ts`: `OPEN_PATHS` is a `Set` at line 64; the `chat.validate` hook emits `brain.thalamus.routed` with `preview: previewOf(body.messages)` (~line 149-155). A guest must never use that route.
- Host allowlist: `thalamus/guard.ts` answers 421 for any Host that is not loopback with the listen port, the public URL host or `KEITH_ALLOWED_HOSTS` (the report cited lines 62-69; the response is at lines 75-76). A LAN IP in the Host header is refused today.
- Bind: `admin/network.ts` `DEFAULT_HOST = '127.0.0.1'`. A LAN guest needs a non-loopback listener.
- `platform/net.ts` `SERVER_LIMITS.idleTimeout = 30`; `keepAlive` (app.ts line 60/177, defined in compose.ts) lifts it after auth, so a guest stream needs the same call.
- `ModelRoleSchema = z.enum(['front', 'cortex'])` (`packages/contracts/src/models.ts:4`).
- eharness: `storageFor` gives each agent default memory adapters (`.ref/eharness/src/agent/sessions.ts:64`); there is no `deleteSession` or `ephemeral` anywhere in specs or src (searched). With a budget ledger an unpriced model raises `W_MODEL_UNPRICED` and its cost does not count (spec 12).
- `modules/audit` has no pruning. P15 step 4 adds one; guest rows are aggregate, so volume is one per session plus one per minute per IP hash of denials.
- Pinned eharness is 0.12.0 (the guest report said so; the ACL and plugin reports said 0.11).

## Decisions taken (ADR-0017)

| Question | Decision |
| --- | --- |
| Reach | Off by default; zones default `lan`; separate listener `guests.port`, serving `/guest/*` and `/health` only; `public` only with an `https:` public URL |
| Agent | One tiny agent per session, default memory storage, no inbox, streams, activity, memory, lock, compaction; registry and sweeper in `modules/guests` |
| Tools | Only `audience: 'public'` operations (P16) on `@public`-readable resources (P15); everything else absent; `tool.approve` denies anything outside a static allow-list; approvals auto-denied |
| Data | Public Notes through the ACL. The research report preferred a separate disjoint store for structural safety; the owner asked for "public read incl. guests" on the ACL, so the ACL is used and the leak kit runs with a guest actor as the safety net |
| Model | New role `guest`; disabled until chosen; unpriced refused |
| Caps | 0.50 USD/day, 5 USD/month, 3 concurrent, 20 turns/session, 5 starts per IP per 10 min, 2 KiB input, `maxSteps 3`, 800 output tokens, 0.10 USD/session; entry blocked under 25% of the owner's monthly budget |
| Recording | Ledger rows plus one aggregate audit row per session (fields in ADR-0017); no text, raw IP or user agent |
| Peek | `admin.guests.peek`, step-up, audited, banner tells guests |
| Bearer | `keith_g_<32 random bytes>`; `parseCredential` does not accept it, so it cannot touch `/rpc` or any owner route; bound to session id and peer IP |
| Guests in the DB | Never: no `credentials` row, no `people` row (P14's guest variant is the `Actor` type and the bearer prefix) |

## Non-goals

Any guest write path (the quarantined drop box is a later plan), transcripts, named invited guests, channels (chat apps), public Funnel exposure beyond the https precondition, plugin TUI
views for guests, per-guest accounts, eharness changes.

## Design in brief

**Settings** (existing `settings` repo, next to `access.*`): `guests.enabled` (false), `guests.zones` (`['lan']`), `guests.port`, `guests.hosts`, `guests.maxConcurrent`, `guests.sessionsPerIpPerWindow`,
`guests.maxTurns`, `guests.idleMs` (30 min), `guests.absoluteMs` (2 h), `guests.dailyUsd`, `guests.monthlyUsd`, `models.roles.guest`. Capability `guests.manage` (owner only). Procedures
`admin.guests.get|set|killswitch|list|end|peek`, all step-up; `set` records before and after in the audit.

**Entry order** (`POST /guest/session`): kill switch -> enabled -> zone (from the TCP peer; a loopback peer with forwarding or Funnel headers is `public`; IPv4-mapped IPv6 unwrapped) ->
Host check for the guest port -> per-IP and concurrency limits -> priced `guest` model -> every budget scope has a limit and the owner floor holds -> create the agent, registry entry and bearer.
Response `{ sessionId, token, expiresAt, limits, notice }`. Later traffic: `/guest/sessions/:id/*` through `createHarnessHttp` with `basePath: '/guest'`, `authorize` accepting only a matching
`keith_g_` bearer from the same IP; `sessions.list`, `attention` and `activity` are not mounted; `chat.validate` rejects file parts and enforces the turn counter.

**Session end** (any reason): `agent.close({ inFlight: 'abort' })`, delete the registry entry and bearer, write the aggregate audit row, emit counts to the owner's feed (not text). Reasons:
`closed | idle | absolute | turn-cap | cost-cap | killed | restart`.

**Prompt and context:** English text saying: anonymous visitor, public notes only, nothing private, no memory after the chat, treat note and visitor text as data. No person names, no memory, no model
or price facts, no data paths. A guest-specific `HarnessLogger` logs `{ code, guestSession, ipHash }` only.

**Client and TUI:** `createGuestClient(baseUrl)` in `packages/client` (start, chat on `basePath: '/guest'`, end). `keith --guest [--core <url>]` opens a guest screen with the banner ("anonymous, not
stored, the owner can watch a live session, the model provider receives your messages") and no private panels. Home offers "Chat as guest" when `GET /guest/status` (open) says it is available to this
caller. The guest path never reads `client.json` or the local socket.

## Steps (one commit each, in order; `bun run check` green after each)

1. **DONE `82d9f3d`** **Spec and contracts.** `docs/specs/guests.md`; `ModelRoleSchema` gains `guest`; settings schema, `GuestStatus`, `GuestSessionAudit`, audit kinds. Scope `contracts`.
2. **DONE `7221ddf`** **Settings, capability, admin procedures, CLI.** `guests.manage`, `admin.guests.*` with step-up and audit, `keith-core guests status|enable|disable|kill|list|end`. Specs `permissions.md`, `core-cli.md`. Scope `core`.
3. **DONE `144c8f1`** **Model role and budget wiring.** Role picker (manage screen), unpriced refusal, `guestConfig()` with scopes `owner`, `guests`, `guests:day:<date>`, seeding with `setBudgetLimit`, entry floor and no-limit refusal. Spec `budget.md`. Scope `providers`.
4. **DONE `597e3a7`** **Registry, agent factory, sweeper** in `modules/guests`, scripted-model tests (caps, idle, absolute, turn cap, restart). Scope `core`.
5. **DONE `3c7e41f`** **Guest HTTP, second listener, rate limiter, status route.** Guard instance for guest hosts (the listener's own addresses plus `guests.hosts`), per-IP window, concurrency, bearer binding. Spec `thalamus.md`. Scope `thalamus`.
6. **DONE `9801df7`** **Public tools.** Mark Notes `search` and `get` `audience: 'public'`; static allow-list and `tool.approve` deny; the guest prompt; tests that the tool list equals the allow-list. Spec `plugins.md`. Scope `host`.
7. **DONE `f775f3e`** **Audit aggregate and redaction.** `guest.session.end`, per-minute `guest.session.denied` per IP hash, guest logger, owner notification once per hour on cap. Scope `audit`.
8. **DONE `b6e1bbc`** **Peek and banner.** `admin.guests.peek` (live transcript, audited), banner text, "session ended" handling. Scope `core`.
9. **DONE `5829be7`** **Client and TUI.** `createGuestClient`, `keith --guest`, Home entry, guest screen. Specs `client.md`, `tui.md`, `tui-login.md`. Scope `tui`.
10. **DONE `9bf8510`** **Leak and isolation tests.** The sentinel test over every way a session ends; guest bearer on `/rpc`, `/sessions/front:*`, `/activity`, `/attention`, `/nodes/*` is 401; owner bearer on `/guest/*` is 401; zone matrix. Scope `core`.
11. **DONE (the commit that moves this plan)** **Smoke, manual docs, proof.** Smoke: enable with step-up, guest on loopback zone, denied from public, cap hit, kill switch, aggregate row has only allowed fields. Plan to `done/`. Scope `repo`.

## Progress and deviations (Nov 9, 2026)

Steps 1-4 are committed (`82d9f3d`, `7221ddf`, `144c8f1`, `597e3a7`). Each commit ran only targeted checks (the owner's rule); the full `bun run check` and `bun run smoke`
ran once after the last commit (see the evidence note when recorded). Deviations from the text above:

- **Order inside steps 2-3.** `ProviderService.rolePricing(role)` (priced or not) and `keith-core model set guest` landed in step 2, because `guests enable` must refuse an
  unpriced model and its message names that command. Step 3 added the role's owner-only rule (`models.roles.set` needs `guests.manage`; `models.roles.get` hides `guest`
  from others).
- **`ModelRolesSchema.guest` is optional** (older cores); setup keeps asking for `PRIMARY_MODEL_ROLES` (`front`, `cortex`) only, so the setup wizard and `Record<...>` types did not change meaning.
- **Kill switch is a setting** (`guests.killed`), lifted by `enable`; `disable` also ends every session.
- **`no-limit` looks at the two guest scopes** (seeded just before the check), not at the owner's global scope: an owner with no global limit is never floored and guests stay capped by their own scopes.
- **Graceful close writes `restart`** (the `onEnd` record), a crash drops sessions silently; turn-cap and cost-cap close the session after a short grace (`graceMs`, 3 s) so the last answer is delivered.
- **Settings added beyond the plan list:** `sessionUsd` (0.10) is owner-settable; input size, steps, output tokens, the IP window and the 25 percent floor are constants (`GUEST_LIMITS`).
- The default guest port is 7421 (`DEFAULT_GUEST_PORT`); step 5 may change it.
- `compose-guests.ts` holds the guest wiring so `compose.ts` grows by a few lines only; `Core.guests` exposes the registry for the HTTP layer of step 5.

### Steps 5-8 (Nov 9, 2026): deviations and what the code settled

Each commit ran only targeted checks (the owner's rule); the full `bun run check` and `bun run smoke` ran once after step 8 (Nov 9, 2026, after step 8): `bun run check` exit 0 (2170 tests pass), `bun run smoke` PASS (39 steps, 32 s). The smoke has no guest step yet (step 11).

- **Step 5 is bigger than the text.** Beyond the listener, status and bearer: the stream of a guest chat is **scrubbed by an allow-list** (`guest-scrub.ts`), because eharness streams the model id (`pricey/cheap`), token counts, cost and the context
  window next to the answer; and the stored-session routes (`GET /sessions/:id`, messages) are **not offered** to guests for the same reason. Also: chat is `send` only, one text part, 2048 characters (`413`/`400` before a turn exists); `410` carries the end reason (a tombstone of the bearer hash, 10 minutes, at most 1000).
- **The listener exists only while guests are on.** `createGuestListener` opens `guests.port` when `enabled` and not killed, closes it on disable or the kill switch, moves it when the port changes (poll 2 s). Bind `127.0.0.1` when `zones` is only `loopback`, else `0.0.0.0`.
- **Concurrency is the registry's global cap** (`maxConcurrent`, default 3); there is no separate per-IP concurrency cap. The per-IP window counts every attempt past the zone check (allowed or not).
- **Spec location.** The routes are specified in `thalamus.md` ("The guest listener") and summarised in `guests.md`; `GuestPublicStatus`, `GuestStartResponse`, `GUEST_BANNER`, the error codes and the headers are in `packages/contracts/src/guests.ts`.
- **Step 6 uses the existing `public_get` and `public_list`, not `search`/`get`.** P16 built them as separate public operations; marking `search`/`get` public would have shown the guest an author name and widened the surface. The host gained `expose.guest` (default false, needs `audience: 'public'`): the AI surface is offered to a guest only for `expose.guest` operations and to a person only for `expose.ai` ones. The guest agent receives only the compiled plugins that own an allow-listed tool. `by` reads `the author` for a guest.
- **Guest actor**: `withGuests(directory, live)` (`modules/guests/actor.ts`); zone `public` in the actor (the real zone was checked at entry), never elevated (forced in `buildCtx`), `k.people` and `k.access` refuse, review rules refuse a guest. The guest agent's session is opened with `{ principal: { id: 'guest:<id>' } }` (`GuestSession.session()`).
- **Step 7**: the address hash key is random per process and rotates every UTC day (`createIpHasher`); the bearer binding uses a separate per-process key. The owner notification is an activity event `guest-cap` (`{ cap, count, at }`) at most once per hour. `Core.guestAudit` exposes `flush` for tests.
- **Step 8**: `registry.peek` marks the session watched, does not touch the idle clock; response headers `x-keith-guest-watched`, `x-keith-guest-turns-left`, `x-keith-guest-notice`. The banner is in status, in the start answer and in a header rather than injected as a first chat message (a client shows it first, step 9). `keith-core guests peek <id>` was added for manual testing. `CoreTiming.guestGraceMs` and `bootCore({ timing })` exist for tests.

Open verifications settled in steps 5-8: **2** true: `createHarnessHttp(undefined, { authorize, session, peek, basePath })` serves per-guest agents, one handler for all sessions (`guest-app.ts`); **3** true: `?ifBusy=reject` (the default) answers `409` for a lock-less session (`guests-http.e2e.test.ts`); **4** the Host values: a literal IP with the listening port is accepted (cannot be DNS-rebound), names only when they are the machine's (`os.hostname()`, short name, `<short>.local`), in `guests.hosts` or the public URL host; verified by dialling this machine's own `en0` address (Host `10.x.x.x:port`, peer in zone `lan`). **Still unverified:** a phone or another computer on the LAN, what Host header a given OS or mDNS resolver sends, and Tailscale-peer behaviour.

### Steps 9-11 (Nov 9, 2026): deviations and what the code settled

Steps 9 and 10 ran only targeted checks (the owner's rule); the full `bun run check` and `bun run smoke` ran once at the end (see "Gate evidence"). Deviations from the text above:

- **`keith --guest` is a flag of the default `home` command** (`keith --guest [--core <guest url>]`; a `guest` subcommand was not added). `--core` is the **guest listener** (an `http:` address with no port means 7421; `unix:` and non-http are usage errors); without it the address is `http://127.0.0.1:7421`.
  The plan said "default: the guest port of the found/entered core address", but a visitor has no stored address and the guest path never reads `client.json` or the socket, so there is nothing to find.
- **The guest app is its own Ink render** (`guest-main.tsx`, loaded by `keithCommands` only for `--guest`; `deps.startGuest` is the test seam), because `cli.tsx` held the owner's uncommitted work and was not touched. It does not enable mouse reporting or the Kitty keyboard
  protocol, so in the guest screen the wheel does not scroll (`alt+↑↓` does) and `shift+enter` may not insert a newline; the signed-out Home path (`AppRoot`) uses whatever `cli.tsx` enabled.
- **The Home entry is a row under the sign-in panel, not a menu row** (`or continue as an anonymous guest  ·  [ctrl+g]`), shown only when `GET <same host>:7421/guest/status` says `enabled` and `available`; a core with another guest port shows nothing (a signed-out client cannot ask which port). `AppRoot` swaps the app for the guest screen (`enterGuest`).
- **The screen does not reuse `ChatView`** (it is bound to eharness' `ChatSession` and the owner's feed); it reuses `MessageList`, `InputBand` (new optional `placeholder`), `ScrollView`, `Notice`, `ScreenFrame` and the chat's item types. `MessageList` gained an optional `empty` node. `esc` and `ctrl+c` end the chat (a running turn too); there is no separate "stop turn" key (`interrupt()` is in the client).
- **The last allowed message ends the chat in the UI at once** (it calls `DELETE` itself) instead of waiting for the core's grace close and the next `410`.
- **Test-only `guestClock`** on `createCore` / `bootCore` (the session clock and the per-address window), so idle, absolute and the window are tested on a fake clock; `compose.ts` grew by four lines.
- **A finding in step 10:** a visitor's cut request does **not** stop the turn: it runs to the end and is billed (bounded by the caps), and the idle limit starts counting after it. Left as is (no durable store is involved); the test waits for the turn to settle.
- **Smoke:** the fake provider answers a guest's "public notes" question by calling `notes_public_list` and repeating the tool result and the visitor's words; the guest role uses the catalog id `deepseek:deepseek-chat` (priced) on the same fake connection while front and cortex stay on the unpriced `smoke` (`deepseek:smoke` is shown refused first).
  The first full smoke failed at the step-up because the P14 steps had changed the owner's PIN; the step uses `FRESH_PIN`. The pty step also found that the empty-conversation text of the chat showed while the guest chat was opening (`MessageList` got `empty={null}`; the fix is in the step 11 commit).

## Risks

- **Durable side stores missed:** the leak test is the guard; sentinel in text, a tool argument, the assistant reply and a provider error.
- **Cost drain:** caps at five levels (turn, session, IP, day, month), concurrency, kill switch, owner floor. NAT households may be throttled.
- **ACL bug exposes a private note:** guest ceiling, allow-listed tools, leak kit with a guest actor, public-only mode check.
- **Owner API widened by a LAN listener:** a separate port with its own `fetch`; a test asserts `/rpc` returns 404 there.
- **Prompt injection** from public content: tool results are labelled data, no tool can do harm; a future drop box is quarantined.
- **Process memory and provider retention** cannot be erased: stated in the banner and docs.
- **Bearer theft on shared Wi-Fi:** IP binding, short TTL, plain HTTP warning for LAN.

## Open verifications

Settled in steps 1-4 (Nov 9, 2026): **1** true: after `end` a `WeakRef` to the agent and to the session is cleared by a GC while an open session's is not (`registry.test.ts`); the registry deletes
the entry before closing and nothing else holds it. **Two agents in one core** (part of 2's risk): a guest agent and the front agent answer concurrently, the guest on default memory storage with
no lock, the front on SQLite (`guests-session.e2e.test.ts`). **`createAgent` requirements**: `defineHarnessAgent({ id, model: unconfiguredModel, models, instructions, plugins, budget, settings, loop,
compaction: false, recovery: false })` with no `storage`, `inbox`, `streams` or `lock` needs nothing else; `turn.prepare` may return `activeTools: []` (the model is offered no tool); a blocked input
(`persist: false`) is neither stored nor a turn; `input.submit`, `turn.end`, `tool.after` and `approval.decided` are enough for the counters. **5**: the owner's remaining monthly budget is read from the
`owner` scope (`Budget.status()`: limit and remaining); the guest scopes also charge `owner`, verified by the reservation rows of a real turn. Still open: 2 (`createHarnessHttp` with a custom
`session`), 3 (`ifBusy` for a lock-less session) and 4 (Host values), all in step 5.

Original list:

1. A guest agent with default memory storage releases messages after `close()` and removal from the registry (check with a `WeakRef` test and by inspecting that no map retains the session).
2. `createHarnessHttp(undefined, { session(id, ctx) })` can return another agent's session, with `authorize` and `chat.validate` as listed (spec 26 section 1); the first step is a spike test.
3. `ifBusy: 'reject'` (or the equivalent) exists for a lock-less session in 0.12.
4. Which Host values the guest listener must accept (literal LAN IP, `hostname.local`) without weakening DNS-rebinding protection; literal IPs cannot be rebound, names need the allowlist.
5. How the owner's remaining monthly budget is read for the 25 percent floor (`budget.status()` vs the global scope) and that guest scopes also charge `owner` (true total).

## eharness impact

None required. Optional generic follow-ups, only after the design is proven: `agent.deleteSession(id)` and a `drop(sessionId)` on the memory adapters (also useful for erase on durable adapters), or a
`SessionOptions.ephemeral`. Neither is needed; the registry-and-sweeper design works with the current API.

## Verification items for the gate

Evidence after step 10 (Nov 9, 2026), by file in `apps/core/src`:

- The leak test passes after close, idle, absolute, turn-cap, cost-cap, kill switch, abrupt disconnect and `core.close()` (sentinel built at runtime so gitleaks stays quiet): `guests-leak.e2e.test.ts` (14 tests; 9 scans on the live core, each over 47+ tables, the WAL and every file of the data folder, plus the scans of the cost-cap and graceful-stop cores). A control shows the scan finds a durable owner setting in a table and in a file.
- The aggregate audit row has exactly the allowed fields (schema `strict`; the test compares the key list with the schema's): `guests-leak.e2e.test.ts` for every end path, `guests-audit.e2e.test.ts` for the content.
- Unpriced model refuses enable (`guests-admin.e2e.test.ts`); a scope without a limit refuses entry (`modules/guests/guest-budget.test.ts`); 50 parallel starts yield at most `maxConcurrent` (`modules/guests/registry.test.ts`), and 30 parallel HTTP starts yield exactly 3 with `maxConcurrent` 3 (`guests-leak.e2e.test.ts`).
- Zone tests: loopback plus `X-Forwarded-For` is public; Funnel header is public; IP change mid-session is 401 (`guests-http.e2e.test.ts`).
- The guest tool list equals the allow-list; scripted attempts to call `shell_exec`, `agent`, `memory_*` fail (`guests-tools.e2e.test.ts`).
- Isolation matrix: a guest bearer is 401 on `/rpc`, `/sessions/front:*`, `/activity`, `/attention`, `/nodes/ws`, the plugin routes and step-up; the owner bearer on `/guest/*` is 401; the main port has no `/guest` route; the guest port has no owner route; another guest's token or another address is 401 (`guests-http.e2e.test.ts`). Guest spend lands only on `owner`, `guests` and `guests:day:*` (`guests-session.e2e.test.ts`); the daily cap answers 429 and notifies once (`guests-audit.e2e.test.ts`); the owner floor blocks entry over HTTP with no owner detail (`guests-leak.e2e.test.ts`); settings changes need step-up and are audited (`guests-admin.e2e.test.ts`); the kill switch ends all and refuses new (`guests-http.e2e.test.ts`, `guests-leak.e2e.test.ts`); the per-address window opens again after ten minutes on a fake clock (`guests-leak.e2e.test.ts`).
- `bun run check` and `bun run smoke` pass (step 11).

## Gate

`bun run check` exit 0 on a clean copy, smoke with the guest steps, the leak test named in the report with counts of tables and files scanned.

## Gate evidence

Nov 9, 2026, on the working tree of the commit that closes this plan (not a clean-copy run: the tree also held the owner's uncommitted `apps/tui/src/cli.tsx` and `scripts/manual.ts`, neither touched nor staged).

- `bun run check` ran once at the end: Biome, tsc on every package and the scripts, `bun test` **2231 pass, 13 skip, 0 fail** of 2244 tests in 272 files, check-imports (854 files, 14 packages), check-size (855 files, warnings only, none above 800), check-exports (16 entries). Commits 1 to 10 were verified only with targeted checks (tsc of the touched projects, Biome on the changed files, the tests of the touched modules and their dependents); the full suite ran once, after step 11's files were in the tree.
- New tests of steps 9 and 10: `packages/client/src/guest.test.ts` (20: every error code and every end reason), `features/guest/guest-screen.test.tsx` (13), `guest-text.test.ts` (3), `home-guest.test.tsx` (3), `guest-command.test.ts` (7), the real-pty `cli.guest.pty.test.ts` (1), and `apps/core/src/guests-leak.e2e.test.ts` (14).
- **The leak test**, per way a session ends (`guests-leak.e2e.test.ts`): a runtime-built sentinel typed by the visitor and echoed by the model; after each end, every table of the database (47 or more), the WAL and every file of the data folder (5 or more files) hold nothing, and exactly one `guest.session.end` row exists whose key list equals `GuestSessionAuditSchema` (strict). Visitor `DELETE` (closed): clean. Idle expiry: clean. Absolute expiry (a chat that keeps talking): clean. Turn cap: clean. Kill switch (two sessions): clean. Abrupt disconnect (request cut mid-answer, ended by the idle sweep): clean. Cost cap (a core of its own): clean. Graceful stop with a turn in flight (`core.close()`, two rows `restart`, the closed data folder scanned): clean. While live (and after a peek) nothing durable holds it either. A control proves the scan finds a durable owner setting in a table and in a file, and that the database is in WAL mode with the WAL among the files scanned.
- Also in the same file: the owner floor over HTTP (guest spend counts on the owner budget; under 25 percent left entry is `503 GUEST_UNAVAILABLE` with no owner detail), the per-address window opening again after ten minutes and 30 parallel starts yielding exactly `maxConcurrent` (3), all on a fake clock where time matters. The rest of the isolation matrix was already in `guests-http.e2e.test.ts` (steps 5-8) and is listed under "Verification items for the gate".
- `bun run smoke`: `SMOKE PASS (46 steps ok, 37 s)`, 39 before, seven new steps (`scripts/smoke/guests.ts`): (1) `guests enable` refused with no model and with the unpriced `deepseek:smoke`, a cold owner credential refused `KEITH_STEP_UP_REQUIRED` on `admin.guests.set`, then stepped up, the port chosen, `guests enable`, the guest listener up, `/rpc` 404 on the guest port and `/guest` 404 on the owner's; (2) the default zone `lan` refuses a loopback visitor (`GUEST_ZONE`, status says not available), allowed after `guests.zones` includes `loopback`, and a proxied loopback request (`x-forwarded-for`) is refused; (3) a visitor asking about "public notes" gets the public note and neither the private title nor body, the stream names no model, the bearer is `keith_g_`, turns left 19; (4) `keith-core guests list` and `guests peek` while live, and the next answer carries `x-keith-guest-watched: 1`; (5) the real TUI `keith --guest` in a pseudo-terminal against the guest port (no login file): banner, a message, the public note on screen, no private text, the session leaves `guests list` on `ctrl+c`; (6) a daily cap hit is `429 GUEST_CAP` with `Retry-After`, the kill switch answers the open chat `410` reason `killed`, a new start is `403`, `enable` lifts it; (7) the audit has one `guest.session.end` row per session with exactly the 13 allowed fields (reasons `killed` and `closed`), the `guest.settings`, `guest.killswitch` and `guest.peek` rows, no text, address or sentinel in any guest row or in `keith-core audit`, and the sentinel in no file of the data folder and not in the core's output. No keith, node or smoke process was left.

**Unverified.** (1) A **real LAN client**: a phone or another computer, what Host header its OS or mDNS resolver sends, and the `lan` zone from a real second address (the smoke and tests dial loopback and this machine's own `en0` address). (2) **Tailscale peers** and a public (`https:`) route. (3) **Real model compliance**: that a real guest model keeps to the read-only prompt, treats public note text as data and does not leak, and its tool-use and cost behaviour; the tests use scripted models and a fake provider, and there is no sentinel check on a real model's output. (4) The **model provider's retention** and process memory, which the banner states and no test can erase. (5) A terminal without Kitty keyboard or mouse in the guest screen (the standalone `keith --guest` render turns neither on). (6) The **manual scenario** (`docs/manual-testing.md` scenario 15) is owner to run.

**For P18 (plugin TUI views).** Guests never see a plugin view: the guest listener serves only `/health` and `/guest/*` (no `/plugins` route, no `/rpc`), `expose.guest` is the only way an operation reaches a guest and it carries tools, not views, and the guest screen (`features/guest`) draws no sidebar, no menu section and no panel of an account.
A plugin view slot must therefore never be added to `GuestScreen` or to `keith --guest`. The guest path builds no `KeithClient` (only `createGuestClient`), so a view renderer that needs `KeithClient` or `useKeith` cannot be mounted there by accident. `AppRoot` can now swap the whole app for the guest page (`enterGuest`), so anything P18 mounts in `App`
is gone while a visitor chats and comes back fresh after `esc`. Reusable pieces: `MessageList` takes an optional `empty` node and `InputBand` an optional `placeholder`; `testing/fake-core.ts` serves `/guest/*` with the `guest` option (`testing/fake-guest.ts`), and `setup-app.tsx` has `guestVia`.
The core's test clock for guests is `bootCore({ guestClock })`.

## Owner to run

1. `keith-core guests enable` (step-up); it refuses until you pick the `guest` model; pick a cheap priced one.
2. From a phone on the Wi-Fi open the guest URL (or `keith --guest --core http://<lan-ip>:<guest-port>`); read the banner; ask about a public note, then about a private one (the answer says it cannot).
3. Watch the live session with `keith manage` peek; see the banner mention on the guest side and the `guest.peek` audit row.
4. Hit the daily cap with a low value: the guest gets 429, you get one notification.
5. Kill switch: the guest session ends at once.
6. Restart the core: the guest session is gone; search the data directory for a phrase the guest typed (the leak script in `docs/manual-testing.md`).
7. Try from Tailscale or the internet: refused while `zones` is `lan`.
