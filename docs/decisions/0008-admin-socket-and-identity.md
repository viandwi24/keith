# 0008. Admin socket, credentials and device login

Status: Accepted (2026-10-28). Amended by ADR-0014 (amendment 2026-11-09: the local socket is not an implicit owner by default), ADR-0022 (delegation never reaches the owner)

## Context

P8 moves setup out of the chat client and into core (`docs/plans/done/P8-setup-and-identity.md`).
Until now the owner token was printed once at first boot and pasted into the TUI, settings were TUI
commands, and anything that reached the TCP port could try the pairing and token routes under any
`Host`. We need an admin channel that needs no password, a login for other devices, a defence against
DNS rebinding, and a record of security events, without a new dependency and without painting P9
(people, roles, passwords) into a corner. An independent review of the first draft found that
password routes are unsafe behind a local proxy, that a loopback-only Host check breaks
`tailscale serve`, that a hard owner lockout is a denial of service, and that the same OS user can
reach any socket.

## Decision

- **The local socket is the owner.** Core serves the same app on `<dataDir>/core.sock` (0600 in a
  0700 folder, `Bun.serve({ unix })`). A request there is the owner, already stepped up, with no
  credential (`via: local`). It is set only by the code that owns that listener, never from a header.
  The admin CLI uses it through the typed client, so there is one code path and in-memory state stays
  correct. Same-user risk is accepted and documented in SECURITY.md (core shell off by default, minimal
  env for Keith-started shells, a separate OS user for a node on the core machine, every socket
  mutation audited).
- **Offline versus online admin.** `setup`, `db migrate` and `token recover` run with core stopped, in
  process, under `core.lock`, and refuse while the socket answers. Everything else runs online and
  refuses when it does not. `token recover` is the recovery path and needs no password: the machine is
  the root of trust.
- **One credential format.** `keith_s_<id>_<secret>` (`device` and `token` kinds): 256-bit secret
  stored as SHA-256, lookup by id, constant-time compare, `last_seen` at most once a minute. Legacy
  `keith_<b64>` tokens keep working through a strict legacy parser over `client_tokens` (no data
  conversion, plain generated DDL); node tokens (`keith_node_…`) match neither. The principal is
  resolved once per request. Credentials are opaque and revocable, not JWTs.
- **Device login** for other devices: the client asks core for a code (`POST /auth/device/start`),
  shows it and polls (`/auth/device/poll`); the owner approves with `devices approve <code>`. Codes
  use the `eharness/identity` rules (8 characters, no look-alikes, hashed, 10 minutes, single use,
  per-address failure guard) plus at most 5 pending per address. The credential secret derives from
  the poll secret, so core never stores a plaintext credential while it waits. The poll answers once,
  then the request is consumed. The owner may approve over the socket or from an owner session.
- **Host allowlist and proxies.** Every TCP request, including the `/nodes/ws` upgrade, is checked
  before routing: `localhost`, `127.0.0.1`, `[::1]` (with core's port), the public URL's host (any
  port, so a proxy works) and `KEITH_ALLOWED_HOSTS`; a bad `Host` is 421, a bad `Origin` is 403. Core
  trusts no proxy: forwarding headers mark a request remote (never local; only the socket is local),
  `X-Forwarded-For` is never a client address, and `access --proxy tailscale-serve` only records the
  setting P9 will use.
- **Audit.** An append-only `audit_events` table in the `PersonEvent` shape (`kind`, `actor`, `via`,
  `detail`, `at`) records device and credential events, `token recover`, settings changes (an rpc
  middleware, so a new setting is one table line), node pairing and revoking, and approvals answered.
  Recording never throws and never stores secrets. Nothing is pruned in P8.
- **Direction for P9.** `eharness/identity` (Draft in 0.9.0) is the model: `Person`, `PersonAccount`,
  `PersonEvent`, pairing codes and guard. P9 adds people, roles and capabilities on the same
  credential table (`person_id` is already a foreign key), a `PersonStore` adapter in packages/db, and
  step-up for sensitive actions; `audit_events` becomes the `PersonEvent` sink. Nothing here needs to
  change shape for that.

## Consequences

- The owner never types a password on the core machine, and a lost token is recovered offline.
- A second device needs a human on the core machine (or an owner session) to approve it. Phones need
  the web UI, which does not exist yet.
- Anyone who can open the socket is the owner: the threat is a process of the same OS user, not the
  network.
- A client that reaches core by an unlisted name (a LAN IP) is refused until the name is in
  `KEITH_ALLOWED_HOSTS` or the public URL.
- Behind a proxy all clients share the proxy's address for rate limits and `last_ip` until P9 decides
  how far to trust `Tailscale-User-*`.
- Settings changed by `keith-core setup` (offline) are not audited; revisit if setup becomes
  multi-person.
  Superseded: offline setup is audited now (ADR-0027 §7, F-044; `docs/specs/auth.md`, one row per change with `via: 'offline'`).
- Revisit when `eharness/identity` leaves Draft or when P9 starts.

## P9 outcome

The direction above held: people, roles, capabilities, step-up and isolation landed on the same credential
table and `audit_events`, without changing the shapes here. The decisions are in
[0009](0009-people-roles-and-step-up.md).
