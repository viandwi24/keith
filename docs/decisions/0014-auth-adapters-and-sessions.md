# 0014. Authentication adapters, policy as data and real sessions

Status: Accepted (2026-11-08). Narrows ADR-0008 (the local socket is no longer an implicit owner, in two phases) and replaces
the single network rule of ADR-0009 by a policy engine whose default reproduces it. Plan: docs/plans/done/P14-auth-adapters-and-login-panel.md. Amended by ADR-0027 §3 (migrations may run at start, after a backup).

## Context

Keith is a personal assistant for one owner; the other people are the owner's friends. Today (verified in the code):

- Three login methods are hard-coded in four places: the core routes, `AuthMethodIdSchema` (`packages/contracts/src/login.ts`),
  the `createSignIn` state machine (`packages/client/src/sign-in.ts`) and one TUI component per step. A fourth method (TOTP) touches all four.
- One network rule (`apps/core/src/modules/auth/network-rule.ts`) decides where a password may be typed. It has no LAN zone: a LAN peer
  is refused with `network`. There is no per-method, per-role or per-person policy.
- A PIN cannot start a session. It only confirms `POST /auth/step-up` (docs/specs/auth.md, "Password, PIN and step-up").
- A credential (`credentials` table) never expires, cannot be listed by its owner and is not rotated on step-up.
- The local Unix socket resolves to the current owner with no credential and `elevated: true` (`principal.ts`, `localOwner`).
  Anyone at the owner's unlocked machine is the owner.
- The login screen asks for the method first and the identity second, so it cannot adapt to who is signing in.

## Decision

1. **Identifier first.** One input accepts a user id, a username, an email or a phone number (never the display name: it is not
   unique and is guessable). The core answers which methods that identity may use from this client's zone; only then does the UI show a method.
2. **No enumeration.** An unknown identifier gets a decoy flow of the same shape, the same work and the same limits. The method list
   depends on the zone and on global policy only; person- and role-level narrowing is applied at verify and fails with the same uniform error.
3. **Methods are adapters.** `AuthMethod` (begin, verify, enrol, revoke) in a registry (ADR-0007). A schema-driven flow (`POST /auth/identify`,
   `POST /auth/flow/:id`) describes each step as data (fields, kinds, masking); the TUI renders the description and has no code per method.
   First methods: PIN, password (reached by username, email or phone alias). TOTP is designed for, not built.
4. **Policy is data.** Per method: zones (`loopback`, `lan`, `tailscale`, `public`), CIDRs, roles, rate limits and the required assurance.
   It is evaluated when listing and again at verify. The default policy reproduces today's rule exactly, plus PIN from `loopback`, `lan` and `tailscale`.
5. **Zone from the TCP peer.** `lan` means a private peer that lies inside a subnet of one of the core's own interfaces. Never from a forwarding
   header or a client claim. A loopback peer carrying forwarding or Funnel headers is `public` (as today), except `access.proxy = tailscale-serve`.
6. **Assurance and step-up.** A session records the methods that made it and an assurance level. A PIN session cannot step up; dangerous actions
   need a password (or TOTP later). A PIN still confirms step-up on a session created by device code or token, as today.
7. **Sessions.** The `credentials` row becomes a session: idle and absolute expiry, rotation on step-up, list and revoke by the person, hash-only
   storage, a `guest` variant (ADR-0017). Existing rows are grandfathered with a lazily applied cap.
8. **Who edits what.** A user edits only their own PIN and password (TOTP when it exists); the owner may set them for anyone. Users, groups,
   policy and settings are owner-only. Email and phone are admin-set aliases: no mail, no SMS, no self-registration, no "verified" claim.
9. **The socket.** Phase 1: the owner idle-lock (PIN after idle, `keith lock`). Phase 2: the socket needs a session like any other, with a
   per-person `local trust` knob. Honest limit: someone holding the owner's OS account can read `~/.keith`; the goal is to stop casual use at an unlocked machine.
10. **Lockout and plain HTTP.** A policy that would leave the owner with no reachable method is refused when set; an offline command resets it.
    LAN is plain HTTP: the PIN panel shows a warning there, and TLS (or Tailscale certificates) is a precondition for any public exposure.
11. **People and users.** A Person is a directory entry; a User is a Person that may log in (`can_login`, additive, default 1 for existing rows).
    Everyone who talks to Keith is a User or, only if enabled (ADR-0017), an anonymous Guest. The owner is root: may see everything, and every
    access to a member's private data is audited and documented for members (ADR-0015).

## Consequences

- Adding a method is one adapter file plus policy data. Contracts, client and TUI do not change.
- The LAN stops being hostile for the PIN only; the password keeps today's zones. The PIN's strength comes from the zone, the throttle and argon2, not from entropy.
- Policy tampering is an owner action with step-up and an audit row.
- Old cores and clients keep working: the client falls back to the three fixed methods when `POST /auth/identify` is absent; `/auth/login` stays.
- Migrations are additive and run only through `bun run db:migrate`; the plan requires a backup and a dry run on a copy of the real database.
- Residual leaks, accepted and documented: timing under heavy load, and a role-specific restriction is visible only after a failed verify, never in the list.
- Revisit when mail or SMS exists (verification, recovery), when a web UI needs a login (reuse the controller, not the screen), or when TOTP lands.

## Amendment 2026-11-09: the socket is not an implicit owner by default

Status: Accepted. Changes decision 9 and the "Consequences" about `local trust`. Owner feedback: `keith` landed signed in with no login; a
visitor ("Duta") at the owner's machine (same macOS account, same keyboard) must not be treated as the owner ("Vian"), and several people use
one machine. The requirement from the start: every party that talks to Keith is an authenticated User (or an enabled Guest).

1. **The default `local trust` is `none` for every install**, new and existing. A stored setting that names no level for a person (never set
   explicitly, for example only `idleMinutes`) now means `none`; an explicit stored `idle-lock` or `full` is respected. There is no data
   migration: the default is applied where the level is read. `idle-lock` and `full` stay selectable (`full` keeps its warning and `--yes`).
2. **Lockout safety.** An owner needs a way to sign in. `keith-core setup` now requires a PIN and/or a password (wizard, prompts and
   `--owner-pin-stdin`/`--owner-password-stdin`), `start` and the `bun run start/dev` path offer or print the fix when the owner has none, and
   `doctor` fails (`owner sign-in`). For a set-up install that still has none, the fallback is the first-owner flow: `GET /auth/local/status` and
   `POST /auth/local/first-owner` exist only on the socket, only while the owner has neither a PIN nor a password, once (serialised, re-checked after
   hashing), audited (`auth.first_owner`, no secret). The physical gate is the OS account that owns the 0600 socket, the same gate as the offline
   setup. The offline recovery stays and grows: `auth local reset`, `auth policy reset`, `token recover`, and `auth local set` with the core stopped
   (a forgotten PIN under `none`: `--trust full --yes`, then a new PIN, then back to `none`).
3. **Sessions are per process.** The TUI keeps its socket session in memory only; `socket-session.json` is gone (a leftover is deleted, never
   read). Closing the TUI, ctrl+c or `/logout` ends it and the next `keith` asks again; only the identifier is remembered. `/logout` then the panel
   is the switch-user path, and Home says who signed in.
4. **The admin CLI** (`keith-core ...` over the socket) keeps its session in the memory of the process (prompts each command) or, on request, in
   `KEITH_ADMIN_SESSION` of one shell (`eval "$(keith-core login)"`, `logout`), 5 idle minutes, 1 hour at most. The 15-minute `admin-session` file
   is removed. A terminal binding was considered and rejected: the server cannot see a tty, so a file binding would be client-side hygiene while the
   bearer stays reusable by anyone who can read the file.
5. **Honest limit, unchanged in kind.** Someone holding the owner's OS account can still read `~/.keith` (the database, the socket) and attach to a
   running process; this amendment removes the casual cases (an unlocked machine, a shared account reading a saved login), not that.
   `client.json` (a login to a core, including one made with `keith login` against the local TCP address) still stores its token on disk, 0600.

## Amendment 2026-11-09 (second): a stored login is not a silent sign-in

Status: Accepted. Extends the amendment above. Owner feedback: after `local trust` became `none`, `keith` still opened as the owner because
`client.json` held a long-lived login from an old `keith login`; on a machine shared through one OS account the next person who ran `keith` became whoever's
credential was stored. Every talker signs in.

1. The interactive app (a terminal) uses a login saved in `client.json` only when the person chose **remember this device** (`remember: true` in the file).
   That sign-in is an opt-in toggle in the login panel (default off, with the cost said plainly) and gets a **30 days idle, 180 days absolute** session
   (`FlowAnswer.remember`, `REMEMBER_IDLE_MS`). Everything else stays in the memory of the process (`session-vault.ts`).
2. Logins saved before this change (any `device`, `token` or `legacy` credential without the mark) are not used by the app: it shows the sign-in with a
   notice and one action to forget it (revoke, then delete). They are not deleted at start, and commands and scripts (`keith whoami`, `keith logout`,
   `keith-node`, piped runs) keep using them, because a remote device or a script may depend on one.
3. Order for the app: `--core` (a token only from a remembered login of that core), a remembered `client.json`, the local socket (a session under trust
   `none`), then the Sign in screen on the default address. `/logout` revokes and removes what it signed in with.
4. Honest limit, as before: whoever holds the OS account can read `client.json` of a remembered device; remembering is the person's explicit choice.
