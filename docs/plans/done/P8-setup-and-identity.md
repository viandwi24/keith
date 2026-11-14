# P8 — Setup and identity

Oct 28, 2026 · status: **P8 done Oct 28, 2026; P9 moved to its own plan** · follows P7 · ADR to write: 0008

This plan covers two milestones: **P8 Setup in core** (built first) and **P9 People and login**
(designed here so P8 does not paint us into a corner; it gets its own go-ahead after P8's gate).

## Why

Two things confuse a first-time user today:

1. **Settings live in the chat client.** Providers, API keys, models, budget and node pairing are
   TUI commands, so you need a working login before Keith is even configured.
2. **The owner token.** It is printed once at first boot and must be pasted into the TUI. There is
   no other way in, and only one person can exist.

The vision is a fictional personal assistant: one owner, other people Keith knows and talks to, and serious actions that
need the owner's say-so. These plans build that without making the single-user case harder.

## Principles

- **A few questions, once, then it just works on one machine.** Everything else is progressive.
- **One Person model.** Identity, role, grants, accounts and credentials hang off a person.
  Single-user mode is "only the owner exists".
- **The machine that runs core is the root of trust.** A local socket stands for the owner (the
  docker.sock / tailscaled pattern); recovery never needs a password.
- **Every login ends in the same session credential**, sent on every request.
- **Sensitive actions need a fresh confirmation (step-up)**, not a separate admin account.
- **Every security event is audited.**
- **No new dependencies.** Bun built-ins, verified on Bun 1.4.2: `Bun.password` (argon2id, default
  m=64 MiB t=2, ~80 ms), `node:crypto` `timingSafeEqual`, `node:util` `parseArgs`, `node:readline`,
  `Bun.serve({ unix })` and `fetch(url, { unix })`. eharness 0.9.0 ships `eharness/identity`
  (Draft): we build on it.

## Research behind it

| Source | Take | Avoid |
| --- | --- | --- |
| A home-automation system (auth providers, onboarding) | Owner created by a wizard; long-lived tokens shown once; person ↔ user | `trusted_networks` (anyone on the LAN picks a user); a config typo that locks you out |
| Jellyfin (users, Quick Connect) | Approve a new device with a short code from a signed-in place; per-user failure limits | — |
| GitHub sudo mode | Step-up before token, people and settings changes | A 2 h sliding window |
| Tailscale, Docker, Caddy admin channels | A local Unix socket whose file mode is the authorization | Caddy's open loopback HTTP admin API |
| OWASP Password Storage, Authentication, Session Management | Argon2id; throttling per account and IP; identical answers for unknown user / wrong password / locked; ≥128-bit opaque tokens stored hashed; rotate on privilege change | JWTs (revocation is hard) |
| NIST SP 800-63B-4 | Passwords min 15 as single factor, accept ≥64, no composition rules, blocklist, paste allowed | A 100-failure cap for a PIN |
| DNS rebinding write-ups from other agent projects | Host allowlist on every listener, including WebSocket upgrades | Origin checks alone |
| clig.dev, `gh auth login`, `tailscale up` | Every prompt has a flag; TTY detection; secrets via stdin; idempotent re-runs; next steps printed; `doctor` | Two live sources of truth (Open WebUI's env-vs-DB trap) |
| `eharness/identity` (spec 30) | `Person` (stable id, status, role), `PersonAccount(platform, nativeId)` for channels, `PersonEvent` audit, pairing codes and guard | Usernames or display names as keys |

An independent review of draft v1 found: password routes are unsafe behind a local proxy, a
loopback-only Host check breaks `tailscale serve`, a hard owner lockout is a denial of service, the
same OS user can reach the socket from Keith's own shell, containers could not bootstrap, and the
`tool.approve` hook has no principal. v2 fixes each one below.

---

## P8 — Setup in core

### 1. Three commands

| Command | Package | Runs on | Subcommands |
| --- | --- | --- | --- |
| `keith-core` | apps/core | the core machine | `setup`, `start`, `status`, `doctor`, `access`, `provider`, `model`, `budget`, `pair`, `nodes`, `devices`, `token`, `config` |
| `keith-node` | apps/node | each node machine | `setup`, `join`, `run`, `status` |
| `keith` | apps/tui | any client machine | (chat), `login`, `logout`, `whoami` |

Separate binaries because core and nodes usually live on different machines (like `tailscale` and
`tailscaled`). Each is a `bin` entry with a `#!/usr/bin/env bun` shebang. Shared CLI pieces (text,
hidden, select and confirm prompts; a command registry that renders `--help` and suggests on typos;
TTY detection) go in a new `packages/cli`, scaffolded with `bun init`.

**Install.** P8 installs from a checkout: `bun install`, then `bun run link` registers the three
commands with `bun link` so they are on PATH. A client-only machine still needs the checkout. Single
binaries (`bun build --compile`, one per command) are a later release task and the docs say so.

### 2. Setup lives in core

`keith-core setup` is a short, re-runnable wizard. Re-running shows current values as defaults and
never clobbers silently.

1. **Your name** → the owner person (id `owner`, display name editable).
2. **AI provider** → OpenRouter / OpenAI / DeepSeek / skip. Key read hidden; keys already in env are
   detected and offered. Tested before it is saved.
3. **Models** → front and cortex, from the provider's list, a cheap default suggested.
4. **Monthly budget** → default 20 USD.
5. **Access** → "Only this computer" (default) or "Also from my other devices": asks how they reach
   core (Tailscale recommended: `tailscale serve` or the tailnet address) and records the public
   URL and bind address.
6. Prints the exact next steps (`keith-core start`, `keith`, `keith-core pair`).

Headless: every question has a flag (`--owner-name`, `--provider`, `--api-key-stdin`,
`--front-model`, `--cortex-model`, `--budget`, `--access local|remote`, `--public-url`,
`--non-interactive`). No TTY and a missing answer → exit 2 naming the flag.

Containers: the image entrypoint runs `keith-core setup --non-interactive … && keith-core start`
(the second run is a no-op when already set up); provider keys come from env or Docker secrets
files. Documented with a compose example.

`keith-core start` on an unconfigured data dir: with a TTY it offers to run setup first; without a
TTY it exits with "run `keith-core setup`". Boot never prints a token again.

Day-to-day changes run **while core is up**, through the socket:

- `provider add|list|remove|test`, `model set front <id>`, `budget set 30`;
- `access local|remote [--public-url …]`, which saves the change and says when a restart is needed
  (bind address);
- `pair` (prints the node join command), `nodes list|revoke`;
- `devices list|approve <code>|revoke`;
- `token create --label …|list|revoke`;
- `config show`, which prints each value with its source (env, db, default).

`keith-core status` shows whether core is up, its URLs, model, budget and nodes.

`keith-core doctor` checks:

- data dir and file modes, DB migrated, secret key present;
- provider reachable and front model set;
- socket answering;
- bind address, Host allowlist and public URL consistent;
- Tailscale present when access is remote;
- clock sane.

Each check is one line with a fix hint.

**Running as a service.** Docs ship a launchd plist and a systemd unit with the right env and data
dir, and a note on laptops sleeping. A `keith-core service install` command is later.

### 3. The local socket

Core serves the same Hono app on a second listener, a Unix socket `<dataDir>/core.sock` (0600
inside the 0700 data dir). Requests on it carry `env.via = 'local'`: the principal is the owner,
already stepped up, and every mutation is audited as `via: local`.

- Admin subcommands use it through the typed client (`fetch(url, { unix })`). There is one code
  path, so in-memory state (provider manager, budget, settings) stays correct and events fire.
- `setup`, `db migrate` and `token recover` run **offline** (core stopped) in-process through the
  same service layer, under a lock file. They refuse while the socket answers; online subcommands
  refuse while it does not ("core is not running; `keith-core start`"). `token recover` is audited.
- macOS limits socket paths to ~104 bytes: a long data dir falls back to a short path under
  `$TMPDIR` named by a hash, recorded in the data dir.
- **Same-user risk**, documented in SECURITY.md: any process of the same OS user can use the
  socket, including a shell Keith starts on a node that runs on the core machine. Mitigations:
  - core shell stays off by default;
  - Keith-started shells do not get the socket path in their env;
  - the docs recommend running a node on the core machine as a separate OS user;
  - the TUI marks approvals answered over the socket in the audit log.
- Windows is not a target (documented).

### 4. The client is for conversation

`keith` keeps:

- chat, `/continue`, `/retry`, approvals (Tab);
- `/tasks` (and stop), `/nodes` (read only), `/brain trace`;
- `/whoami`, `/help`, `/quit`;
- the header with model and spend.

Removed: `/connect`, `/providers`, `/model`, `/budget` editing, `/pair`, node revoke. Typing one of
these prints the `keith-core …` command to run on the core machine.

How the client connects:

- **Same machine**: `keith` finds the local socket (default data dir, `KEITH_HOME`, or
  `--core unix:<path>`) and connects with no login. The eharness client takes a custom `fetch`, so
  chat streams and the activity feed work over the socket.
- **Another device** (device login):
  1. `keith login --core <url>` asks core for a code and shows it, e.g. `KTPW-4C7M`, valid 10 min,
     single use.
  2. On the core machine, `keith-core devices approve KTPW-4C7M --label phone` approves it.
  3. The waiting `keith` receives its device credential and stores it in `client.json` (0600).

  Codes use eharness identity pairing (8 chars, no look-alikes, hashed, rate-limited per IP).
  `keith login --token` (paste) stays for scripts. `keith logout` revokes the credential.
- A 401 from the activity feed is terminal in eharness: the client shows "logged out or revoked —
  `keith login`" and restarts the feed after a new login.

**Phones.** P8 clients are terminals (laptop to laptop). A phone needs the web UI (later); the
README says so instead of implying it.

### 4b. TUI redesign

The thin client also gets a new look. References: other terminal coding agents and terminal UI libraries. The goal is calm, dense and readable: no decoration for its own sake,
no emoji, no ASCII art banners, no rainbow ("anti-slop").

Process:

1. A short design study of those references writes `docs/specs/tui-design.md`, covering:
   - layout regions;
   - spacing scale;
   - a colour token set with backgrounds, for dark and light terminals;
   - 256-colour and `NO_COLOR` fallbacks;
   - message, tool-call, approval and notice styles;
   - status line, key hints, empty and error states;
   - widths from 80 to 200 columns.

   It includes ASCII mockups for each screen.
2. Ink 8 (Box and Text background colours, borders) builds it from a small set of shared
   components in `apps/tui/src/ui/`: theme tokens, panel, message, status line, key hint, dialog.
   Features use only those, so the look stays consistent.
3. PTY and ink-testing-library tests assert structure and text, not colours. A `NO_COLOR` run stays
   fully usable.

Gate addition: screenshots (PTY frames) of chat, approval, tasks, nodes, brain trace and login
attached to the evidence; `tui-design.md` matches what ships.

### 5. Credentials and request handling in P8

- Device credentials and tokens share one format, `keith_s_<id>_<secret>`. The secret is 256 bits,
  stored as SHA-256 and compared with `timingSafeEqual` after a lookup by id. The new table records
  person, kind (`device`, `token`), label, created, last seen, IP and revoked.
- Old tokens (`keith_<b64>`) keep working through a legacy parser over the existing `client_tokens`
  table, so no data conversion is needed (the migration is plain generated DDL). `token list` shows
  them as `legacy`. Node tokens (`keith_node_…`) never match either parser.
- The principal is resolved **once per request** and passed on (today it is verified up to three
  times).
- **Host allowlist on every listener and on `/nodes/ws`:** `localhost`, `127.0.0.1`, `[::1]` and
  the host of the public URL, with the right port, plus `KEITH_ALLOWED_HOSTS`. This also blocks DNS
  rebinding when core binds wider, and it works with `tailscale serve` (Host `<machine>.ts.net`).
  Requests with a non-allowed `Origin` are refused.
- **Proxies.** By default core trusts no proxy. A request that arrives on loopback **with**
  forwarding headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-User-*`) is treated as remote: it is
  never local, and the socket stays the only owner-by-location path. `access remote --proxy
  tailscale-serve` records that core sits behind `tailscale serve` (used by P9).
- **Audit log**, an `audit_events` table in the `PersonEvent` shape (`kind`, `actor`, `via`,
  `detail`, `at`), records:
  - device code issued, approved and expired;
  - token created and revoked, `token recover`;
  - settings changes;
  - node pair and revoke;
  - approvals answered.

  `keith-core audit` lists it.

### 6. Node setup

`keith-node setup` asks: core URL, pairing code (from `keith-core pair`), node name, allow shell
(default **no**), work folder. It is `join` with prompts; `join` flags keep working.

### 7. P8 delivery

Sonnet 5.5 subagents with disjoint files, light load (targeted tests per step, `bun run check` once,
smoke once).

1. `packages/cli` (prompts, registry, help).
2. Core: socket listener, offline service layer and lock, `keith-core` commands, principal once per
   request, Host and proxy rules, credential table plus legacy parser, device login routes, audit.
3. Client and TUI: socket transport, device login, token login, settings commands removed, 401
   handling, and the redesign (section 4b: design study first, then the shared ui components, then
   the screens).
4. `keith-node setup`.
5. Smoke and PTY tests rewritten around `setup --non-interactive`, the socket and device login.
   Docs: README quick start, manual-testing, specs (auth, thalamus, client, tui, node, nodes,
   logging), SECURITY, ADR-0008 (admin channel and identity direction), service files.

**Gate:**

- On a clean data dir, `keith-core setup` → `keith-core start` → `keith` chats with no token.
- A second client logs in with a device code approved by `keith-core devices approve`.
- Headless setup works without a TTY, and the container recipe boots.
- An old `keith_` token still works.
- A request with a foreign Host is refused.
- `doctor` passes on a good setup and names the fix on a broken one.
- `bun run check` and smoke pass.

---

## P9 — People and login

Moved to `docs/plans/active/P9-people-and-login.md` (designed here, approved separately).

---

## Later (P10+)

Guests with expiry and caps; invites; managing grants from a client; contacts (people without a
login); messages between people through Keith; approving devices from a signed-in owner client;
Tailscale identity login (`Tailscale-User-Login` behind `tailscale serve`); channels (chat apps,
voice) as `PersonAccount`s; a web UI and phone access (cookies with Origin checks, WebSocket
tickets); passkeys; email OTP; single-binary releases.

## Risks

| Risk | Mitigation |
| --- | --- |
| Large change | Two milestones; P8 has no people or password logic |
| Lock-out | The socket is always owner; `token recover` works offline; no hard owner lock |
| Env vs DB | Env only for boot values (data dir, secret key, log level) plus overrides of bind and public URL; `config show` prints sources |
| Socket path length | Fallback under `$TMPDIR`, recorded in the data dir |
| Same OS user reaches the socket | Documented; core shell off by default; socket path kept out of shell env; separate OS user advised for a local node |
| Local proxies make remote look local | Forwarding headers make a request remote; proxies are opt-in and named |
| `eharness/identity` is a Draft | Keith owns the SQLite adapter; drift is caught by its conformance suite and ADR-0008 records the choice |
| Argon2 memory floods | At most 2 concurrent hashes |

## Decisions (owner, Oct 28, 2026)

1. Device code login in P8; username + password and PIN in P9.
2. Three commands: `keith`, `keith-core`, `keith-node`.
3. Password minimum 15 characters.
4. The TUI is redesigned in P8 (section 4b).

## P8 gate evidence (Oct 28, 2026)

Commits on local `main` (not pushed): `a80b54b` plan, `f858ff5` packages/cli, `9fc9962` TUI design
spec, `335a67f` + `4393368` keith-node, `8dcc2e0` keith-core + local socket + offline admin,
`f3e4cce` credentials + device login + Host allowlist + audit + ADR-0008, `aa870e0` thin client,
`b84b05a` TUI redesign, `26dac94` smoke rewrite + deploy docs, plus this one.

| Gate item | Evidence |
| --- | --- |
| Clean data dir: `setup` → `start` → `keith` chats with no token | smoke steps 1, 2, 4: setup non-interactive with the fake provider, no `keith_` in boot output, socket 0600, TUI over the socket streams a reply |
| Second client logs in with a device code | smoke step 5: `keith login` code, `keith-core devices approve`, client.json 0600, credential works, revoke → 401 |
| Headless setup without a TTY | smoke step 1 (missing flag exits 2); cli tests |
| Container recipe boots | not verified: docs/deploy/container is marked untested |
| Old `keith_` token still works | auth credentials tests (legacy parser), node tokens match neither parser |
| Foreign Host refused | smoke step 6 (421 over raw TCP); guard tests incl. /nodes/ws and Origin |
| `doctor` passes / names the fix | cli tests; a real run printed `✗ provider — none configured: keith-core provider add` |
| TUI frames match tui-design.md | 8 frames at 100×30 (chat, approval unfocused/focused, tasks, nodes, brain trace, logged out, login), truecolor and NO_COLOR; PTY test asserts no colour codes under NO_COLOR |
| `bun run check` | exit 0: Biome clean, tsc clean, 833 pass / 0 fail, check-imports (370 files), check-size, check-exports ok |
| `bun run smoke` | `SMOKE PASS (10 steps ok, 26043 ms)` |
| Supply chain and secrets | `bun audit --audit-level=high`: no vulnerabilities; gitleaks clean on every commit |

Deviations, recorded in the specs: tool lines show no duration yet (parts carry no timing); login output
is plain text without a painted code block; `text-muted` lightened for WCAG AA; the logged-out screen
quits with ctrl+c only.
