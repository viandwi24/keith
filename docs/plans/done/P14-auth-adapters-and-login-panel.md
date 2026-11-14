# P14 — Authentication adapters, sessions and the login panel

Nov 8, 2026 · status: **done Nov 9, 2026** · ADR-0014 · specs touched: auth, people, client, tui-login, tui-design, db, contracts
Order: **first** of P14 -> P15 -> P16 -> P17 -> P18. Needs nothing before it. P15 (ACL) needs the `Actor` this plan defines;
P17 (guests) needs the session variant and the zone function.

## Goal

Sign in by identity first: one box takes a user id, username, email or phone; the core says which methods this identity may use from
this client's zone; then the UI shows the method (PIN on the same network, otherwise username and password). Methods are adapters driven
by data, sessions expire and can be revoked, and the local socket stops being an implicit owner. Adding TOTP later must need no TUI code.

## Verified starting point (read before this plan, Nov 8, 2026)

- `createSignIn` (`packages/client/src/sign-in.ts`) is a fixed state machine: `address | socket | checking | method | password | token |
  working | device | done | error`, with `SignInMethod = 'device' | 'password' | 'token'`. The TUI has one step component per state
  (`apps/tui/src/features/login/login-steps.tsx`) inside `LoginScreen`.
- Home today shows a **caption**, not a form: `alertCaption` (`features/home/home-caption.ts`) and `onLogin` on `enter`
  (`home-screen.tsx`) opens the separate Sign in screen. The new panel is a real form on Home.
- `GET /auth/methods` is open (`OPEN_PATHS`, `modules/thalamus/app.ts`) and returns `{ methods: [{ id, available, reason? }] }`.
- `networkRule` has no LAN branch; it returns `network` for a LAN peer. `KEITH_INSECURE_LOGIN` lifts it.
- PIN is a `person_secrets` row (`kind: 'pin'`), used only by `POST /auth/step-up`. `credentials` has `elevated_until` and `last_ip`, no expiry.
- `people` has no email or phone column. `person_accounts(platform, native_id)` exists for channels (chat apps, voice) and stays as the contact directory.
- Migrations run only by `bun run db:migrate`; the core refuses an out-of-date database (`assertMigrated`). Plugins (P16) follow the same rule.

## Decisions taken (ADR-0014)

| Question | Decision | Why |
| --- | --- | --- |
| Identifier | user id, username, email, phone; never full name | Names are not unique and are guessable |
| Email and phone | Admin-set aliases in a new table `person_identifiers(person_id, kind, value_norm unique, created_by)` | No mail or SMS exists; a table avoids more nullable columns on `people` and allows several per person (differs from the research report, which suggested `people.email`) |
| Email+password | The same `password` adapter reached by typing an email; policy can restrict by identifier kind | One code path, one throttle subject (normalised to the person id) |
| Enumeration | Decoy flow for unknown identifiers; list depends on zone and global policy only | See ADR-0014 point 2 |
| Default method | PIN when the client is in `loopback`, `lan` or `tailscale` and PIN is allowed; else password | The owner's rule; core marks `default: true`, the TUI does not compute it |
| PIN session | `assurance 1`, cannot step up | A PIN that starts a session and confirms step-up would be one factor |
| Policy storage | One settings key `auth.policy` (JSON, zod in contracts), owner-only with step-up and audit | `settings` repo exists; a table is not needed for ~10 rules |
| Flows | In memory, 5 minutes, bound to method and peer IP | Short-lived, nothing to migrate |
| Sessions | New nullable columns on `credentials`; `kind` gains `session` | Additive; old rows read as `methods: ['legacy']` |
| Socket | Phase 1 idle-lock, phase 2 session plus `local trust` knob | Do not break scripts at once |

## Non-goals

TOTP, recovery codes and multi-step flows (the adapter shape allows them; a later plan adds them). Outbound mail or SMS, email verification
and self-registration. OAuth and SSO. A web UI login. Guest sessions themselves (P17 uses the variant). The ACL (P15). TLS termination
inside Keith (documented as a precondition for public exposure; Tailscale certificates or a reverse proxy do it).

## Design in brief

**Contracts** (`packages/contracts/src/auth-flow.ts`, additive; old schemas stay):
`Actor = { kind: 'user' | 'guest' | 'system', personId | null, principalId, role, sessionId, methods[], assurance 0|1|2, elevated, zone, via }`;
`MethodDescriptor { id, label, available, reason?, default?, assurance, firstStep, interaction: 'form' | 'poll' }`;
`Step { id, title?, help?, fields[{ name, label, kind: 'text' | 'secret' | 'digits' | 'code', mask?, length? }] }`;
`IdentifyResponse { flowId, context: 'loopback' | 'lan' | 'tailscale' | 'public', methods[] }`.

**Endpoints** (open, same limits): `POST /auth/identify { identifier }`; `POST /auth/flow/:id { method, answer }` returning a step, a session
or the uniform 401. `/auth/login`, `/auth/methods` and the device routes stay for scripts and older clients.

**Adapters** (`apps/core/src/modules/auth/methods/`, one file each, under the 400-line limit): `password`, `pin`, `device-code`, `token`.
Shared helpers own the dummy hash, the throttle, the audit and the hasher semaphore, so an adapter author cannot forget them.

**Zones** (`zone.ts`): `loopback`, `lan`, `tailscale`, `public`. `lan` = private address (RFC 1918, `fc00::/7`, `fe80::/10`) inside an on-link subnet of
`os.networkInterfaces()` (refreshed each minute), not Tailscale; the owner may add CIDRs. Doctor warns when the peer equals the default gateway
(a SNAT router makes every Internet peer look local).

**Policy rule shape** (data): `{ method, zones[], cidrs[], roles?, identifierKinds?, rateLimit, requireAssurance, idleMs, absoluteMs }`.

**Home panel**: a `FramePanel` labelled `Sign in`: identifier box, then the method the core marks default (PIN field, or password field) with
`tab` to switch among the others; legend `enter sign in · tab method · d device code · t token · c change core`. On plain HTTP in `lan`
the PIN panel shows a visible warning line. Secrets stay masked, cleared after every submit, never in a state or frame.

## Steps (one commit each, in order; `bun run check` green after each)

1. **Contracts and specs.** _Done, commit `84c34ff`._ `Actor`, `MethodDescriptor`, `Step`, `Identify*`, `AuthPolicy` schemas with tests; draft the spec text.
   Specs: `auth.md` (methods, flows, policy, zones), `client.md`, `people.md` (identifiers, `can_login`). Scope `contracts`.
2. **Zones and policy engine, no behaviour change.** _Done, commit `dc5dfb8`._ `zone.ts`, `policy.ts`, the default policy; `networkRule` becomes a call into the
   engine. A parity test runs the old rule's matrix (socket, loopback, forwarded, Funnel, Tailscale, proxy setting, insecure flag) against the new
   engine; only the new `lan` cases and PIN differ. Spec `auth.md`. Scope `auth`.
3. **Registry and adapters, no behaviour change.** _Done, commit `51abf0e`._ `AuthMethod`, `createAuthRegistry`, password, device-code and token moved into adapters;
   `/auth/methods` is served from the registry; `login.e2e.test.ts` and `bun run smoke` pass unchanged. Spec `auth.md`. Scope `auth`.
4. **Migration (additive).** _Done, commit `c23b345`._ Generated by drizzle-kit: `credentials` gains `methods`, `assurance`, `idle_expires_at`, `absolute_expires_at`,
   `user_agent`, `revoked_reason`; `people.can_login integer not null default 1`; table `person_identifiers`. Procedure: copy the real database,
   run the migration on the copy, run `bun test` against it, only then document `cp data/keith.db{,.bak}` before the owner migrates. Specs `db.md`, `auth.md`. Scope `db`.
5. **Identifier-first flow with decoy.** _Done, commit `f5374a0`._ `POST /auth/identify`, `/auth/flow/:id`, identifier lookup by kind, decoy with the same queries,
   HMAC-derived stable decoy, equal throttling per (identifier hash, ip) whether the person exists or not; owner commands
   `keith-core people alias add|remove`. Tests: response shape and status identical for known and unknown; a timing test with a generous bound
   (CI-safe, compares medians) rather than an absolute number. Specs `auth.md`, `people.md`. Scope `auth`.
6. **Sessions.** _Done, commit `74d41a5`._ Idle and absolute expiry, rotation on step-up and on assurance change (the new credential is returned and saved by the client's
   existing write), `auth.sessions.list|revoke`, `keith sessions`, cap per person with oldest-idle eviction, grandfathering of old rows
   (cap applied on first use, announced in the changelog). Scope `auth`.
7. **PIN method.** _Done, commit `e3c1bbc`._ The `pin` adapter, `assurance 1`, "PIN session cannot step up", PIN allowed from `loopback`, `lan` and `tailscale` by default,
   not `public`; the person-wide backoff for the owner on `lan` (a delay and an audit alert, never a lock). Specs `auth.md`. Scope `auth`.
8. **Policy admin and lockout guard.** _Done, commit `a0820b9`._ `admin.auth.policy.get|set` (owner, step-up, audit `auth.policy.set`); `set` is refused if the owner would
   keep no method reachable from `loopback`; offline `keith-core auth policy reset` (like `token recover`). Scope `auth`.
9. **Client controller.** _Done, commit `7c353be`._ `createSignIn` becomes `address -> checking -> identify -> flow(step...) -> done`; `SignInMethod` widens to `string`;
   an old core without `/auth/identify` falls back to the three fixed methods. Spec `client.md`, `tui-login.md`. Scope `client`.
10. **Home login panel.** _Done, commit `be6bf19`._ `features/login` renders the generic step (fields from the description); Home embeds the panel at start; the LAN warning;
    PTY test: type an identifier and a PIN, land signed in. Specs `tui-login.md`, `tui-design.md` (5.13, 5.16), `tui.md`. Scope `tui`.
11. **Socket phase 1: owner idle-lock.** _Done, commit `f0d6042`._ Core keeps a lock state; after N idle minutes or `keith lock` the socket answers `423 locked` until the
    owner PIN unlocks; the Home panel shows the unlock form; `keith-core` offline commands stay physically gated. Spec `auth.md`, `core-cli.md`. Scope `auth`.
12. **Socket phase 2: the socket needs a session.** _Done, commit `eee1cdd`._ Per-person `local trust` knob (`none | idle-lock | full`, default `idle-lock`); the admin CLI
    prompts for a PIN once (sudo-style 15-minute cache). Migration note for scripts. Specs `auth.md`, `cli.md`. Scope `auth`.
13. **Docs and proof.** _Done, the commit that moves this plan to `done/` (a commit cannot name its own hash)._ `docs/manual-testing.md`, smoke additions (identify, PIN from the loopback, decoy shape, session list and revoke, policy reset),
    ADR index, this plan moved to `done/` with gate evidence. Scope `repo`.

## Progress and deviations (Nov 8, 2026, steps 1 to 4)

Gates: `bun run check` green after each step (1450, 1497, 1500 and 1502 tests, 0 fail); `bun run smoke` passed 15/15 after step 3 and after step 4, no process left.

- **Step 2.** The parity table (`network-rule.parity.test.ts`, 34 rows) was written and passed against the old hand-written rule first, then unchanged against the engine. `lan` exists in `zoneOf` but nothing wires `createLanNets` into `compose.ts` yet (the default policy refuses `lan` for the password, so wiring changes nothing); step 5 or 7 wires it when PIN needs it. Container and VPN interfaces (`docker*`, `br-*`, `veth*`, `utun*`, `tun*`, `wg*`, `zt*`, `vmnet*`) are skipped when computing on-link subnets, so a peer there is `public` (safe side).
- **Step 3.** The token adapter is descriptor-only (there is no server step for a pasted credential) and the device adapter is a descriptor (routes stay in `device.ts`). `begin`, `enrol` and `revoke` of `AuthMethod` are not added yet: they have no caller before the flow (step 5). Only `password` has `verify`, moved from `login.ts` unchanged.
- **Step 4.** Deviation: the plan said "`kind` gains `session`". Not done in 0008. `CredentialKind` in `packages/db/src/repos/credentials.ts`, `WhoamiSchema.credentialKind` (`admin.ts`), and the `kind`-filtered lists in `admin/procedures.ts` (`'device'`, `'token'`) all switch on kind. Step 6 should either keep `device`/`token` and use `methods` to tell sessions apart (preferred, no collision), or widen all of those together. `person_identifiers.value_norm` is the primary key (unique across people) with an index on `person_id`.
- Migration test uses fresh temp databases only (`migration-0008.test.ts`); the real database was never touched. The owner's backup-then-migrate procedure is in `docs/specs/db.md`.

### Steps 5 to 8 (Nov 8-9, 2026)

Gates: `bun run check` green after each step (1517, 1531, 1547 and 1564 tests, 0 fail); `bun run smoke` passed 15/15 after step 5 and after step 8, no process left.

Deviations (safe behaviour chosen over the plan text):

- **Step 5.** The decoy equality is proved by counters, not wall-clock: the same number of SQL queries and of argon2 verifies for a known and an unknown identifier (`flow.test.ts`; this caught two real differences, the `person_secrets` read and the lock read, now done on the counter key of a decoy). The median-timing test is deliberately loose (a fixed 25 ms floor) and only a smoke alarm. `throttle.failed` now writes the person-wide row for an unknown subject too (same writes as a known one). Plan said "HMAC-derived stable decoy": not needed, the flow list depends on zone and policy only and the counter key is a SHA-256 of the normalised identifier (the same one `/auth/login` uses), so lockout is shared between the decoy and the legacy path. `person_identifiers` aliases are refused when the value already identifies someone (an alias cannot shadow a username or an id).
- **Step 6.** Kinds stay `device` and `token`; sessions are told apart by `methods` (no `session` kind, no widening of `CredentialKind`, `WhoamiSchema` or the kind-filtered lists). **Rotation on step-up is opt-in** (`rotate: true`): an older client that ignores the new credential in the answer would otherwise lose its session. The old credential works for a 60 s grace. Assurance changes only with a rotation. **Cap** (20) applies only to sign-in sessions made by the password or a PIN; device-code approvals, tokens and every row from before P14 are never evicted (the plan said "cap applied on first use"; that could have revoked existing device credentials without an owner action). Default lifetimes: password 30 days idle and 180 absolute, PIN 12 hours and 7 days, device and token none. `keith sessions` (the TUI binary) is not added: `keith-core sessions list|revoke` and the typed client API (`auth.sessions.*`) exist; the TUI side belongs to steps 9-10 (`apps/tui/src/cli.tsx` was not touched).
- **Step 7.** A PIN session cannot step up **with the PIN**; it can with the password (the network rule still decides where a password may be typed). `pin` is never offered from `public` even with `KEITH_INSECURE_LOGIN`. The person-wide LAN delay is applied to every subject (an unknown identifier too) so the owner's identifier cannot be told apart by who gets `429` across addresses; capped at 30 s, never a lock, plus an `auth.pin.alert` audit row every 5th failure. Added beyond the plan: `auth.pin.set` (own PIN, needs a step-up) and the end of PIN sessions when a PIN changes or is cleared. `pin` is not in the legacy `/auth/methods` body (byte-exact list kept).
- **Step 8.** The guard checks the owner's usual zones (loopback, plus tailscale when the caller arrives by Tailscale or `access.proxy` is `tailscale-serve`) and every CIDR; the plan said loopback only. `admin.auth.policy.*` uses `settings.manage` plus an owner-role check in the handler (a new capability would be grantable). `keith-core auth policy` is one command with positionals (`packages/cli` nests one level). Also added `auth policy show|set --file`.

Open verifications after steps 5-8: (1) still the owner's-laptop check of `os.networkInterfaces()` and the real peer address on the LAN (2): not done. (3) done by counters (see above) plus a loose median test; the residual leak under load (2-slot hasher queue) is documented in `auth.md`.

Open verifications: (4) done: `scripts/smoke.ts` asserts nothing on `/auth/login` or `/auth/methods` directly (it drives the real CLIs); the byte-exact legacy `/auth/methods` body is pinned in `methods/registry.test.ts` and `methods.test.ts`. (5) done: no `kind === 'session'` collision exists today because the value is not introduced; see the step 4 note. (1) partly: injected-interface unit tests pass (`zone.test.ts`); the owner's laptop check is still to do. (2), (3) open.

### Steps 9 and 10 (Nov 9, 2026)

Gates: `bun run check` green after each step (1575 tests after step 9; 1588 after step 10, 13 skipped), 0 fail.

Deviations (safe behaviour chosen over the plan text):

- **Step 9.** The sign-in screen's method list is gone: the identifier box and the method tabs replace the legacy `method`, `password` and `token` states (`submitPassword` and `submitToken` are replaced by `submitStep`, `chooseMethod` is synchronous). Failures that the user can simply repeat stay inside `identify` and `flow` as a `problem` (the form keeps what was typed); `error` is only for the health check. A throttled answer (identify or flow) is not resent before `retryAt`. The old-core fallback also triggers on `401` (an old core's auth middleware answers before its router) and `405`, not only `404`; a legacy password goes to `/auth/login` with the identifier as the username and the zone is unknown (`context: 'public'`, so no LAN warning). The remembered identifier is a separate `client-state.json` next to `client.json` (the credential file needs a token, so it cannot hold a signed-out client's identifier); it is written only when a sign-in reaches `done`. `sign-in.ts` is still 653 lines (warning, under the 800 limit): the types and the requests moved out, the controller itself stays whole.
- **Step 10.** The panel is drawn like the approval dialogs (absolute, over the lower orb), not in the caption slot, so the orb never resizes; the panel's legend is Home's legend row fed from the step's `useFooter`. The plan's legend `d device code · t token · c change core` is replaced by `tab` over all methods (device code and token are tabs, as the core lists them) and the core is changed from `/login` or `keith login` (the address step stays on the Sign in screen only): a letter key would be typed into the identifier or the secret. Home's `space`, `tab` and `enter` are off while the panel is up. `keith` with no core found and `keith login` still open the Sign in screen (address first) as before; the nocore pty test no longer presses `esc` to Home, because what Home shows at `http://localhost:7420` depends on the machine (hermetic now). The fake core gained `flow` (identify and flow answers with decoys, 429) and `revoked` (a signed-out client from the start).

Unverified after steps 9-10: everything about the identifier-first flow in the TUI was run against the fake core (`apps/tui/src/testing/fake-flow.ts`) and a fake `fetch`, never against the real core's routes from this client; `bun run smoke` still drives only `keith login` (device) and the legacy routes. The LAN warning and the zone were not seen on a real LAN (open verification 1 and 2 above). Steps 11 to 13 must know: a locked or session-requiring socket answers something other than 401 (`423 locked`): Home must show the unlock form for it, and `loggedOut` is derived from 401 only; the panel is mounted only when `connection` is an http(s) URL (not `unix:`), so a socket that needs a session needs its own panel host; `createSignIn` has no PIN-unlock step (a core that answers the owner PIN for the unlock could use `submitStep` with a `pin` method of the same shape); the smoke should drive identify and the PIN through plain fetch (scripts import no workspace package) and the TUI through the pty only for the panel.

### Steps 11 to 13 (Nov 9, 2026)

Gates: `bun run check` green after each step (1609 tests after step 11, 1637 after step 12, 13 skipped, 0 fail; the final count is in "Gate evidence").

Deviations (safe behaviour chosen over the plan text):

- **Step 11.** The lock is **off for an owner without a PIN** (it would have no way to open): the socket never locks, `keith lock` answers `409 no_pin` and says to set one, `keith-core doctor` warns `owner PIN`. So **an upgrade locks only an owner who already has a PIN** (default 15 idle minutes, `keith-core auth local set --idle-minutes 0` turns it off); written in `auth.md` and in the changeset (the upgrade note). Idle is judged lazily, when the next request arrives (no timer), which is observable-equal and testable with a fake clock. **Activity** is write-like only: `POST` under `/sessions/` (chat), `POST /attention/:id/answer`, every `/rpc` call whose last segment is not `get`, `list`, `whoami`, `describe` or `models`; `/health`, the feed, `GET /attention`, `GET /sessions/*`, the sign-in routes and `/nodes/*` never count. A person who only reads for longer than the idle time is locked (known cost, in the spec). The lock state is in memory: a core restart starts unlocked. Unlock takes a PIN **or the password** with the same throttle counters as other sign-ins (address key `local`); audit `auth.lock` (`reason: idle|manual`), `auth.unlock`, `auth.unlock.failed`, `auth.local.set`. Added beyond the plan: `keith unlock` (a command to unlock from a script or when `keith` is not wanted), `keith-core auth local show|set`, the `owner PIN` doctor check. `keith-core` offline commands never touch the socket and are unaffected. The TUI detects the lock through `whoami` (`423`), and asks again when the feed starts to reconnect (a locked socket refuses the feed). The unlock panel mounts only for a socket connection; after the PIN the app swaps to a fresh connection on the same socket.
- **Step 12.** The level is stored in the settings key `auth.local` (`{ idleMinutes, trust: { <personId>: level } }`) rather than on `people` or in `auth.policy` (no migration; the policy stays about sign-in methods). Only the current owner ever arrives on the socket, so the per-person map matters for that owner (a transfer gives the new owner the default). **Setting `none` is refused** without a PIN or password for that person and when the stored policy would leave the owner no PIN or password from `loopback`. `full` needs `acknowledge: true` (the CLI prints the warning and needs `--yes` or a typed confirmation). **A session credential presented on the socket steps up like on TCP**: `stepUpDenial` and `/auth/step-up` now look at `principal.credential`, not at `via`, so `none` is not a way around the step-up (the implicit owner stays always stepped up). The admin session (sudo-style) is a `device` credential labelled `keith-core (local admin)`, 15 idle minutes (slides), 12 hours at most, stepped up for 15 minutes because the PIN was just typed; the process keeps it in `<dataDir>/admin-session` (0600), the server stores a hash. **The offline way back** from a forgotten PIN under `none` is `keith-core auth local reset` (core stopped), added beyond the plan (without it `none` plus a lost PIN would be a lockout; `people pin` needs a session). The TUI socket host is `SocketLoginPanelHost`; the credential goes to `socket-session.json` **next to `client.json`**, not into it, so a remote login is never replaced; `Connection` (socket) gained `token`. `/logout` on such a connection revokes it. `keith sessions` of the plan is still not a `keith` command (`keith-core sessions` and `auth.sessions.*` are the surface); `cli.md` (the toolkit spec) needed no change, the `keith` commands are in `tui.md`. A script that talks to the socket with no credential under `none` needs `Authorization: Bearer <keith-core token create>` or the PIN piped to its first `keith-core` command (migration note in `auth.md` and the changeset). `auth.whoami` gained optional `methods` and `assurance` so `/whoami` can say `device credential (pin session)`.
- **Step 13.** The real-core TUI proof is in the smoke (`scripts/smoke/sign-in.ts`), not in a `bun test` file: smoke is the repo's place for real processes against a real core, and the pty tests here run against the fake core on purpose (they are fast and run in `check`). The TUI binary runs in a pty (`Bun.spawn({ terminal })`) with an empty data dir and a client config of its own, `home --core http://127.0.0.1:<port>`, so nothing can lead it to the socket; it types `owner`, the PIN, lands on Home `signed in`, and `/whoami` shows `device credential (pin session)`. The pty draws a field cell by cell, so the smoke never matches typed text or the masked dots in the stream; it matches the screens before and after, and checks the PIN is never on the terminal. Smoke total budget raised from 75 s to 170 s (a run takes about 20 s). Not a clean-copy gate: see Gate evidence.

Unverified after steps 11-13: the owner's-laptop checks (open verifications 1 and 2: `os.networkInterfaces()` and the real LAN peer address on a phone) and everything of the "Owner to run" list that needs a second device (LAN warning on a real LAN, Tailscale zone) was not run by an agent; the idle-lock timing was tested with fake clocks and one real wait was not done (a real 15-minute wait); the unlock and the socket sign-in panels were driven in a real pty against a real core only through the smoke.

### Deviation note, 2026-11-09 (ADR-0014 amendment)

Superseded after the owner's feedback: the default `local trust` is `none`, not `idle-lock` (an upgrade no longer leaves the owner implicitly signed in on
the socket); the TUI socket session is in memory only (no `socket-session.json`); the admin CLI session is in memory or `KEITH_ADMIN_SESSION`, 5 minutes
(no `admin-session` file); setup requires an owner PIN and/or password; a first-owner flow over the socket covers a set-up install with none; and
`auth local set` works offline. The step 11 and 12 notes above describe the earlier behaviour. See the ADR amendment and `docs/specs/auth.md`.

## Risks

- **Reversing the LAN rule** exposes the PIN to sniffing on plain HTTP: mitigated by zone, throttle, no step-up, a visible warning and a short PIN idle timeout.
- **Owner lockout** by a bad policy: the guard in step 8 and the offline reset.
- **Migration on the owner's real data:** additive only, copy first, `assertMigrated` still refuses an unmigrated file.
- **Enumeration through timing or shape:** tested by comparing known and unknown identifiers; a residual leak under load is documented.
- **Breaking scripts** when the socket needs a session (step 12): phase 1 first, the knob defaults to idle-lock, release notes.
- **`check-size`:** `sign-in.ts` is already 590 lines; split it into controller, steps and compat in step 9.

## Open verifications (the research could not confirm; how to check)

1. `os.networkInterfaces()` on macOS and Linux gives address and netmask for IPv4 and IPv6 on-link subnets, and Docker or VPN interfaces are not mistaken for LAN: unit-test with injected interfaces, then check by hand on the owner's laptop.
2. Bun reports the real peer through `server.requestIP` for IPv4-mapped IPv6 sockets (the code already unwraps `::ffff:`); confirm on the LAN with a phone.
3. Decoy timing: argon2 verify happens in the same step for known and unknown identifiers; measure medians over 200 calls in a test.
4. Which fields the existing smoke asserts on `/auth/login` and `/auth/methods` (they must not change).
5. Whether `credentials.kind = 'session'` collides with any switch on `kind` (grep `kind ===` in `modules/auth` and `admin` before step 4).

## eharness impact

None. The opaque `{ id }` principal is enough; Keith keeps `front:<personId>` and maps its `Actor` to it. A typed or attribute-carrying `Principal`
is already future work in eharness ADR-0069: optional follow-up, not needed here.

## Verification items for the gate

- Parity test of the old network rule is green and still present.
- Identify returns the same shape and status for a real username, an email, a phone, an unknown string and a display name.
- A PIN session gets 403 on a step-up action; a password session does not.
- Idle and absolute expiry, rotation and revoke have tests with a fake clock.
- Policy set that would lock the owner out is refused; `auth policy reset` works with the core stopped.
- Migration test runs against a copy of a real database.
- The raw pty bytes never contain a typed password or PIN.

## Gate

`bun run check` exit 0 on a clean copy of the last commit; `bun run smoke` passes with the new steps; the PTY test signs in with an identifier and a PIN;
record the counts like P13. The plan moves to `docs/plans/done/` in the docs commit of step 13.

## Gate evidence

Nov 9, 2026, on the working tree of the commit that moves this plan. It is **not** a clean-copy run: the tree also held the owner's
uncommitted `apps/tui/src/cli.tsx` and `scripts/manual.ts`, which were not touched and not staged (the checks of steps 11 and 12 ran
the same way and passed).

- `bun run check`: exit 0. Biome, tsc on every package and the scripts, `bun test` (**1639 pass, 13 skip, 0 fail**, 1652 tests in 199
  files; 1609 after step 11, 1637 after step 12), check-imports (644 files), check-entry, check-size (warnings only, none above 800:
  `app.tsx` 701, `scripts/smoke/sign-in.ts` 438, `scripts/smoke.ts` 444, `auth-commands.test.ts` 438, `compose.ts` 401, and older ones)
  and check-exports ok (9 entries).
- `bun run smoke`: `SMOKE PASS (26 steps ok, about 20 s)`, no process and no temp folder left. New steps (plain `fetch` and the real
  CLIs, no workspace import): identify answers the same shape for a known, an unknown and a display-name identifier; PIN login from
  the loopback with a freshly set PIN (the wrong PIN gives the same 401 body for the owner and for a made-up name); sessions
  (list, a PIN session cannot step up with the PIN, rotation on step-up, revoke by the CLI then 401); policy show, set and the
  lockout-guard refusal; `keith lock` then `423` (with `/health` still 200), `keith unlock` with a wrong then the right PIN then `200`;
  the real TUI on a locked socket shows the `Locked` panel and the PIN opens it; `local trust none` gives `401` on the socket, the
  admin CLI asks once and the next command uses the 0600 cached session; the real TUI signs in through the socket under `none`
  (identifier, PIN, `socket-session.json` 0600, `client.json` untouched); **the real TUI against this real core over TCP, no socket,
  signs in with an identifier and the PIN, lands on Home signed in and `/whoami` says `device credential (pin session)`** (passed);
  the audit lists `auth.lock`, `auth.unlock`, `auth.local.set`, `auth.policy.set`, `auth.login.ok` and no PIN; and, with the core
  stopped, `auth policy reset` and `auth local reset` work (and refuse while the core runs).
- Earlier in the plan: PTY `cli.signin.pty.test.ts` and `home-login.test.tsx` (fake core), parity table of the old network rule,
  decoy equality by counters, fake-clock tests for expiry, rotation and the idle-lock.
- Not verified by an agent: see "Unverified after steps 11-13" above and the owner list below.

## Owner to run

Everything below is for the owner (docs/manual-testing.md, Scenario 12). Commands to migrate your own data (back up first):
`cp data/keith.db data/keith.db.bak`, then `bun run db:migrate` (try it on a copy first), then `keith-core doctor` (shows the migration and
`owner PIN`). To try the new login by hand: `keith-core people pin owner` (once), `keith` (type your username, then the PIN), `keith lock` and `keith unlock`,
`keith-core auth local show`, `keith-core auth local set --trust none` (and `--trust idle-lock` to go back; `keith-core auth local reset` with the core stopped
if you forget the PIN).

1. Back up the database, run `bun run db:migrate` on a copy, then on the real file; `keith-core doctor` shows the migration.
2. From the laptop (loopback): open `keith`, type your username, get the PIN field, sign in.
3. From a phone or second machine on the Wi-Fi: type your email, get the PIN field with the plain-HTTP warning; sign in; try a dangerous tool and see that it asks for the password.
4. From Tailscale or a public URL: type the same identifier, see password only.
5. Type a made-up name: the panel looks the same; the wrong secret gives the same line.
6. `keith-core sessions list`, revoke one, see the other client fall to the Sign in panel (`keith sessions` was not added).
7. `keith lock`, then use the socket: it asks for the PIN.
8. Break the policy on purpose, then `keith-core auth policy reset`; try `--trust none` and `--trust full`.
9. Check the owner's-laptop open verifications 1 and 2 (the real interfaces and the peer address on the LAN).
