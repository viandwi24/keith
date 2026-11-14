# P9 — People and login

Oct 28, 2026 · status: **done Oct 28, 2026** · designed in docs/plans/done/P8-setup-and-identity.md

Builds on P8: local socket, credentials, device login, audit, ADR-0008.

### People

- **`eharness/identity` is the model:** `Person` (stable id; status `active|suspended|left`; role)
  and `PersonAccount(platform, nativeId)` for future channels (chat apps, voice). `PersonEvent` feeds
  the audit table. Keith writes a SQLite `PersonStore` adapter in packages/db and runs the eharness
  conformance suite when it is exported.
- **Ids.** New people get UUIDv7 ids; the owner keeps `owner`. Usernames are a separate, unique,
  changeable field. Session ids stay `front:<personId>`.
- **Roles:** `owner` (exactly one; transfer by CLI), `member`. **Guests are deferred** until
  per-person budget caps exist, so a guest can never spend the owner's whole budget.
- **Management:** `keith-core people add|list|rename|role|suspend|remove|passwd|pin|unlock`, over the
  socket.

### Permissions

- **Capabilities** (`settings.manage`, `people.manage`, `nodes.manage`, `budget.manage`, `chat`, …)
  are declared as metadata on each oRPC contract procedure. One middleware checks them. A test fails
  if a procedure has none.
- A static table maps role → capabilities; per-person grants add to it (stored, managed later).
- **Tools** use a risk policy (`decideByRisk`-style, as in eharness identity), not a third scheme.
  A member's `shell.exec` becomes an approval routed to the owner. The approval item shows who asked
  and the command, a documented exception to "the owner does not see members' messages".
- **Hooks without a principal** (`tool.approve`, memory roots, wake and inbox turns) derive the
  person from the root session id (`front:<id>`, or a worker's parent chain), never from runtime
  state.

### Login methods

| Method | Use | Rules |
| --- | --- | --- |
| Local socket | Same machine | Owner, stepped up |
| Device code | New device | Approved by the owner (CLI, or later a signed-in owner client with step-up) |
| Token | Scripts | Created over the socket, labelled, revocable |
| Username + password | Other devices, members | Argon2id with pinned `memoryCost: 65536, timeCost: 2`; min 15, max 256 characters; no composition rules; blocklist; paste allowed |
| PIN | Step-up only | 6–12 digits, argon2id; never starts a session |

- **Password routes** accept loopback (without forwarding headers), Tailscale addresses
  (100.64.0.0/10, fd7a:115c:a1e0::/48), or a request from `tailscale serve` when that proxy is
  configured (then `Tailscale-User-Login` is logged). Funnel and unknown proxies are refused unless
  `KEITH_INSECURE_LOGIN=true`.
- **Throttling** works per (account, IP): exponential delay from the 5th failure (1 s doubling, cap
  5 min), with no hard lock for the owner (the socket and `people unlock` are the recovery).
  Members lock after 20 failures until unlocked. Answers are uniform, with a dummy hash for unknown
  users. At most 2 argon2 hashes run at once; others queue with a short timeout. Auth bodies are
  capped at 4 KB.
- **Step-up:**
  - It covers settings, people, nodes, tokens and **approving `shell.exec` from a remote client**.
  - It lasts 10 minutes, fixed (not sliding), and is confirmed with the PIN or password.
  - The API answers `KEITH_STEP_UP_REQUIRED` on `/rpc` and `/attention` answers only, never on
    streams. The TUI asks for the PIN and retries once.
  - A remote session whose person has no PIN or password cannot step up, and the message says
    `keith-core people pin owner`.
  - Credentials are not rotated on step-up (rotation would cut open streams and scripts). The
    session row gets `elevated_until`; role changes revoke the person's sessions.
- **Idle lock** is deferred: sessions are revocable and audited instead.

### Isolation

- `front:owner` hardcoding goes everywhere:
  - compose (dead letter, reconcile, recovery, graceful stop);
  - client `OWNER_SESSION`, TUI chat view;
  - budget `OWNER_SCOPE`;
  - test harnesses.
- Recovery and graceful stop enumerate every person's front. A worker's notice goes to its task's
  parent front.
- Memory becomes `memory/<personId>/` through `memory({ roots: (ctx) => … })` keyed by the root
  session's person. The owner's existing `memory/owner/` is unchanged.
- The activity feed filters per person. The owner also sees system events (nodes, budget) without
  other people's message previews.
- The client learns its person from `auth.whoami`.
- Budget: one monthly limit plus per-person caps; the ledger records the person.

**P9 gate:** the owner and a member log in from two clients. The member cannot read the owner's
memory, activity or settings. The member's shell request reaches the owner as an approval. Brute
force and step-up limits hold. Old tokens still work. Check and smoke pass.


## Delivery

Sonnet 5.5 subagents, one step at a time (most steps touch apps/core and generate migrations, so
they do not run in parallel). Light load: targeted tests per step, `bun run check` and smoke once at
the gate. Local commits on `main` after each step, no push.

1. **People store.** Schema: `people` gains `username` (unique), `status`, `created_by`, `updated_at`;
   new `person_accounts`; person events go to `audit_events`. A SQLite `PersonStore` adapter in
   packages/db typed by `eharness/identity` (conformance suite if exported). UUIDv7 ids for new
   people, `owner` kept. `keith-core people add|list|rename|role|suspend|remove|transfer-owner`
   over the socket; `admin.people.*` contracts.
2. **Password and PIN.** Credential kinds `password` and `pin` (argon2id, pinned cost, 2 concurrent
   hashes), `POST /auth/login` (username + password → device credential), the network rule,
   throttling per (account, IP), uniform answers, `people passwd|pin|unlock`, `elevated_until` and
   `POST /auth/step-up` (PIN or password). Client: `passwordLogin`, `stepUp`.
3. **Permissions.** Capability metadata on every contract procedure, one middleware, a test that
   fails when a procedure has none; the role table; step-up required for sensitive capabilities
   from remote principals; tool risk policy (a member's `shell.exec` becomes an owner approval;
   answering a shell approval remotely needs step-up).
4. **Isolation.** No `front:owner` anywhere; recovery, reconcile, dead letters and graceful stop
   per person; memory roots per person from the root session id; activity feed filtered per
   person; budget per-person caps with the person in the ledger; `OWNER_SESSION` removed.
5. **Client and TUI.** `keith login` offers password or device code; `KEITH_STEP_UP_REQUIRED` → PIN
   prompt and one retry; role in the header and `/whoami`; member views of approvals routed to the
   owner. Follows docs/specs/tui-design.md.
6. **Smoke, docs, gate.** Smoke adds a member: `people add`, password login, isolation checks,
   member shell request reaching the owner, step-up, brute-force delay. Manual-testing scenarios
   for two people, SECURITY.md, ADR-0008 update, specs. `bun run check`, smoke, evidence.

## Gate evidence (Oct 28, 2026)

Commits on local `main` (not pushed): `cb3fded` plan, `42ce8fd` people store, `8124f23` password, PIN,
step-up, `9bad67d` capabilities and owner-routed shell, `a97f837` isolation, `e3743b1` client and
TUI, `9630b65` smoke and docs (ADR-0009), a test race fix, plus this one.

| Gate item | Evidence |
| --- | --- |
| Owner and a member log in from two clients | smoke: device login (owner) and `keith login --password` as `ana` (client.json 0600, whoami member) |
| Member cannot read owner memory, activity or settings | smoke isolation step (manage calls 403, `front:owner` 404); `isolation.e2e.test.ts` (memory folders, feed filter, budget cap, transfer) |
| Member shell request reaches the owner as an approval | smoke member-shell step through the real fake-provider tool call: `waitingFor: owner`, member answer 403 `KEITH_WAITING_FOR_OWNER`, cold owner `KEITH_STEP_UP_REQUIRED`, deny after PIN step-up; `member-shell.e2e.test.ts` runs the command after approval |
| Brute force and step-up limits | smoke: uniform 401, 429 with Retry-After after 5 failures; `login.test.ts`, `step-up.test.ts` (fixed 10 min window, owner never locked, member lock at 20) |
| Old tokens still work | auth credential and token tests (legacy parser; legacy tokens cannot step up, documented) |
| Every procedure declares a capability | `capabilities.test.ts` walks the whole contract |
| `bun run check` | exit 0: Biome clean, tsc clean, 981 pass / 13 skip / 0 fail (the 13 are the env-gated frame renders), check-imports, check-size, check-exports ok |
| `bun run smoke` | `SMOKE PASS (15 steps ok, 28284 ms)` |
| Supply chain and secrets | `bun audit --audit-level=high`: no vulnerabilities; gitleaks clean on every commit |

Notes: the first gate run hit a race in a TUI paste test (the row rendered before the fake core saw
the request); the test now waits for both. The smoke run took three attempts while a `whoami`
assertion was corrected. Manual-testing scenario 11 was written from the CLI source and not run by
hand. Frames for the new states are in the session scratchpad (`frames-p9`).
