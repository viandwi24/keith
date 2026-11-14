# Architecture

Keith is a product built on eharness (like `examples/team` in the eharness repo), living in its
own repo. This page maps the brain-region names to technical terms, folders and eharness parts.
Design details and milestones: `docs/plans/active/P0-mvp.md`. Next plans: `docs/plans/active/README.md`. The newest decisions are ADR-0020 to ADR-0027 (`docs/decisions/`): where a README, this page or a plan disagrees with a newer ADR or a spec, the newer source rules (ADR-0027 §1). Contracts per module: `docs/specs/`.
The regions of M0 to M4 are built, and later plans added the rest of the table (Parietal, Hypothalamus, Corpus callosum and Prefrontal, P33).
M4 hardened the system: memory, resume, budget, compaction, logging and the real-model eval (see "Hardening (M4)").

## Flow

```text
client (TUI, later web UI)
   │  HTTP + SSE through @keith/client
   ▼
Thalamus ──► front agent (Wernicke–Broca) ──agent tool──► Cortex workers (background subagents)
   │             ▲          │                                  │
   │             │          └─ answers fast, stays chatty      ├─ local tools (files, web)       
   │        RAS: wake turn                                     └─ Motor ──► nodes (WebSocket)
   │        when a worker reports                                   │
   └─ brain events (activity feed) ◄── every region ◄──────────────┘
                                      Amygdala gates risky actions (approvals)
```

## Regions

| Region | Technical role | Folder | eharness part |
| --- | --- | --- | --- |
| Thalamus | Single entry: auth, routing of every incoming message | `apps/core/src/modules/thalamus` | `eharness/http` (`authorize`), Hono middleware |
| Wernicke–Broca | Front agent: understands input, answers fast, delegates; `/new` starts a fresh front context and `/compact` shortens it (ADR-0030) | `modules/wernicke-broca` | agent + `subagent()` (background, `approvals: 'park'`) |
| Cortex | Worker agents for long tasks (`cortex.research`, `cortex.general`) | `modules/cortex` | background subagents (park), `web`, `filesystem/node`, `todos`; machine actions only through `motor_remote` (no local shell) |
| Motor | Executes actions locally or on a node | `modules/motor` | tool `motor_remote`, hooks `tool.approve` and `tool.grantScope` (risk from the node manifest), node registry |
| Amygdala | Approval decisions and the attention queue | `modules/amygdala` | `permissions`, `activity` (`listAttention`, `answerAttention`); `/attention`, `brain.amygdala.wait`/`decide`, TUI approval bar |
| RAS | Marks messages Keith started itself (worker reports) as proactive | `modules/ras` | wake turns (`kind: 'wake'`), data part `keith.proactive` |
| Hippocampus | Long-term memory: markdown files in `data/memory/<personId>/` (one folder per person, the first owner's is `owner`; `/memories`, `profile.md` always in context); a daily dreaming pass per person consolidates it (`specs/dreaming.md`, ADR-0031); writes become `brain.hippocampus.write`, reads `brain.hippocampus.recall` | `modules/hippocampus` | `memory()` on a `mountFs` of the memory folder (`flushOnCompaction`) |
| Budget | Cost ledger per month and the monthly limit; `budget.get`/`set`; readable stop notice | `modules/budget` | `eharness/limits` (`budgetNotice`), `budget` agent config, `BudgetLedger` on SQLite |
| Resume | Instance id, boot recovery of unfinished turns, resumable streams | `modules/resume` | `recovery: { instanceId }`, `streams`, `agent.session(id).recover()`, `StreamLogAdapter` on SQLite |
| Tasks | Task board of delegations; oRPC `tasks.list`/`stop` | `modules/tasks` | worker hooks `turn.*`/`step.end`, `step.prepare` (front reminder), `reconcileBackgroundChildren` |
| Nodes | Pairing, WebSocket gateway (`/nodes/ws`, protocol v2: token rotation after 30 days, per-node message budget), heartbeat, node registry, core node. Node drivers (P31, ADR-0023) add capabilities: the core accepts or refuses each announced id (`refused` in the registry) and keeps the node online. Bundled drivers: `desktop` (screenshots, input) and `sandbox` (code in a container). Nodes are Keith's self layer: every person with `nodes.read` sees all nodes (ADR-0027 §9) | `modules/nodes` | `eharness/identity` pairing helpers |
| Brain events | `brain.<region>.<phase>` events for the brain panel | `modules/brain-events` | `activity()` store, `/activity` feed |
| People | Directory of who uses Keith: roles (`owner`, `member`), status, usernames, platform accounts; `admin.people.*` | `modules/people` | `eharness/identity` (`PersonStore` on SQLite, `resolveRole` rule) |
| Permissions | Capability on every procedure, role table plus grants, one middleware, step-up for sensitive calls; owner-routed approvals | `packages/contracts/src/capabilities.ts`, `modules/auth/capabilities.ts`, `platform/rpc.ts`, `modules/people/grants.ts` | oRPC middleware, `permissions` (`tool.approve`), `activity` attention hooks |
| Sessions helper | Per-person front session ids (`front:<personId>`) and the person of any session id, derived from the id alone (hooks without a principal) | `platform/sessions.ts` | `agent.session(id, { lock })` |
| Auth | Credentials (`keith_s_…`), device login codes, legacy tokens, audit log, Host allowlist | `modules/auth` | `eharness/identity` pairing helpers |
| Activity logs | Every model call per session (kind, figures, messages sent, raw request and response), redacted, with retention and an audited owner read | `modules/audit/activity-logs` | eharness `model.call` hook (spec 12 §7) |
| Delivery | Exactly once by run id, retried when the front session is unreachable, the failure reported to the creator; `deliveries` table, route seam (the front session is the default route) | `modules/delivery` (`deliver()`, `createDelivery`, `singleRoutePlanner`); built in `compose-delivery.ts` | `inject` with the run id as its idempotency `key` (`eharness` session) |
| Parietal | Presence: a person's clients (TUI now, web and mobile later), signals, the computed state (active, idle, away, busy, offline), disclosure rules, the `presence` tool of the front agent, and the `notify` route to a client | `modules/parietal` | `activity()` store (presence and delivery records), `definePlugin` (the `presence` tool), `ActivityStore` port |
| Hypothalamus | Protocols and proactive behaviour: a protocol is data (trigger, conditions, steps, limits), the engine runs it durably, the front agent proposes and a person confirms; the personal agenda. Contracts and spec exist (P28.1); the engine runs durably (P28, with the built-in `owner-absence` succession of P29) | `modules/hypothalamus` | `eh_schedules` (time triggers), `delivery` (notify, wake), `parietal` (signals, presence overlay), `activity()` feed |
| Corpus callosum | Shared rooms (group call mode, ADR-0026): a room has members and one conversation with Keith; each turn runs with the speaker's principal and room-scoped tools only; the window is the last 30 minutes or 200 events; control and private requests need a human confirmation; the transcript is the ACL kind `room` | `modules/corpus-callosum` | agent and one session per room (`send({ principal })`, `step.prepare` volatile reminder), `acl` kind `room`, `rooms.*` RPC; text transport behind `RoomTransport` |
| Prefrontal | Persona and answer modes (ADR-0029): the global persona (a versioned document from a built-in template, owner-edited with step-up), the per-person style (address, language, brevity, formality, gentle topics), the mode choice (speech, chat, report) from the channel's declared rendering ids, the speakable guard, the document hand-off and the fixed lines (built in P33; contract in `docs/specs/prefrontal.md`) | `modules/prefrontal` | the turn reminder (`refresh: 'turn'`: persona block, style lines, mode block) and the static system prompt (core rules only), the `message.beforeSave` speakable guard, `persona.*` RPC, `persona`, `persona_versions` and `person_style` tables; no model chooses a mode or a style |

**Succession (P29, ADR-0022 §3).** Owner absence is a built-in protocol of Hypothalamus, on while an heir is set. When the owner
has been silent for the window (7 to 90 days, 14 by default) Keith checks in with the owner daily on every channel in weekly
blocks, then starts a 7-day grace and tells both people. The heir named in advance claims ownership with their own credential and
a step-up; the previous owner is suspended and never shown. Any sign of life from the owner cancels a run. A claimable state that
nobody claims expires after 52 weeks, and it is reconciled lazily (on status, claim, boot and each tick), so a core that was down
catches up at its first ticks. Spec: `docs/specs/succession.md`. Code: `modules/hypothalamus/succession*.ts`,
`builtins-succession.ts`, `people.ts` (`succeed`).

**Shared rooms (P30, ADR-0026).** A room is a group call: the owner, or a member with `rooms.start`, invites people, and once one accepts
they all talk to the same Keith in one conversation (`/room start <names>` in the TUI; the banner on Home and in the chat). Each turn
runs as the speaker, with the room's own tools only: no memory, notes, agenda, files or other rooms. A room's files live in
`<workspace>/rooms/<roomId>/` (ADR-0021). A personal request goes to the speaker's own chat, and its result reaches the room only on
that person's confirmation. Spec: `docs/specs/corpus-callosum.md`; the owner's rights and audit: `docs/sharing-and-privacy.md`.

### Node drivers and planned regions (P31)

Node drivers extend Nodes (ADR-0023; P31): the bundled `desktop` and `sandbox` drivers are built, see the Nodes row above.
Client capabilities (`notify`, `open.view`) are P27's registry, not node drivers. Workspaces per owner stay in Cortex (ADR-0021).
Keith's four layers of awareness (self, personal, shared room, ecosystem) are in ADR-0020.

## Hardening (M4)

Specs: `docs/specs/hippocampus.md`, `budget.md`, `resume.md`, `logging.md`, `evals.md`.

- **Memory.** One folder per person, `data/memory/<personId>/` (the owner's id is `owner`), chosen
  from the root session's person; the front agent writes it and that person's workers read it
  (virtual path `/memories/<personId>`; its `profile.md` is pinned into every turn). People never
  reach each other's folder. The protocol text
  keeps secrets and task state out of it. Memory writes emit `brain.hippocampus.write`, reads come
  from the brain events plugin as `brain.hippocampus.recall`. The front agent writes memory before
  a compaction summarizes the history.
- **Compaction.** The front agent compacts a long chat; `compaction.model` (a function of the ctx that returns `resolveRoleModel('front', providers)`,
  `modules/providers/role-model.ts`) makes the summary and the memory flush run on the front
  role's model of the moment.
- **Resume.** Turn chunks are appended to a SQLite stream log (`packages/db/src/eh/stream-log.ts`,
  retention 10 minutes), so a dropped client re-attaches to a turn that still runs. The core keeps a
  stable `instanceId` in `data/instance-id`; at boot `recoverSession` repairs the turn a dead
  process left behind (marks it interrupted, saves an `eh.notice`). The client follows the server
  turn after a drop (`attachChat`, `reportChatNotice` in `packages/client`); the TUI offers `/continue`
  (continue the interrupted turn) and `/retry` (redo the answer).
- **Budget.** A ledger in SQLite (`packages/db/src/eh/budget-ledger.ts`) records spend per month for
  the global scope (stored as `owner`) and for each person (`person:<id>`, whose limit is their
  optional cap). Default global limit 20 USD (`DEFAULT_MONTHLY_LIMIT_USD`), a per-turn cap of
  0.5 USD for the front agent. A turn stopped by a cap leaves a readable notice
  (`budgetNotice`). oRPC `budget.get` (own view, or global plus people for a manager), `budget.set` and
  `budget.setPersonCap` read and change the limits; a change emits
  the activity event `budget-changed`. The TUI shows spend in the header and in `/budget`.
- **Identity.** Who may sign in is decided by the auth policy (zone, role and identifier kind). The sign-in rules apply on every route: `/auth/login`
  and `/auth/flow` narrow by role and identifier kind alike, and a step-up gates by the rule of the method that answers. Revoking a credential, suspending
  or removing a person, transferring ownership and changing a grant close the open activity, session and attention streams at once (`onAccessChanged`),
  and a backstop sweep re-checks them every 30 s. Owner-only capabilities (`audit.read`, `groups.manage`, `reviews.decide`, `plugins.manage`,
  `guests.manage`) are never granted to a member.
- **Logging.** `apps/core/src/platform/logger.ts` writes one JSON line per event to
  `data/logs/keith-YYYY-MM-DD.log`, keeps 14 days, and redacts secret-looking keys and strings
  before anything reaches disk.
- **Evals.** `apps/core/evals/news` runs the "show me the news" scenario against a real model
  (`bun run eval:news`, needs `OPENROUTER_API_KEY`; `--scripted` runs it offline) and writes reports
  to `data/evals/`.

## Run topology (P8)

Three commands, one per role (`bin` entries, `bun run link` puts them on PATH):

```text
keith-core (core machine)                 keith (any client machine)        keith-node (each node machine)
  setup, start, status, doctor,             chat, login, logout, whoami       setup, join, run, status
  devices, token, pair, nodes, audit ...
   │ HTTP :7420 (Host allowlist) ◄──────────── device credential (keith_s_…) ─┤
   │ WebSocket /nodes/ws ◄─────────────────────────────────────── node token ┘
   └ Unix socket <data dir>/core.sock (mode 0600): the owner's machine; a session is needed by default
        ▲ keith-core admin commands, and `keith` on the same machine
```

The socket is the way in from the core machine, not an implicit owner: by default (local trust `none`, ADR-0014 amendment of 2026-11-09)
a request on it needs a session like any other (PIN or password, `keith-core login`). Only an owner who opts in to `idle-lock` or `full`
gets an implicit owner there (`docs/specs/auth.md`).
Other devices sign in inside the app (`keith login --core <url>` opens the Sign in screen: a device code approved by `keith-core devices
approve`, a password or a token; ADR-0013) and then send a credential on every request. Core listens on loopback unless setup chose
remote access; it has no TLS, so reach it over Tailscale or another private network. Service files
and a container recipe: `docs/deploy/`. Specs: `docs/specs/core-cli.md`, `auth.md`, `client.md`.

## Node protocol

Core and nodes talk JSON over one WebSocket per node (`/nodes/ws`, bearer node token): `hello` and
`welcome`, `heartbeat`, `invoke`, `progress`, `result`, `cancel`. The message types live in
`packages/contracts/src/node-protocol.ts`; behaviour in `docs/specs/node.md` (daemon) and
`docs/specs/nodes.md` (core side).

## Extension points (ADR-0007)

Growing things are registries: code registers a definition with a zod settings schema, the owner
creates instances through a form generated from it. Clients render forms from the schema.

| Registry | Module | eharness part |
| --- | --- | --- |
| Model providers, connections, models | `modules/providers` | `eharness/providers` (OpenRouter first and default) |
| Connectors (later) | `modules/connectors` | `eharness/connectors` |
| Cortex worker types | `modules/cortex` (`WORKER_KEYS`, `createWorker`) | `subagent({ agents })` catalog |
| Node capabilities | `modules/nodes` | — (Keith manifest) |
| Plugins | `packages/host` | — |
| CLI commands and prompts | `packages/cli` | — |

## Layers and dependency rules

```text
apps/tui ──► packages/client ──► packages/contracts ◄── apps/node
                                       ▲
apps/core ──► packages/{contracts, db, eh-ext, host, cli}
apps/node ──► packages/cli
plugins/* ──► packages/{host, contracts}
```

- `packages/*` never import `apps/*`; `packages/db` is used only by `apps/core`.
- `apps/tui` imports only `@keith/client`, `@keith/contracts` and `@keith/cli` from the repo; from npm only Ink,
  React and the chat stack (`@ai-sdk/react`, `ai`, `eharness/client`), never eharness core; `zod`
  only in `src/platform/config.ts` (its env schema).
- A core module imports another module only through its `index.ts`.
- Plugins import only `@keith/host` and `@keith/contracts`.
- No import cycles; a relative import never leaves its package.

All rules are enforced by `scripts/check-imports.ts` (Bun's own import scanner and resolver) in
`bun run check`. A type-only import across a boundary counts too.
