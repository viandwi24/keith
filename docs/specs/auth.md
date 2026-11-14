# Auth

Code: `apps/core/src/modules/auth/` (public API in `index.ts`), `apps/core/src/modules/audit/`, storage in `packages/db/src/repos/{tokens,credentials,devices,audit}.ts`. ADR: `docs/decisions/0008-admin-socket-and-identity.md`.

## Purpose

Identify who calls the core. Every person (the owner and members) comes in one of these ways: a
session credential (TCP or the local Unix socket), a legacy token (TCP, still accepted), or, only when the owner opted in to
local trust `idle-lock` or `full`, the implicit owner of the local Unix socket (no credential: the file mode is the login, see
"Boot and the socket" and `thalamus.md`). By default (local trust `none`, ADR-0014 amendment of 2026-11-09) the socket serves no
implicit owner. A person can also sign in with a password or PIN (below). A credential is shown once and only
the SHA-256 of its secret is stored.

## Credentials

Format `keith_s_<id>_<secret>`: `id` is 6 random bytes as 12 lower-case hex characters, `secret` is
32 random bytes base64url (43 characters). Table `credentials` (`db.md`): `id`, `person_id`, `kind`
(`device` from device or password login, `token` from `token create` and `token recover`), `label`,
`secret_hash`, `created_at`, `last_seen_at`, `last_ip`, `revoked_at`, `elevated_until` (step-up window end); since P14 also `methods`, `assurance`, `idle_expires_at`, `absolute_expires_at`, `user_agent`, `revoked_reason` (read and written since step 6: see Sessions below).

`verifyCredential(repo, token, { now?, ip? })`: parse (regex above, anything else is `undefined`,
so the legacy parser may take it) → look the row up by id → compare `SHA-256(secret)` with the stored
digest using `timingSafeEqual` (an unknown id still does one compare, so timing does not reveal it)
→ refuse a revoked one, and one whose person is not `active` (a suspended or left person is denied; P9 has no guest role, so there is no reduced access; the check reads the person row that the credential lookup already joins, once per request). It writes `last_seen_at` and `last_ip` at most once a minute per credential
(`LAST_SEEN_EVERY_MS`); a failed bookkeeping write never refuses a valid credential. The resolved
`Principal` carries `username` and `name` (from the person row), and `credential: { id, kind, assurance?, methods? }` (`kind` is `device`, `token` or `legacy`; absent on the
socket) and `elevated` (see Password, PIN and step-up).

**Legacy tokens** (`keith_` + 32 bytes base64url, table `client_tokens`) keep working through
`verifyAuthorization`, now strict about shape (`^keith_[A-Za-z0-9_-]{43}$`). `token list` shows them
as `legacy`, and `token revoke` and `token recover` cover them. No data was converted.

**Node tokens** (`keith_node_…`) match neither parser (different prefix and length) and only open
`/nodes/ws` (see below).

## Device login

For another device (a second terminal, another computer). Code: `modules/auth/device.ts`.

1. `POST /auth/device/start` (no token, body at most 4 KB, JSON `{ label? }`) →
   `{ code, requestId, expiresAt, pollSecret }`. `code` is 8 characters of
   `ABCDEFGHJKMNPQRSTUVWXYZ23456789` shown as `XXXX-XXXX` (`eharness/identity`
   `generatePairingCode`, `normalizePairingCode`, `hashPairingCode`), valid 10 minutes, single use.
   `pollSecret` is 32 random bytes base64url. Core stores only `SHA-256(code)` and `SHA-256(pollSecret)`
   (table `device_requests`).
2. The owner approves with `keith-core devices approve <code> [--label]` (`admin.devices.approve`,
   over the socket or an owner session). Core creates a `device` credential for the owner, bound to the
   request. The credential's secret is `base64url(SHA-256("keith-device-credential-v1:" + pollSecret))`:
   only its hash is stored (on the request), and only the holder of the poll secret can compute it, so no
   plaintext credential waits in the database.
3. `POST /auth/device/poll` `{ requestId, pollSecret }` (the client asks every 2 s) →
   `{ status: 'pending' }`, `{ status: 'approved', credential }` (returned once, then the request is
   deleted), `{ status: 'denied' }` (once) or `{ status: 'expired' }` (once; an approved but
   uncollected credential is revoked; the purge of requests expired for over an hour, on each start and on the prune tick, revokes the credential of an approved but never collected one too: `credential.revoked`, `by: 'expiry'`). An unknown id, a wrong secret and an already consumed request
   all answer the same `404 NOT_FOUND`.

Limits: at most 5 pending requests per client address (`429 TOO_MANY_PENDING`), 15 starts and 20
failed polls per address per 10 minutes (`429 TOO_MANY_ATTEMPTS`, `eharness/identity` `pairingGuard`).
The client address is the socket peer, never `X-Forwarded-For`. Codes are never stored in clear and
`devices list` shows label, address and age, not codes. A label is trimmed, 1 to 80 characters, with no control character, escape or bidirectional mark (`400` otherwise; `devices approve --label` follows the same rule); rows stored before that rule are cleaned at render only. Why brute force does not pay: a code only
matters to the owner who approves it; an attacker cannot approve, and the poll secret is 256 bits.
See SECURITY.md for the social-engineering case (approve only a code you saw on your own screen).

Owner side (`admin.devices.*`): `list` (pending requests and `device` credentials), `approve`,
`deny`, `revoke <credentialId>` (device credentials only). All audited.

## Password, PIN and step-up (P9 step 2)

Code: `modules/auth/methods/registry.test.ts` (order, duplicates, valid descriptors, byte-exact legacy list); `modules/auth/{local-access,local-activity,hasher,password-rules,throttle,network-rule,login}.ts`; secrets in `person_secrets`,
counters in `auth_attempts`, `credentials.elevated_until` (`db.md`).

**Secrets.** A person may have a **password** (starts a session, assurance 2) and a **PIN** (starts a weaker session, assurance 1, from the zones the policy names since P14 step 7, and confirms a step-up on a device-code or token session). Both are argon2id PHC strings in `person_secrets` (one row per person and
kind), separate from the bearer credentials: those are random 256-bit values hashed with SHA-256,
these are human secrets hashed slowly. Hashing is `Bun.password.hash(x, { algorithm: 'argon2id',
memoryCost: 65536, timeCost: 2 })` (64 MiB, about 80 ms), after NFKC normalization. A global
semaphore allows **at most 2** hashes or verifies at once; the rest queue and give up after 5 s
(`HasherBusyError`, a uniform `503 { error: 'unavailable' }`). An account without a hash is verified
against a dummy hash of the same cost, so unknown users cost the same time as wrong passwords.

- **Password rules** (`checkPassword`): 15 to 256 characters, no composition rules, paste and spaces
  allowed; refused when it is on the small blocklist (`password-blocklist.json`: common passwords and
  phrases, compared after dropping case and punctuation, also with digits added at the end), one
  character or a short unit repeated, a keyboard or digit run, or when it contains the username (3
  characters or more) or the display name (4 or more). **PIN:** 6 to 12 digits.
- **Set and clear:** `admin.people.setPassword|setPin|clearSecret|unlock` (`people.md`, CLI
  `keith-core people passwd|pin|unlock|clear-password|clear-pin`). Over TCP they need a step-up.
- **Offline owner secrets end old sessions:** `keith-core setup` and `start` that set the owner's PIN or password (`saveOwnerPin`,
  `saveOwnerPassword`) revoke every credential of the owner and write `person.sessions.revoked` (`via: offline`, detail `personId`,
  `reason`, `count`); `POST /auth/local/first-owner` revokes the owner's other credentials before it creates its own session
  (same row, `via: local`, reason `first-owner`). Rotating a leaked secret therefore also kills a leaked session.

**`POST /auth/login`** (no bearer; body at most 4 KB): `{ username, password, label? }` → `200
{ credential }`, a `device` credential of that person (label default `password login`). The username is
trimmed and lower-cased. Every refusal is `401 { error: 'invalid_credentials' }`, for an unknown user, a
wrong password, a person without a password, a suspended or left person and a locked member alike, with
about the same work (dummy verify). Other answers: `400 { error: 'bad_request' }`, `413`, `403
{ error: 'login_not_allowed_here' }`, `429 { error: 'throttled', retryAfter }` (+ `Retry-After`), `503
{ error: 'unavailable' }`.

**`GET /auth/methods`** (no bearer, behind the Host guard): tells a client, before it asks for credentials, which
login methods this core accepts from the caller's address. `200 { methods: [{ id, available, reason? }] }` with
`id` one of `device`, `password`, `token` in that order (`AuthMethodsSchema` in `@keith/contracts`). `device` and
`token` are always `available: true`. `password` is `available: false` with a short generic `reason` (use a
private network address or the device code) when `networkRule` refuses this caller: it is the same call, with the
same peer, forwarding headers, `access.proxy` and `KEITH_INSECURE_LOGIN`, as `/auth/login` makes. The body is
static in size (under 300 bytes), says nothing about accounts (no names, no count, no sign that a person has a
password) and names no address or setting; `Cache-Control: no-store`. It reads a static rule: no audit row, no
throttle, no database access. An older core answers `404`; a client then offers all three methods.

**Network rule** (`networkRule`, now the `password` rule of `DEFAULT_POLICY` evaluated on `zoneOf` of the peer, `insecure` and `local` still short-circuit; the parity table `network-rule.parity.test.ts` pins every decision; for `/auth/login`, `/auth/step-up` and `GET /auth/methods`). Allowed: the local socket; a TCP
peer that is loopback **without** forwarding headers; a Tailscale address (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`); or a loopback peer **with** forwarding headers when the setting `access.proxy`
is `tailscale-serve` (then the audit detail carries `tailscaleUser` from `Tailscale-User-Login`, if
present). Refused with `403 { error: 'login_not_allowed_here' }` (and an `auth.login.refused` or
`auth.step_up.refused` audit event): a request with `Tailscale-Funnel-Request` (public Funnel), forwarding
headers from anywhere else or without the setting, and any other peer (a LAN or public address). The
peer is the TCP address, never `X-Forwarded-For`. `KEITH_INSECURE_LOGIN=true` (`config.ts`) lifts the
rule entirely (for a deliberate setup behind your own TLS proxy); it is off by default and the
risk is in `SECURITY.md`.

**Throttling** (`throttle.ts`, table `auth_attempts`, so a restart does not reset it). Counters are kept
per (account, peer address); an unknown username is keyed by a hash of the name, so it behaves the same.
The first 4 failures are free; from the 5th the address waits 1 s, doubling per further failure to a
5 minute cap. While the wait runs the route answers `429` with `Retry-After` (even for the right
password) and does not count the attempt. Failures from all addresses also add to a person-wide
counter (written for an unknown subject too, so a decoy does the same writes; only a known member can be locked): a **member** is locked at 20 until `keith-core people unlock`; the **owner is never locked**,
only delayed (the socket and `people unlock` are the recovery). A success clears every counter of the
person. A locked member's right password still answers the uniform 401. Idle counters older than a
day are pruned.

**`POST /auth/step-up`** (bearer of a `device` or `token` credential): `{ pin }` or `{ password }`
(exactly one) → `200 { elevatedUntil }`. The window is **fixed at 10 minutes** (`STEP_UP_MS`) from the
confirmation: using the session does not extend it, a new step-up restarts it. It is stored on the
credential row (`elevated_until`); credentials are rotated only when the request asks (`rotate: true`, see Sessions). Errors: `401 invalid_credentials`
(wrong secret, or a kind that is not set; counted and throttled like a login, same counters), `401
unauthorized` (no valid bearer), `403 no_step_up_method` with `hint: 'keith-core people pin <username>'`
(neither PIN nor password set), `409 legacy_credential` (a pre-credentials token has no row to elevate:
sign in again), plus the network-rule, `400`, `413`, `429` and `503` answers above. The local socket is
always elevated (the answer is `{ elevatedUntil: now + 10 min }`, nothing is stored).
The zone rule that gates a step-up follows the method that answers (ADR-0027 §2): a PIN step-up follows the `pin` rule (loopback, lan, tailscale), a password step-up the `password` rule. The route reads the body first, then gates by the answer kind; a refusal is still one uniform `403 login_not_allowed_here` with the same audit row, and the kind is the caller's own, so it is no oracle.

**`principal.elevated`.** The resolver sets `Principal.elevated`: `true` for the socket, `true` for a
credential whose `elevated_until` is in the future, `false` for a legacy token, absent (false) for a
principal built by hand. It is read in the same single lookup per request. `auth.whoami` returns
`elevated`. The capability middleware reads it (`permissions.md`): a procedure marked `stepUp` from a
remote principal that is not elevated is an oRPC error with `code` `KEITH_STEP_UP_REQUIRED` (HTTP 403;
constant in `@keith/contracts`). A legacy token is never elevated and cannot become so: replace it with
`keith-core token create` (a `token` credential) to do sensitive things remotely.

**Revocation** (`people.md`): suspend, an owner transfer (both people; a role change cannot happen today: `setRole` accepts only `member` and refuses the owner, so its revoke never fires), setting or
clearing a password revoke every credential and legacy token of the person (audit
`person.sessions.revoked`, `credentialsRevoked`/`sessionsRevoked` counts). Reactivating does not bring
them back; the person signs in again. Setting or clearing a PIN ends the sessions the PIN made (`methods` contains `pin`) and nothing else. The implicit owner of the socket (opt-in local trust) has no credential and
follows the owner role by itself. "Stops working at once" includes open streams: a revoked credential, a suspended, removed or transferred person and a grant change close the open activity, session and attention streams (`thalamus.md`, Open streams). `admin.tokens.revoke` and `admin.devices.revoke` act on the caller's own credentials unless the caller is the owner (ADR-0027 §5); offline setup that sets a secret revokes the owner's other sessions.

**Succession claim (P29, `docs/specs/succession.md`).** `admin.succession.claim` is the one other way ownership moves. It revokes the sessions of both people, as an owner transfer does: the heir signs in again as owner, and the previous owner as a suspended member. The claim is refused over the local socket (`FORBIDDEN`). It needs the heir's own password or PIN and a fresh step-up, and it re-reads the owner's last sign inside its transaction. Recovery stays offline: `keith-core token recover` on the host.

## Adapters, zones and policy (P14, ADR-0014)

Schemas: `packages/contracts/src/auth-flow.ts`. Status per part is in the plan
(`docs/plans/done/P14-auth-adapters-and-login-panel.md`); this section is the contract the steps build to.
The old routes (`/auth/login`, `/auth/methods`, device routes, `/auth/step-up`) keep their behaviour.

**Zone** (`AuthZone`; shipped in P14 step 2): `loopback`, `lan`, `tailscale` or `public`, derived from the TCP peer only (`modules/auth/zone.ts`).
A forwarding or Funnel header never lowers a zone: a loopback peer carrying `Forwarded`, `X-Forwarded-*`, `Tailscale-*`
headers is `public`, except when the setting `access.proxy` is `tailscale-serve` (then it is `tailscale`, as the network
rule allows today). `lan` is a private address (RFC 1918, `fc00::/7`, `fe80::/10`) that lies inside an on-link subnet of the
core's own interfaces (`os.networkInterfaces()`, injected so tests use fake lists), not a Tailscale address; the owner may add
CIDRs (`AuthPolicy.lanCidrs`). The local socket is not a zone: it is `via: 'local'` and is always allowed.

**Policy** (`AuthPolicy`; engine and default shipped in P14 step 2, one rule per method: `method`, `zones`, `cidrs`, `roles?`, `identifierKinds?`,
`idleMs`, `absoluteMs`). Evaluated when listing methods and again at verify (`modules/auth/policy.ts`: `ruleFor`, `allows`; a rule admits a context by zone **or** CIDR, then by role and identifier kind when those are known; the first admitting rule wins).
The default policy reproduces the network rule exactly: `password` from `loopback` and `tailscale`; `device` and `token` from
every zone, and since step 7 `pin` from `loopback`, `lan` and `tailscale`. `KEITH_INSECURE_LOGIN` and the `access.proxy` setting stay inputs of the evaluation.
The rule has no `rateLimit` or `requireAssurance` (they were read by no code and are removed, ADR-0027 §5; throttle constants are fixed in `throttle.ts`): a stored row that still carries them loads without them (`AuthPolicySchema` drops unknown keys) and re-saves clean, while `admin.auth.policy.set` and `keith-core auth policy set --file` refuse a rule with either field (`AuthPolicyInputSchema`: 400, `policy field removed`). `/auth/login` resolves the person through the same identifier lookup as `/auth/flow` and narrows by role and identifier kind exactly like it (a refused member gets the uniform 401 on both routes, an unknown name takes the same path with no role); `sessionTerms` takes `{ role, identifierKind }`, so the lifetime is that of the rule that admits this person whatever the rule order (ADR-0027 §4). 

**Stored policy** (shipped in P14 step 8; `policy-store.ts`, `modules/admin/auth-policy.ts`, `cli/auth-policy-command.ts`). The policy is the settings key `auth.policy` (JSON, `AuthPolicySchema`); `DEFAULT_POLICY` is the
fallback when nothing is stored or the stored value does not parse (a warning names the reset command). It is read on every use (login, step-up, `/auth/methods`, identify, flow, session terms,
the extra `lanCidrs` of the `lan` zone), so a change or a reset applies to the next request without a restart. `admin.auth.policy.get` and `.set` (`settings.manage`, `set` needs a step-up over TCP):
**owner only**, the handler refuses any other person even with `settings.manage` granted. `set` runs the **lockout guard** first: every CIDR must parse (address and prefix length), and from each of
the owner's usual zones (`loopback`, plus `tailscale` when the caller arrived by Tailscale or `access.proxy` is `tailscale-serve`) a `password` or `pin` rule must still admit the owner (role `owner`, identifier kind `username`); otherwise
`BAD_REQUEST` ("refused: the owner would keep no password or PIN sign-in from <zone>") and nothing is stored. A successful `set` writes audit `auth.policy.set` (counts, method names and whether it replaced the default; never the rules'
CIDRs). The guard looks at the policy only, not at whether a PIN or password is set. Honest limit: it protects the owner who edits from afar; an owner with the machine has the socket, and:
`keith-core auth policy show` (the stored policy, or the default) and `auth policy set --file <policy.json>` use the socket; **`keith-core auth policy reset`** removes the stored policy with the core stopped (like `token recover`: it refuses while core
runs), writes audit `auth.policy.reset` (`via: offline`) and brings the default back, including after a stored policy that locks everyone out. Session lifetimes in a rule apply to new sessions only.

**Method** (`AuthMethod`, `modules/auth/methods/`, one file per adapter; shipped in P14 step 3): `id`, `label`, `assurance`,
`interaction`, `firstStep` (a contracts `Step`) and `refusal` (the generic hint). `createAuthRegistry([...])` keeps them in
registration order and refuses a duplicate id. Adapters: `device.ts` and `token.ts` (descriptors; their routes stay in
`device.ts` and the client's `auth.whoami` check) and `password.ts` (`createPasswordMethod(...).verify(attempt)`: throttle,
dummy hash, audit rows and the credential, moved out of `login.ts`; every refusal is still the same 401). `begin`, `enrol` and
`revoke` are added by the step that needs them (`verifyFor` serves the flow). `GET /auth/methods` is served from the registry through `methodDecision(DEFAULT_POLICY,
id, input)` and keeps its body byte for byte (ids `device`, `password`, `token`, in that order; ids outside that enum are
not listed there).

**Identifier-first flow** (shipped in P14 step 5; `modules/auth/{flow,identifier,limiter}.ts`). Two open routes, behind the Host guard,
body at most 4 KB, every answer `Cache-Control: no-store`:

- `POST /auth/identify` `{ identifier }` (1 to 254 characters after trimming) -> `200 { flowId, context, methods }`
  (`IdentifyResponse`). `context` is the zone of the TCP peer (`loopback` for the socket). `methods` lists every registered
  method in registration order (`device`, `pin`, `password`, `token`) with `available`, a generic `reason` when
  it is not, `assurance`, `interaction` and `firstStep` (the step to render; the password step asks for the secret only, the
  identity is already known). The core marks one method `default: true`: the first available of `pin`, `password`. **The list
  depends on the zone and the global policy only**, never on who was typed, so a known id, a username, an email, a phone, a
  made-up string and a display name get the same status, the same shape, the same size.
- `POST /auth/flow/:flowId` `{ method, answer, remember? }` where `answer` is a record of strings (`{ password }`, and an optional `label`
  for the credential) -> `200 { credential }` (a `device` credential, shown once) or an error. A multi-step method would answer
  `{ step }` (`FlowResult`); none does yet. `device` and `token` are not flow answers (`400`): the device routes and a pasted
  credential stay as they are. `remember: true` ("remember this device", ADR-0014 amendment of 2026-11-09) gives the session issued for the answer
  a **30 days idle, 180 days absolute** lifetime (`REMEMBER_IDLE_MS`, `REMEMBER_ABSOLUTE_MS`, `session-terms.ts`) in place of the method rule's, so
  a remembered PIN session outlives the 12 hours of a normal one. Absent or false: a sign-in that is not remembered is capped at **12 hours idle and 7 days absolute** whatever the rule says (the smaller of the rule and the cap; a rule of 0 gets the cap), so it never outlives a working day, and the TUI revokes it on a clean quit (FD10-09, P23.1.13). It is a request of the person, not a policy knob.
- Errors: `400 { error: 'bad_request' }`; `401 { error: 'invalid_credentials' }` (the one refusal for a wrong secret, an unknown
  identifier, a person without a password, a suspended person, `can_login = 0`, a policy restriction by role or identifier
  kind, and a locked member); `403 { error: 'login_not_allowed_here' }` (the method is not offered from this zone: depends on
  the peer only); `404 { error: 'not_found' }` (unknown, malformed, expired or foreign flow); `413`; `429 { error: 'throttled',
  retryAfter }` (+ `Retry-After`); `503 { error: 'unavailable' }`.

*Lookup.* The identifier is trimmed; a user id is matched as typed, a username lower-cased, an email lower-cased, a phone with
spaces, dots, dashes and parentheses removed (a leading `+` kept, 6 to 15 digits). The repo (`identifiersRepo.lookup`) always
runs the same four queries (id, username, email alias, phone alias), match or not; precedence is id, username, email, phone. A new username holds a letter and never equals an id or an alias, so no typed string resolves to two people (P23.1.16; a digits-only username from an older version still resolves, and `doctor` notes it). The
display name is never searched.

*Decoy.* An unknown identifier gets a real flow (random id, 5 minutes, same peer). Answering it runs the same code as a known
person: the same lookups (`person_secrets` and the lock row are read on the counter key), a dummy argon2id verify, the same
audit row (`auth.login.failed`, `usernameHash` instead of `personId`), the same writes to `auth_attempts` (the person-wide row is
written for an unknown subject too), the same `429` after the same number of failures, and the same `401`. The counter subject
is the person id for a known identifier (so lockout is shared with `/auth/login` and step-up) and a hash of the normalised
identifier for an unknown one (`unknownSubject`, shared with `/auth/login` for the same string). Policy that depends on the person
(role, identifier kind) and `can_login` are applied at verify, after the hash work, and fail with the same `401`.

*Limits.* In memory, per process, counted for every call alike: `identify` 60 per address and 10 per (identifier, address) per
5 minutes; flow answers 60 per address per 5 minutes; at most 20 live flows per address and 2000 in total (oldest dropped); a flow
is dropped after 5 wrong answers or on success. These sit in front of the durable per-(subject, address) throttle, which
counts the failures. A restart empties the flows and these windows, not the throttle.

*Tests* (`flow.test.ts`): shape, status and size equality for a username, an email, a phone, an unknown string and a display
name; the policy list by zone; limits equal for known and unknown; the lockout shared with `/auth/login` and between decoy and
real; the same number of database queries and of argon2 verifies for a known and an unknown identifier (counters, not
wall-clock); a loose median comparison of the two paths (generous bound); no identifier or secret in the audit log. Residual,
accepted leak: under load the hasher queue (2 slots) can make a decoy and a real verify wait differently; the work is equal,
the latency is not guaranteed equal.

**Sessions** (shipped in P14 step 6; `credentials.ts`, `packages/db/src/repos/credentials.ts`, `modules/admin/sessions.ts`). A `credentials` row
is a session. Rows keep `kind` `device` or `token` (no `session` kind: every `kind` switch in auth, admin and the whoami
contract stays valid); the way a session was made is `methods` (`password`, `device`, `token`; a row without the column
value reads `['legacy']`), and `assurance` says what it proves (0 possession, 1 PIN, 2 password).

- **Lifetimes.** `idle_expires_at` and `absolute_expires_at` (ms, null = no limit). The rule of the method that
  admits the sign-in sets them (`AuthRule.idleMs`, `absoluteMs`): the default policy gives a **password** session 30 days idle and
  180 days absolute; `device` (device-code approval) and `token` (`token create`) have none. `verifyCredential` refuses a session
  past either end. A use (at most once a minute, with `last_seen_at`) slides the idle end by keeping the window (end minus last
  use) and restarting it; the absolute end never moves. A policy change applies to new sessions only.
- **Remembered devices.** A session made with `remember: true` (flow answer) is the one the TUI may reuse silently: 30 days idle, 180 absolute. The
  client marks its stored login `remember: true`; the core does not distinguish it later (it is an ordinary `device` credential), `sessions list` shows its
  longer expiry, and `/logout` or `keith logout` revokes it.
- **Grandfathering.** Rows created before P14 (and every device-code or token credential) have null expiries and never end by time. Nothing
  is expired without an explicit owner action (`devices revoke`, `token revoke`, `sessions revoke`, a password change).
- **Cap.** After a password sign-in, at most 20 live password or PIN sessions of that person remain: the longest idle beyond it are revoked
  (`revoked_reason = 'evicted'`, audit `credential.revoked` with `by: 'evicted'`). Device-code approvals, tokens and rows without
  `methods` are never evicted.
- **Rotation.** `POST /auth/step-up` with `rotate: true` (opt-in so that a client that does not save the answer keeps working) creates
  a new credential for the same person, kind, label, methods and expiries, with the step-up window and, after a password step-up, assurance 2
  and `password` in `methods`; the answer is `{ elevatedUntil, credential }`, the credential shown once. The old one keeps
  working for `ROTATE_GRACE_MS` (60 s) so a request in flight is not cut off, then ends (`revoked_reason = 'rotated'`, not listed). Without
  the flag nothing changes: the same row is elevated and no credential is returned; the assurance never changes without a rotation.
- **List and revoke.** `auth.sessions.list` (the caller's live sessions: id, kind, label, methods, assurance, created, last seen,
  last address, user agent (cut at 200 characters), both ends, `current`; never a secret) and `auth.sessions.revoke { id }` (own sessions;
  another person's id and an unknown id are the same `NOT_FOUND`; ending a session other than the current one over TCP needs a step-up,
  ending the current one is a logout). `admin.sessions.list { person? }` and `admin.sessions.revoke { id }` (`people.manage`; revoke needs a
  step-up) are the owner's view; CLI `keith-core sessions list [username]` and `sessions revoke <id>`. Audit `credential.revoked` with `by`: `self`, `admin`,
  `logout`, `evicted`. Storage stays hash-only (SHA-256 of the secret).

**PIN** (shipped in P14 step 7; `methods/pin.ts`, `methods/secret-login.ts`). The `pin` adapter has assurance 1 and a single `pin` field (`digits`, masked). The default policy
allows it from `loopback`, `lan` and `tailscale`; it is never offered or accepted from `public`, **even when `KEITH_INSECURE_LOGIN` lifts the rest** (`AuthMethod.neverPublic`). It is not part of
`GET /auth/methods` (the legacy list keeps its three ids byte for byte); only the flow offers it, and `identify` marks the first available of `pin`, `password` as `default`.
`POST /auth/flow/:id { method: 'pin', answer: { pin } }` runs the shared secret check (`createSecretLogin`, also used by the password): the same lookups, dummy verify, audit rows (`auth.login.ok|failed`,
with `method: 'pin'`), writes and uniform `401` as the password, and **the same throttle subject** (one person, one counter: wrong PINs and wrong passwords add up, a success clears both). A new PIN session lasts
12 hours idle and 7 days in all by default (`PIN_IDLE_MS`, `PIN_ABSOLUTE_MS`), has `methods: ['pin']`, assurance 1 and counts toward the cap of 20.
*LAN extras.* On the `lan` zone a person-wide delay applies to every address after failures from any address (`blockedPerson`: the usual `delayMs` schedule capped at 30 s; it uses the person-wide counter, which an unknown subject has too, so a
decoy is delayed alike); the owner is never locked, only delayed, and an audit row `auth.pin.alert` (`personId`, `failures`, address) is written at every 5th person-wide failure of a known person. The plain-HTTP risk of the LAN (a PIN can be sniffed) is
mitigated by the zone, the throttle and the short lifetimes; the TUI shows a warning there (step 10); TLS or Tailscale certificates are a precondition for public exposure.
*Zone detection.* `createLanNets()` is wired in `compose.ts` (subnets of `os.networkInterfaces()`, refreshed each minute); `lan` is decided from the TCP peer only. Verified with injected interface lists; the real peer address on the owner's network (including `::ffff:` mapping on dual-stack sockets) is to be checked by hand.
*A PIN session cannot step up.* `POST /auth/step-up { pin }` on a session whose `methods` contain `pin` and whose assurance is below 2 answers `403 { error: 'pin_session_cannot_step_up', hint }`; `{ password }` is accepted (the network rule still limits where the password may be typed) and with `rotate: true`
raises the assurance to 2 (`methods` gains `password`). A device-code or token session still steps up with its PIN. *Own PIN.* `auth.pin.set { pin }` (any signed-in principal; needs a step-up over TCP, so a PIN session cannot call it; the owner on the socket can) sets the caller's own PIN
and ends their PIN sessions; the owner sets anyone's with `admin.people.setPin` (`keith-core people pin`). Audit `person.secret.set`.

**Actor, flow, assurance** (`Actor` contracts only until a later step maps the principal): `Actor`, `MethodDescriptor`, `Step`, `IdentifyResponse`,
`FlowResult`. Assurance: 0 device code or token, 1 PIN, 2 password. A PIN session (assurance 1) cannot step up.

## Public API

| Export | Contract |
| --- | --- |
| `createCredential(repo, { personId, kind, label })` | Issue a credential; returns `{ id, token }` (shown once) |
| `parseCredential(token)`, `formatCredential(id, secret)`, `hashSecret(secret)` | Format helpers |
| `verifyCredential(repo, token, options?)` | See above |
| `createDeviceLogin({ devices, credentials, audit })` | `start(request, ip, via)`, `poll(request, ip, via)`, `approve({ code, label?, personId, via })`, `deny({ code, actor, via })` |
| `recoverOwner(tokens, credentials)` | Revoke every credential and legacy token of the owner, issue one new `token` credential (label `recover`); returns `{ id, token, revoked }` |
| `createPrincipalResolver(tokens, credentials)` | `resolve(request, via?, ip?)`: the principal of a request, **resolved once** (cached per `Request` object, so thalamus's middleware, the `eharness/http` authorize hook and the oRPC handler share one lookup). `via: 'local'` is the current owner (`tokens.owner()`, so it follows `transfer-owner`; `LOCAL_PRINCIPAL` only when no owner row exists) without a token. Otherwise a `keith_s_` bearer goes to `verifyCredential`, any other bearer to the legacy path |
| `verifyAuthorization(repo, header)` | Legacy: `Authorization: Bearer keith_<b64>` → `Principal` or `undefined` (also `undefined` for a person who is not `active`) |
| `createToken(repo, personId, label)`, `newToken()`, `hashToken(token)` | Legacy token helpers (node tokens are also hashed with `hashToken`) |
| `createAuthRoutes({ secrets, credentials, hasher, audit, proxy, insecure, now? })` | `login(request, peer)`, `stepUp(request, peer, principal)`: the two password routes (`peer` = `{ via, ip, forwarded }`) |
| `createHasher(options?)`, `ARGON2`, `HasherBusyError` | argon2id with the pinned cost and the 2-slot semaphore (`verify(secret, undefined)` runs a dummy) |
| `checkPassword(password, who?)`, `checkPin(pin)` | The rules; return the reason or `undefined` |
| `networkRule(input)`, `createThrottle(repo, now?)`, `delayMs(n)` | The network rule and throttling |
| `zoneOf({ ip, forwarded, headers, proxy, lan? })` | `{ zone, tailscaleUser?, hint? }` (`hint`: `funnel`, `proxy`, `network` for the audit detail). `createLanNets({ interfaces?, now?, ttlMs?, extra? })` caches the on-link subnets of `os.networkInterfaces()` for a minute and skips loopback, Tailscale, public addresses and container or VPN interfaces (`docker*`, `br-*`, `veth*`, `utun*`, `tun*`, `wg*`, ...) |
| `DEFAULT_POLICY`, `ruleFor(policy, method, ctx)`, `allows(policy, method, ctx)` | The policy engine |
| `createAuthRegistry(methods)`, `deviceMethod`, `tokenMethod`, `createPasswordMethod({ secrets, credentials, hasher, throttle, audit })`, `methodDecision(policy, method, input)` | The method registry and adapters; `methodDecision` is `networkRule` for any method |
| `createPolicyStore(settings, warn?)`, `policyProblem(policy, zones)`, `POLICY_SETTING` | The stored policy with the default fallback, and the lockout guard |
| `createPinMethod(options)`, `createSecretLogin(config, options)` | The PIN adapter and the check it shares with the password |
| `createFlowRoutes({...})`, `createLimiter({ limit, windowMs, now? })`, `candidatesOf`, `normalizeEmail`, `normalizePhone` | The identifier-first routes (`identify`, `answer`), the sliding-window limiter and the identifier normalisers; `createAuthRoutes` also returns `identify(request, peer)` and `flow(request, peer, flowId)` |
| `ensureOwner(repo)` | Create person `owner` if missing (idempotent, runs every boot, issues nothing) |

`CredentialsRepo`, `DeviceRequestsRepo`, `AuditRepo`, `TokensRepo` live in `@keith/db`.

## Inputs, outputs, errors

- Missing header, a scheme other than `Bearer`, an unknown, malformed or revoked credential: `undefined`
  (never throws). The caller decides the HTTP status.
- `keith-core token create|list|revoke` (socket, `admin.tokens.*`): create and list `token` credentials;
  `list` also shows legacy tokens (`legacy: true`); `revoke` takes either kind.
- `keith-core token recover` (offline, core stopped) runs `recoverOwner` and records `token.recover`
  (`via: offline`). Everything issued before stops working at once.
- `auth.sessions.list|revoke` and `admin.sessions.list|revoke` (Sessions above). `auth.whoami` (any signed-in principal): `{ personId, name, username, role, via, credentialKind, methods?, assurance?, elevated, capabilities }` (`methods` and `assurance` say how the session was made: a PIN session is `['pin']` and `1`; absent for the implicit owner of the socket; `capabilities` is the role table plus the person's grants plus the role defaults of loaded plugins, sorted (core ids and plugin ids as strings); UIs show sections by it, the server checks each call again; `role` is `owner` or `member`; `username` may be null); `credentialKind` is `device`, `token`, `legacy` or `null` on the socket (a session presented on the socket has its own kind and `via: 'local'`). The TUI derives its front session `front:<personId>` from it.
- `auth.logout` (any signed-in principal): revokes the credential of the call (legacy included) and
  audits it; a no-op on the socket.

## Use by thalamus

`createApp` resolves the principal once per request (middleware, then the cached answer for the
`eharness/http` `authorize` hook of `/sessions/*` and for `/rpc/*`). See `thalamus.md`. The `/rpc` context
carries `{ principal, via, ip, record }` where `record(kind, detail)` writes an audit event for that
principal and listener.

## Node tokens

A paired node gets its own token (`keith_node_…`, 32 random bytes, issued by `POST /nodes/join`,
`nodes.md`) and stored as the same SHA-256 hex (`hashToken`) in the `nodes` table. It opens only
`GET /nodes/ws` and never authorizes `/sessions`, `/rpc` or `/attention`; the owner token never
opens the node socket. Revoking a node scrambles its hash.

## Boot and the socket

Boot prints no token and mints none. The local socket (`<dataDir>/core.sock`, mode 0600 in a 0700 folder; requests carry `env.via = 'local'`)
serves an implicit owner with no token **only** under the opt-in local trust levels `idle-lock` and `full`, **except** while the socket is
locked (next section). Under the default `none` a socket request needs a session like any other (the sections below), and other clients use a
credential from sign-in, a device code or `keith-core token create`. The same-user risk is in `docs/plans/done/P8-setup-and-identity.md`
(section 3): someone holding the owner's OS account can read `~/.keith`; the lock stops casual use at an
unlocked machine, nothing more (ADR-0014 decision 9).

## The local socket: idle-lock and local trust (P14 steps 11 and 12, `modules/auth/local-access.ts`)

Code: `local-access.ts` (state, setting, lock and unlock), `local-activity.ts` (what counts as activity), the
middleware and the two routes in `modules/thalamus/app.ts`, `admin/auth-local.ts`, client `local-lock.ts`.

**State.** In memory: `locked` and the time of the last user action. A core restart starts unlocked (whoever
can start the core owns the machine; the lock is not a disk-at-rest protection). The setting is the key
`auth.local` (`{ idleMinutes, trust: { <personId>: 'none' | 'idle-lock' | 'full' } }`, idle default 15, `0` = never lock by idleness, `1440` at most; an invalid stored value
falls back to the default with one warning).

**When the lock is on.** Only for an owner **who has a PIN**. With no PIN there would be no way to open the lock,
so it is **disabled**: the socket never locks, `POST /auth/local/lock` answers `409 { error: 'no_pin', hint }`,
`keith lock` says to set a PIN first, and `keith-core doctor` warns (`owner PIN`). Nobody is ever locked out of their
own machine. Clearing the PIN while the socket is locked opens it. **Upgrade:** an install whose owner already has a
PIN starts to lock after 15 idle minutes (the default is on); an owner without one sees no change at all. Turn it off
with `keith-core auth local set --idle-minutes 0`.

**Locking.** (1) Idle: judged when a request arrives (no timer): when `now - lastActivity >= idleMinutes` the request
that finds it so locks the socket and is itself refused; audit `auth.lock` (`reason: idle`, `idleMinutes`). (2) `keith lock`
(`POST /auth/local/lock`, the socket only, needs the unlocked socket): `auth.lock` with `reason: manual`.

**While locked** every socket request answers `423 { error: 'locked', code: 'LOCKED', status: 423, message }`, **except**
`GET /health` (so `probeSocket`, `keith-core status` and the setup scripts still see a running core) and
`POST /auth/local/unlock`. TCP is unaffected: the lock is a property of the socket, and a TCP client has its own
credential. `keith-core` commands that run **offline** (`setup`, `token recover`, `auth policy reset`, `db migrate`: the core
is stopped, they open the database directly) never touch the socket and are not affected; the physical access they
need is the gate.

**What counts as activity** (`isUserActivity`): a person at the keyboard, not a client talking to itself. Counts:
`POST`/`PUT`/`DELETE` under `/sessions/` (chat send, continue, abort), `POST /attention/:id/answer`, and every `/rpc/...`
call whose last segment is not a read (`get`, `list`, `whoami`, `describe`, `models`). Does not count: `/health`, the
activity feed (`/activity/*`), `GET /attention`, `GET /sessions/*`, the reads above, the sign-in routes and `/nodes/*`
(node heartbeats arrive over TCP anyway), and everything the core does by itself (scheduler, workers). So a TUI left open
polls for hours without holding the socket open. Known cost: a person who only reads for longer than the idle time is
locked; unlocking takes the PIN.

**Unlocking** `POST /auth/local/unlock { pin }` or `{ password }` (the `StepUpRequest` shape without `rotate`), socket only (`404` on TCP).
It verifies the owner's PIN (or password) with the usual hasher, and uses the same throttle counters as every other sign-in of
that person (address key `local`; the owner is delayed, never locked): `200 { locked: false }`, `401`, `429`
(`Retry-After`), `503`. Audit: `auth.unlock` (`method`, only when it was locked), `auth.unlock.failed` (`method`);
never the secret. Unlocking an unlocked socket with the right secret is a harmless `200`.

**Local trust** (step 12), one level per person, owner-set, stored in `auth.local.trust`. **The default is `none` for everyone** (ADR-0014 amendment of 2026-11-09: every party that talks to Keith is an authenticated User; a visitor at the owner's keyboard is never silently the owner). Settings stored before that amendment that name no level for a person (never set explicitly, for example only `idleMinutes`) therefore mean `none`; an explicit stored `idle-lock` or `full` is respected. Only the
current owner ever arrives on the socket, so only their level has an effect; a transfer of the ownership gives the new owner their
own level (default). The matrix, per level, for an owner who has a PIN and one who has not:

| Level | Implicit owner on the socket | Idle-lock | `keith lock` | Owner without a PIN |
| --- | --- | --- | --- | --- |
| `none` (default) | no: a session credential is needed, like TCP (zone `loopback`, `via: local`) | none (nothing implicit to lock) | `409 not_applicable` | cannot be set (refused: nothing could sign them in); the first-owner flow below gives them one |
| `idle-lock` (opt in) | yes | yes, if the owner has a PIN | yes, if the owner has a PIN | lock off, nothing changes |
| `full` | yes | never | yes, if the owner has a PIN | lock off, nothing changes |

`full` is today's behaviour before P14 and needs an explicit owner action: `keith-core auth local set --trust full` (works with the core running, with a session, or with the core stopped) prints the
warning (anyone at the keyboard of this machine with your account unlocked is the owner: a visitor, a script, any program running as you)
and needs `--yes` (or a typed confirmation); the call carries `acknowledge: true` and the audit row `acknowledged: true`.

**`none`** means the principal resolver does not serve the implicit owner (`localImplicit` is false) and a socket request needs
`Authorization: Bearer keith_s_...` like a TCP one: a script that talked to the socket with no credential gets `401`. A credential presented
on the socket steps up like on TCP (the implicit owner is the only principal that is always stepped up: `stepUpDenial` and
`/auth/step-up` look at `principal.credential`, not at `via`). Setting `none` is refused unless the person has a PIN or a password and
the stored policy still lets the owner sign in with one from `loopback` (the lockout guard, from the one zone the socket is in; `trustNoneProblem` in `admin/auth-local.ts`, shared by the RPC and the offline `keith-core auth local set`, so both refuse the same inputs). The socket itself never reads the policy: the guard protects the TCP sign-in the owner would otherwise be locked out of. Ways to get a
session on the socket: the identifier-first flow through the socket (`POST /auth/identify`, zone `loopback`; the PIN is the default method;
this is what Home's panel does; the session stays in the memory of that `keith` process, never on disk), `keith login --device`, `keith-core token create` (needs a session first),
and the **admin session** below.

**The first-owner flow** (fallback; `keith-core setup` normally gives the owner a PIN and/or password). An owner who has neither cannot
sign in under `none`, so the socket would be a dead end. `GET /auth/local/status` -> `{ needsFirstOwner }` and
`POST /auth/local/first-owner { pin } | { password }` exist **only on the socket** (`404` on TCP) and answer `409 not_available` unless the
current owner has **no PIN and no password**. The physical gate is the socket itself (mode 0600, the OS account that runs the core, the
same gate as the offline `keith-core setup`) plus that window: while it is open the owner has no credential at all, so nobody else was
signed in anyway. A valid secret follows the PIN rule (6 to 12 digits) or the password rules and blocklist; it is hashed and stored like
`people pin`; the call is serialised (two at once: one wins, the other gets `409`) and re-checked after hashing; audit `auth.first_owner`
(`method`, never the secret). It answers `200 { credential }`, a session of the normal PIN lifetime labelled `keith (first owner)`, so
Home signs in at once. After the first credential exists it answers `409` for good (clearing the credential reopens the window; clearing needs a
session). `keith-core doctor` reports `owner sign-in: not set` as a **failure** with the command to run.

**The admin session** (sudo-style, for `keith-core` commands). `POST /auth/local/session { pin | password }` (socket only, `404` on TCP;
`409 implicit_access` when the level is not `none`) verifies the owner's secret with the same throttle (key `local`) and creates a `device`
credential labelled `keith-core (local admin)`, `methods: [pin|password, 'local-admin']`, assurance 1 (PIN) or 2 (password), **5 minutes idle**
(each use slides it), 1 hour at most, and stepped up for 5 minutes (the PIN was just typed at the machine). Audit `auth.login.ok` with
`admin: true`, or `auth.login.failed`. Only a hash is stored on the server. **Nothing is written to disk by the client**: a file that a shared
OS account can read would make the login reusable by whoever reads it, and binding it to a terminal is only client-side hygiene (the server
cannot see a tty). `connectLocal` (`cli/context.ts`, `cli/admin-session.ts`) wraps the socket `fetch`: a `401` (or a step-up refusal after the
window) asks for the PIN (hidden prompt; a script pipes it on stdin after any value the command itself reads), buys a session kept **in the
memory of that process**, and retries the call once; a `423` says to run `keith unlock`. So a command prompts every time, unless the shell
holds a session: `eval "$(keith-core login)"` exports `KEITH_ADMIN_SESSION` (the credential lives only in that shell's environment, never on
disk or on the screen) and `eval "$(keith-core logout)"` revokes it and unsets it. With an implicit owner (`idle-lock`, `full`) the socket
never answers `401`, so nothing is asked. It is listed by `keith-core sessions list` and ended by `sessions revoke`, `auth.logout` or
`keith-core logout`.

**Offline recovery.** Forgot the PIN under `none`? Stop the core: `keith-core auth local reset` removes the stored `auth.local`
(trust back to the default `none`, 15 idle minutes), audit `auth.local.reset` (`via: offline`), like `auth policy reset`. `keith-core people pin`
needs a session, so it cannot be used for this. **A PIN forgotten under `none`** is recovered the same way a stolen machine is: stop the core, run
`keith-core auth local set --trust full --yes` (offline, audited `auth.local.set` with `via: offline`) to get the implicit owner back, then `people pin`
and set `--trust none` again; or `token recover` for a credential.

**Migration note for scripts.** The default is `none` for new and existing installs (2026-11-09). A script that talked to the socket with no
credential now gets `401`: sign in (`keith-core login`), send `Authorization: Bearer <token from keith-core token create>`, pipe the PIN to
the first `keith-core` command, or opt back in on purpose (`keith-core auth local set --trust idle-lock|full`; `full` prints its warning and needs
`--yes`). Under `idle-lock` the socket answers `423` after the idle time when the owner has a PIN: `keith unlock` first, or `--idle-minutes 0`.

**Settings.** `admin.auth.local.get { person? }` -> `{ personId, trust, idleMinutes, hasPin, locked }`; `admin.auth.local.set { person?, trust?, idleMinutes?, acknowledge? }`
(owner only, a member with `settings.manage` is refused; step-up over TCP; the idle minutes are global, the trust level is per person; audit
`auth.local.set` with `personId`, `trust`, `wasTrust`, `idleMinutes`, `wasIdleMinutes`). CLI `keith-core auth local show|set [--trust <level>] [--idle-minutes <n>] [--person <username>] [--yes]|reset`.

## Audit

Table `audit_events` (`id`, `at`, `kind`, `actor` (a person id or `system`), `via` (`local`, `tcp`,
`offline`), `detail` JSON, never secrets), append-only (no update; since P15 step 4 only the retention prune deletes, see below). `createAudit(repo, warn)`
returns a recorder that never throws (a failed write goes to `warn`). Read with `keith-core audit
[--limit N]` (`admin.audit.list`, newest first, limit 1 to 500, default 50). `audit.read` is owner only (ADR-0027 §6; an old grant is ignored and listed by doctor) and every person has `audit.mine` (rows where they are the subject or the resource owner, including `acl.owner-access`). Setup changes are audited with `via: offline`; the declared `acl.create`, `acl.remove` and `acl.deny` kinds are written; the approval row carries node, command and the applied remember scope (ADR-0027 §7).

| Kind | When | Recorded by |
| --- | --- | --- |
| `device.requested` | a device code was issued (`actor: system`; detail: request id, address, label) | device login |
| `device.approved` | the owner approved a code (plus `credential.created`) | `admin.devices.approve` |
| `device.denied` | the owner denied a code | `admin.devices.deny` |
| `device.expired` | a poll found its request expired (`actor: system`) | device login |
| `credential.created` / `credential.revoked` | token or device credential created, revoked (`by`: `admin`, `logout`, `self`, `evicted`, `expiry`; `subject`: the person whose credential it is) | `admin.tokens.*`, `admin.devices.*`, `auth.logout` |
| `token.recover` | offline recovery (`via: offline`, detail: revoked count, new credential id) | `token recover` |
| `settings.unreadable` | a stored provider key could not be opened with the secret key (lost or changed `KEITH_SECRET_KEY`); detail lists the keys, never values | `modules/providers/unreadable.ts` (core and offline admin) |
| `settings.provider.add` | a connection that did not exist was saved (`connection`, `provider`); never the key | `providers.put` (`modules/providers/router.ts`), `keith-core setup` (`via: offline`) |
| `settings.provider.key` | a saved connection got new settings (its key; detail `connection` only, never the key); an edit that sends no settings writes no row | `providers.put` (`modules/providers/router.ts`), `keith-core setup` |
| `settings.provider.test` | a connection was tested (`connection`, `ok`) | `providers.test` (middleware of `platform/rpc.ts`) |
| `settings.provider.remove`, `settings.model.set`, `settings.model.price` (`ref` and the two prices, `null` when cleared), `settings.budget.set`, `settings.access.set`, `settings.budget.cap` | a setting changed over rpc, or by `keith-core setup` with `via: offline`; `budget.cap` names the person id (`person`), not the typed name; provider keys are never recorded | middleware of `platform/rpc.ts`; `setup-steps.ts` (`recordSetup`) |
| `setup.done` | `keith-core setup` marked the setup done (`via: offline`) | `markSetupDone` |
| `node.pair_code` / `node.paired` / `node.revoked` | a pairing code was issued, a node joined (`actor: system`, `via: tcp`), a node was revoked | rpc middleware, `createPairing.onPaired` |
| `auth.login.ok` / `auth.login.failed` | a password login (`actor`: the person, or `system` for an unknown name; detail: `personId` or `usernameHash`, `ip`, `forwarded`, `tailscaleUser`, failure `reason` (`unknown_user`, `no_password`, `wrong_password`, `inactive`, `locked`), `lockedNow`, `credentialId`; never the password or credential) | `POST /auth/login` |
| `auth.step_up.ok` / `auth.step_up.failed` | a step-up (detail: `method`, `credentialId`, `elevatedUntil`) | `POST /auth/step-up` |
| `auth.login.refused` / `auth.step_up.refused` | the network rule said no (`reason`: `funnel`, `proxy`, `network`; `flow: true` from `/auth/flow`) | the routes |
| `auth.policy.set` / `auth.policy.reset` | the sign-in policy was stored over rpc (owner, step-up), or removed offline (`via: offline`; detail: rule, method and CIDR counts, `wasDefault`, `hadStoredPolicy`) | `admin.auth.policy.set`, `auth policy reset` |
| `auth.lock` / `auth.unlock` / `auth.unlock.failed` | the local socket locked (`reason`: `idle` or `manual`; `idleMinutes`), was unlocked, or an unlock was refused (`personId`, `method`; `via: local`; never the secret) | local-access |
| `auth.local.set` / `auth.local.reset` | the trust level or the idle minutes changed (`personId`, `trust`, `wasTrust`, `idleMinutes`, `wasIdleMinutes`, `acknowledged`), or the stored settings were removed offline (`via: offline`) | `admin.auth.local.set`, `auth local reset` |
| `auth.pin.alert` | the person-wide PIN failures reached a multiple of 5 (`personId`, `failures`, address; known person only) | PIN flow |
| `person.alias.add` / `person.alias.remove` | an email or phone alias set or removed (detail: `personId`, `subject`, `kind`; never the value) | `admin.people.alias*` |
| `person.secret.set` / `.cleared` / `.unlock` | a password or PIN set or cleared (`kind`, `sessionsRevoked`), counters cleared (`wasLocked`); never the secret | `admin.people.*` |
| `person.sessions.revoked` | sessions revoked by suspend, role change or transfer (`reason`, `count`) | people service |
| `acl.create` / `acl.share` / `acl.unshare` / `acl.chmod` / `acl.chgrp` / `acl.chown` / `acl.remove` | a resource was created or its access changed (fixed fields only: kind, id, subject, bits, modes, owners; never a title or content) | `acl.*` procedures (`modules/acl/access.ts`), the plugin helper (P16) |
| `acl.group.create` / `.delete` / `.add` / `.remove` | a group or its membership changed (`group`, `name` or `person`) | `admin.groups.*` (`modules/acl/groups.ts`); written only when something changed, so a repeat adds nothing |
| `acl.owner-access` | the instance owner read a resource that the rules alone would not give them: one row per owner session and resource per 10 minutes; a list or search is one row per resource owner with the first 20 ids and the `count` | `createAclAudit(...).ownerAccess` |
| `logs.owner-read` / `logs.purge` / `logs.settings` | the owner read a person's model-call log (`scope`: `list`, `session`, `call` or `raw`; the person as subject; a room session names the room), a purge of rows (`scope`, `person`, `deleted`), or a setting of the log changed (`key`, `from`, `to`). The member sees `logs.owner-read` in `audit.mine` as "the owner read your model-call log", summarised, never the raw detail; the owner's own reads are not written (`activity-logs.md`, "Rights" and "Audit kinds") | `activity-logs` owner path (`modules/audit/activity-logs/rights.ts`), `logs.purge`, `logs.settings.set` |
| `acl.deny` | denied reads, counted: the first of a window per session and kind writes a row, the rest only count; the next row reports `suppressed` | `createAclAudit(...).denied`, `flush` |
| `audit.retention.set` | the owner changed the retention (`from`, `to` days) | `admin.audit.retention.set` |
| `person.resources.moved` | a removed person's resources went to the owner (`personId`, `heirId`, `count`), written in the delete transaction | `people.remove` |
| `person.removed.kept` / `person.removed.purged` | a removal kept the person's data until a date (`person`, `until`); the prune tick or boot purged it (`person`). Hidden from the member view (the person is gone) | `people.remove`, `removed.ts` `purge` |
| `person.login.set` | the owner turned a member's sign-in on or off (`subject`, `person`, `canLogin`); the member sees "the owner turned your sign-in on/off" | `admin.people.setLogin` (`people.md`) |
| `person.exported` | the owner wrote an archive of a person's data (`person`, `removed`, `files`); the member sees "the owner exported your data" | `admin.people.export` (`people.md`, Export) |
| `person.notice.seen` | a person acknowledged the first-login notice (`notice: audit-privacy`, `subject`; once per person, `admin.audit.notice.ack`; never shown to the person in Privacy) | `admin.audit.notice.ack` |
| `audit.pruned` | the retention prune deleted rows (`actor: system`, `via: local` for the running core, `offline` only where a stopped core prunes; `deleted`, `retentionDays`) | `createAuditRetention` |
| `plugin.view.open` / `plugin.view.close` / `plugin.view.throttled` | a plugin terminal view opened or ended (`plugin-views.md`): detail `viewId`; on close also `reason` (`view`, `idle`, `revoked`, `limit`, `error`, `refused`, `disconnected`) and `openMs`; never a frame, a key or a parameter. At most 20 rows per person a minute, then the rows are counted and the next window opens with one `plugin.view.throttled { dropped }`; `via` says `tcp` or `local` | view socket gateway (`modules/plugins/view-audit.ts`) |
| `approval.answered` | an attention item was answered: attention id, session, decision, `remember` as applied (not as asked: a member's `session` is `once`), and for an approval `node`, `capability`, `driver` (the capability's first id segment) and `command` (redacted by `redactString`, capped at 200 characters); no free text | `auditAnswer` (`modules/audit/attention.ts`), read before the answer by `readAnswer`; the trail is `attentionOptions` (`modules/amygdala/attention.ts`) |

**Subject key.** Every `person.*` and `credential.*` row carries `subject`, the person it is about (`person.*` rows also keep `personId`, which the person timeline reads), and every ACL change row carries `resourceOwner` (above). There is no column for it: the member view (`audit.mine`) reads the JSON detail.

**Member view (`admin.audit.mine`, capability `audit.mine`, held by every role).** Returns `MyAuditEvent[]` (`{ id, at, kind, actorName, summary, resource? }`, `packages/contracts/src/audit.ts`), newest first; input `{ limit?: 1..200 (default 50), before?: id, person? }`. `person` is for the owner only (`keith-core audit mine <person>` shows a person their lines; a member who names anyone but themselves gets `FORBIDDEN`). `AuditRepo.listFor(personId, { limit, before, scan })` reads the JSON detail with `json_each` over the fields that `AUDIT_SUBJECT_FIELDS` (contracts) names per kind (plus the old `personId` key): a field holds one person id, or an array of them (`members` of `room.read` and `room.owner-end`, the active members of a room); a kind that is not listed is never returned. One call looks at the newest 5000 rows older than `before` at most (`AUDIT_SCAN_LIMIT`); a short page comes with a cursor and the handler (`listMine`, `modules/audit/mine.ts`) reads on for up to four pages. The line is built in the core: `summary` is English from the kind (`registerMySummary(kind, (detail, viewer) => string | undefined)`, "looked at 3 of your notes", "set your password"), `actorName` is the display name (`Keith` for the system), `resource` is `{ kind, id?, count? }` for ACL rows. There is no `ip`, no `via` and no raw detail: a member sees who did what to what, never network facts about someone else. Every kind in `AUDIT_SUBJECT_FIELDS` has a summary or is hidden (`hideFromMine`: `person.delete`, `person.resources.moved`); a later plan that writes a kind with a subject adds it to the map and registers its summary in its own audit step, and `mine.test.ts` fails when one is missing.

**First-login notice (`admin.audit.notice.get|ack`, any signed-in person).** `get` returns `{ notice: 'audit-privacy', text, seen }`; `ack` stores the settings key `notice.audit-privacy.<personId>` and writes `person.notice.seen` the first time only (a second device or a second `ack` changes nothing). The TUI shows it once after the first sign-in (`tui-login.md`). The key of a removed person stays until P26 removes their data.

**Retention.** The setting `audit.retentionDays` (default 180; 0 keeps everything; an integer 0 to 3650, a corrupt stored value reads as 180, never as
forever) bounds the table. `createAuditRetention({ repo, settings, audit })` (`modules/audit/retention.ts`) has `days()`, `setDays(n)` and `prune()`, which
runs `DELETE ... WHERE at < now - days` (the `at` index) and, when rows went, writes one `audit.pruned` row. Core runs it at boot and with the existing
10 minute prune timer (`compose.ts`), apart from the activity feed prune so one failure does not skip the other. This is the first and only deleting code
path of the audit table, and it applies to every kind, `person.*` events included. The owner reads and changes the days with
`keith-core audit retention [show | set <days>]` (`admin.audit.retention.get|set`, owner only even with `audit.read` or `settings.manage` granted; `set` needs a
step-up over TCP and is audited as `audit.retention.set`, `{ from, to }`). `0` keeps everything: the help says so, because "0 days" could be read as "delete at once".

**ACL rows.** `createAclAudit({ audit, now?, windowMs?, warn? })` (`modules/audit/acl-audit.ts`) validates each detail against `AclAuditDetailSchemas`
(`packages/contracts/src/acl.ts`): a fixed allow-list of fields, unknown keys dropped, a malformed detail recorded as `{ invalid: true }` with a warning. The
dedupe and deny state is in memory and bounded (10 000 keys, oldest first); a restart can write one extra row per window, never fewer. Nothing in core calls
it yet: P15 steps 5 and 6 and the plugin host (P16) do.

When the request carried proxy headers the detail also has `forwarded: true`.

**Offline setup is audited (ADR-0027 §7, F-044).** Every change `keith-core setup` makes, from the line prompts, the flags or the wizard, writes one row with `via: 'offline'` and `actor: system`, the same kinds as the RPC: `settings.provider.add` (a new connection: `connection`, `provider`), `settings.provider.key` (a new key for a saved connection: `connection`, never the key), `settings.model.set` (`role`, `ref`), `settings.budget.set` (`limitUsd`), `settings.access.set` (`mode`, `host`, `publicUrl`), `person.secret.set` (the PIN or password), `setup.owner_signin` and `setup.done`. The probe of a new key (under a temporary id) writes nothing. No row holds a key, a PIN or a password.

## Invariants

- A raw credential or token is never stored or logged except the single print at issue time (a device credential is returned once by the poll).
- A revoked credential or token never authorizes again.
- A node token never authorizes as a client, and a client credential never opens `/nodes/ws`.
- The client address used for rate limits, `last_ip` and audit is the socket peer, never a forwarding header.
- `ensureOwner` runs on every boot and is idempotent; it creates no credential.
- `via: 'local'` is set only by the server code that owns the Unix socket, never from a header.

## Tests

`modules/auth/credentials.test.ts` (format, verify, revoke, `last_seen` throttle, legacy still works, node
token never matches, recover); `modules/auth/tokens.test.ts` (legacy); `modules/auth/device.test.ts` (device
flow end to end over the socket and TCP, single use, deny, expiry, rate limits, 4 KB cap, hashes only,
client helper); `modules/audit/audit.test.ts` (every recorded kind, no secrets, approval answers); `modules/audit/{retention,acl-audit}.test.ts` (prune window and setting, owner-access dedupe, deny counting, allow-listed ACL details);
`modules/auth/{hasher,password-rules,network-rule,network-rule.parity,zone,policy,login,step-up,flow,sessions,pin}.test.ts`, `modules/auth/policy-store.test.ts` (fallback, corrupt value, the guard cases), `modules/auth/policy-admin.e2e.test.ts` (owner only, step-up, audit, effect on the next request, refusal keeps the stored policy), `cli/auth-commands.test.ts` (`auth policy show|set|reset`, reset from a locking policy, help), `modules/auth/local-lock.e2e.test.ts` (the lock over the real socket: 423, `/health`, unlock, audit, the routes absent on TCP), `modules/auth/local-trust.test.ts` (the policy table: each trust level x PIN set or not x idle or locked first; the admin session with a fake clock, assurance, step-up, expiry, audit without secrets), `modules/auth/local-trust.e2e.test.ts` (none over the real socket: 401, refusal without a PIN, the PIN buys a session, `full` needs the acknowledgement, logout ends it) and `modules/auth/pin.e2e.test.ts` (PIN session assurance and lifetimes, LAN and Tailscale zones with injected subnets, never public even with the insecure flag, shared throttle, equal work for a decoy, the person-wide delay and alert, PIN session step-up refusal, PIN change ends PIN sessions, `auth.pin.set` over a listener), `modules/auth/sessions.e2e.test.ts` (list and revoke over a listener, step-up for another session, rotation over HTTP; lifetimes, grace, cap and hash-only storage with a fake clock in `sessions.test.ts`) and `login.e2e.test.ts` (pinned argon2 cost, concurrency cap, rules and blocklist, uniform failures, throttling, lock and unlock, persistence across a reopen, network matrix over HTTP, step-up window with a fake clock); `modules/people/secrets.test.ts` (CLI, step-up over TCP, revocation); `modules/thalamus/principal.test.ts` (one lookup per request); `cli/auth-commands.test.ts`;
`packages/db/src/repos/repos.test.ts`; `apps/core/src/e2e.test.ts` (401 without a token, `/health` open).
