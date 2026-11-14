# Security

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on `viandwi24/keith`
(Security → Report a vulnerability), or email the maintainer listed on the GitHub profile.
Expect a reply within 7 days.

## If a secret leaks

1. Revoke or rotate the key at the provider first. The repository is public: a key pushed to it is
   compromised, even if the commit is removed later, because forks and clones keep copies.
2. Then remove it from history (`git filter-repo`) and force-push only after the key is dead.
3. Add a rule or allowlist fix to `.gitleaks.toml` if the scanner missed it.

Secrets are blocked in three places: the `pre-commit` hook (gitleaks), the `secrets` CI job, and
GitHub secret scanning with push protection, when it is enabled for the repository.

## Logging in and the local socket

- **The socket is not an implicit owner by default.** Core serves a Unix socket (`<dataDir>/core.sock`,
  mode 0600 in a 0700 folder). With the default local trust `none` (ADR-0014, amendment of 2026-11-09)
  a request there needs a session like any TCP request (the owner's PIN or password, `keith-core login`,
  a token); only an owner who opts in to `idle-lock` or `full` (`keith-core auth local set`) gets an
  implicit owner there, already stepped up (`docs/specs/auth.md`). Same-user risk: any process of the same
  OS user can open the socket, and under `idle-lock` or `full` that is the owner; under `none` it can
  still try to sign in (throttled) and can read `~/.keith`. This includes a shell Keith starts on a node
  that runs on the core machine. Mitigations: the core shell is off by default, Keith-started shells get a minimal env without
  the socket path, run a node on the core machine as a separate OS user, and every mutation made over
  the socket is audited as `via: local` (`keith-core audit`).
- **Credentials** are `keith_s_<id>_<secret>` with a 256-bit secret, stored as SHA-256 and compared in
  constant time. `keith-core token recover` (offline) revokes all of them and the legacy tokens.
- **Device codes** are 8 characters from a 31-letter alphabet, valid 10 minutes, single use, stored
  hashed, at most 5 waiting per address and rate limited per address. A code alone gives nothing: the
  owner has to approve it, so the risk is being talked into approving a code you did not request. Approve
  only a code that is on your own screen, and read the label and address in `keith-core devices list`.
  Core is plain HTTP until you put TLS in front: a code and a credential cross the network in clear on a
  bare LAN, so use Tailscale (or another encrypted path) for remote devices.
- **Passwords and PINs.** A person can sign in with a username and password (`POST /auth/login`) and
  confirm sensitive work with a PIN or the password (`POST /auth/step-up`). Both are hashed with argon2id
  (`memoryCost: 65536` KiB = 64 MiB, `timeCost: 2`), at most 2 hashes at a time (the rest queue 5 s, then
  a uniform 503), and never leave the core. A password is 15 to 256 characters with no composition rules,
  not on a small blocklist, and may not contain the username or name; a PIN is 6 to 12 digits and starts only a weaker session (assurance 1, 12 hours idle, from loopback, lan
  or Tailscale), which cannot step up with its own PIN (ADR-0014, `docs/specs/auth.md`). Core answers every login failure the same way (401 `invalid_credentials`, with a dummy
  hash for unknown users), so it does not reveal which usernames exist.
- **Where passwords are accepted.** Only on loopback (no proxy headers), from a Tailscale address
  (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or through `tailscale serve` when `access.proxy` is
  `tailscale-serve`. Funnel (public), other proxies and public addresses get `403 login_not_allowed_here`.
  `KEITH_INSECURE_LOGIN=true` removes the rule: set it only behind your own TLS proxy, because core itself
  is plain HTTP and a password crosses the network in clear on a bare LAN or the internet.
- **Throttling.** Failures are counted per (account, address) and persist across restarts: the first 4
  are free, then 1 s doubling to 5 minutes (HTTP 429, `Retry-After`). A member is locked after 20 failures
  until `keith-core people unlock`; the owner is never locked out, only delayed (the socket is the
  recovery). Behind `tailscale serve` every caller shares the loopback address, so one noisy tailnet
  user can delay logins to an account for everyone.
- **Step-up.** A session is stepped up for a fixed 10 minutes after a PIN or password check; using it does
  not extend it. Changing a password or PIN over TCP needs it. The implicit owner of the socket (opt-in
  local trust) is always stepped up; a session on the socket steps up like on TCP. Suspending a person,
  transferring ownership and changing a password revoke that person's sessions.
- **Capabilities.** Every API call needs a named capability (`docs/specs/permissions.md`). The owner has
  all of them; a member can chat, see their own tasks, nodes, model names and the budget, and answer the
  approvals of their own sessions. More can be granted one at a time with `keith-core people grant`.
  Sensitive calls (settings, people, tokens, devices, pairing or revoking nodes, the budget limit) also
  need a step-up from any remote client, and so does approving a `shell.exec`; the implicit owner of
  the socket (opt-in) is always stepped up. A legacy token can never step up: replace it with `keith-core token create`.
- **Members and shell commands.** A member's `shell.exec` is never answered by the member: it is an
  approval the owner sees, with who asked, the machine and the command. This is a deliberate exception to
  the owner not seeing members' messages. The owner's answer never grants the member "remember for this
  session", so every command is asked.
- **Host allowlist.** Core refuses a `Host` that is not `localhost`, `127.0.0.1`, `[::1]` (with core's
  port), the public URL's host or a `KEITH_ALLOWED_HOSTS` entry, and an `Origin` that is not allowed, on
  every TCP route including `/nodes/ws`. That blocks DNS rebinding and a browser page that points at your
  core. A node or client that reaches core by another name (a LAN IP) needs that name in
  `KEITH_ALLOWED_HOSTS`.
- **Proxies.** Core trusts no proxy. A request with `Forwarded`, `X-Forwarded-*` or `Tailscale-User-*` is
  remote and needs a credential; `X-Forwarded-For` is never used as a client address, so a proxy hides
  the real address from rate limits and `last_ip` (they see the proxy). Only the socket is local.

## People and login: P9 residual risks

Accepted after P9 (`docs/plans/active/P9-people-and-login.md`, `docs/decisions/0009-people-roles-and-step-up.md`).

- **`tailscale serve` shares one address.** Behind it every tailnet caller looks like loopback, so login
  throttling (per account and address) cannot tell people apart: one noisy user delays logins to an
  account for everyone. `Tailscale-User-Login` is logged, not trusted.
- **Same-user socket.** Under the opt-in local trust levels `idle-lock` and `full`, any process of the OS
  user that runs core is the owner, already stepped up, with no PIN (idle-lock only locks an owner who
  has a PIN, after 15 idle minutes). Under the default `none` it needs a session, but the same OS user can
  still read `~/.keith`. Step-up protects remote sessions, not this. A member's shell goes to a node, never to core,
  unless `KEITH_CORE_ALLOW_SHELL=true`.
- **Legacy tokens cannot step up.** A pre-credentials `keith_<b64>` token works for ordinary calls but
  every sensitive call (and approving a shell command) refuses it; replace it with `token create`.
- **PIN entropy.** A 6 to 12 digit PIN has at most 10^6 to 10^12 values. It is safe only because of
  throttling (the same counters as the password), the 10-minute fixed window and argon2id; a stolen
  database with the hashes would let an attacker crack a short PIN offline. Use 8+ digits for the owner.
- **Plain HTTP passwords.** Core has no TLS. Loopback and Tailscale are the only default paths; with
  `KEITH_INSECURE_LOGIN=true` a password crosses the network in clear.
- **A member's shell request shows the owner their command.** The owner sees who asked, the machine and
  the command; the member's other messages stay private.
- **Idle lock and guests are opt-in.** The socket idle lock exists (local trust `idle-lock`, `docs/specs/auth.md`)
  and guest mode exists and is off by default (`docs/specs/guests.md`, ADR-0017). Sessions are revocable
  and audited.
- **Removed people's data stays on disk for 30 days.** Memory, workspace, conversations, and their tasks and
  reviews (`data.json`) move to `workspace/keith/removed/<personId>/`, and the rows that named them are deleted;
  nothing routes to it, but an operator can read it. It is purged 30 days later (ADR-0027 §26, `people.md`).
- **Ended rows are deleted on a schedule.** Revoked, rotated or expired sign-ins and client tokens go 90 days after they
  ended; finished tasks 90 days; dead inbox letters 30 days; closed budget reservations 7 days after their expiry. Each
  deletion is audited as a count (`data.pruned`), never with an id or text. The table in `docs/specs/db.md` ("Retention")
  lists every table and its number.

## Audit

- **Who reads the log.** `audit.read` (the whole log: `keith-core audit`, Home menu > System > Audit) is held by the owner only. A grant of it to a
  member is refused, and an older grant is ignored (`doctor` lists it). Every person holds `audit.mine` and reads only the lines where they are the subject
  or the owner of the thing, including the owner's looks at their things (`docs/sharing-and-privacy.md`).
- **Setup changes are audited.** Every change `keith-core setup` makes offline is written with `via: offline`, and no row holds a key, a PIN or a password.
- **Access changes name the owner.** Share, unshare, chmod, chgrp and chown rows carry `resourceOwner`, so the member whose thing it is can see them.

## Nodes

- Node connections have no TLS in the MVP: use them only on localhost or a private network (for
  example Tailscale).
- Pairing codes are single-use, last 10 minutes and are rate-limited.
- Node tokens are stored hashed on the core, and `~/.keith/node.json` is mode 0600.
- Revoke a lost machine with `keith-core nodes revoke <name>`.
- `shell.exec` always asks the owner, and a node refuses shell unless it was joined with
  `--allow-shell`.
- The core's own shell is off unless `KEITH_CORE_ALLOW_SHELL=true`.
- Node tokens rotate: a token older than 30 days is replaced at the node's next connection, and the
  old one stops working once the node uses the new one (ADR-0027 §28). Node messages are rate
  limited per node (200 per 10 seconds, `docs/specs/nodes.md` "Limits").

## Succession (P29)

Threat model of the owner-absence protocol (`docs/specs/succession.md`, ADR-0022):

- A delegate (a member with `people.manage`) cannot take ownership. Naming the heir is `succession.manage`, owner only, and a delegate who is not the heir has no claim (ADR-0022, "delegation is not succession").
- Only the heir the owner named in advance can take ownership, and only through the full ladder: the daily check-ins over the window, the 7-day grace and the claimable state. Nothing else moves ownership.
- The claim needs the heir's own password or PIN and a fresh step-up. The local socket is refused: it carries the implicit owner, so a claim never runs there without a credential.
- The owner's last sign is re-read inside the claim transaction. A sign after the run started wins, and the claim is refused.
- After a claim the previous owner is suspended and their sessions are revoked. Their password and PIN hashes, credentials and other secrets never appear in any output (`apps/core/src/succession-secrecy.e2e.test.ts`).
- `owner-absence` cannot be switched off, paused, edited or deleted through the protocol procedures, which refuse it with `use keith-core succession`. A pre-approved `act` rule is a separate mechanism and never changes ownership.

## Known risks (MVP)

Accepted after the P6 review (26 Oct 2026, `docs/plans/done/P6-ready-to-test.md`). Fixed findings are
listed there; these remain by choice.

- **No TLS.** Bind the core to `127.0.0.1` (the default) or a Tailscale address with `KEITH_HOST`.
  Never expose port 7420 to the internet.
- **Dev key next to the data.** Without `KEITH_SECRET_KEY` the core seals provider keys with
  `data/secret.key`. A copy of `data/` then carries both the vault and its key. Set
  `KEITH_SECRET_KEY` (for example from the macOS Keychain) for anything beyond a trial.
- **Backups hold everything.** `keith-core backup` writes a tar (mode 0600) with the database, `secret.key` when it is a
  file, the workspaces and the memory. It is not encrypted (not planned, ADR-0027 §29), so it is as sensitive as the data
  folder: keep copies off the machine only where you would keep `data/`. An archive made with `KEITH_SECRET_KEY` does not
  carry the key; keep the key with it (`docs/specs/backup.md`).
- **Pairing guesses** are limited per client IP only (5 failures per hour). With 31^8 codes, at
  most 3 active codes and a 10-minute lifetime, guessing is still infeasible.
- **A paired node is trusted for what it reports.** Its `os`/`arch`/`version` strings and its
  command output reach the model, so a malicious node can try to steer it. Every shell command
  still needs the owner's approval, and nodes send at most 4 MB per message and 200 messages per 10 seconds.
- **The core's own shell** (off by default) is confined like a node: the cwd must resolve (realpath)
  inside the workdir, and the environment is only `PATH`, `HOME` and `LANG` (ADR-0027 §12). It is not
  sandboxed, though: an approved command can still read `data/` and `~/.keith/` by absolute path.
- **Stored provider keys** are shown to the owner as the last 4 characters.
- **`/health`** is open and returns the version, build sha and boot id.
- **Local config files** (`~/.keith/client.json`, `node.json`) are written 0600 but not
  re-checked when read.
- **Dependencies**: `bun audit` reports a moderate esbuild advisory through `drizzle-kit`. It
  affects only the esbuild dev server, which Keith does not run.
