# Keith MVP — Design

Oct 26, 2026 · @viandwi24

## Superseded points

This plan is history from 2026-10-26 and is kept as written below. Where it disagrees with a newer source, the newer source rules (ADR-0027 §1: newest ADR > spec > README, SECURITY.md, ARCHITECTURE, plans). Stale points:

| Stale point below | What rules now |
| --- | --- |
| "Minimal identity: one owner, login with a local token" (scope list) and every "single owner" wording | One owner and any number of members, each with their own conversation, memory and workspace; sign-in by identifier with PIN, password, device code or token (`docs/specs/people.md`, `docs/specs/auth.md`, ADR-0009, ADR-0014, ADR-0020) |
| `cortex.general` has `shell (local)` and memory write (agent table) | No local shell on workers; machine actions only through `motor_remote`; workers read memory read-only (`docs/specs/cortex.md`, `docs/specs/hippocampus.md`, `docs/specs/motor.md`) |
| Front wired with `messageTool: true` / `send_message` deferred | `messageTool: false` for the lead and every worker (`docs/specs/cortex.md`) |
| "Nothing goes up to eharness", "no upstream", pin `eharness@0.9.0`, ADR 0002 row | Generic gaps go upstream and are adopted by an upgrade (ADR-0011, ADR-0002 status); Keith uses `eharness@0.12.0` (AGENTS.md, hard rule 5) Superseded: the pin is now eharness 0.14.1 (ADR-0011). |
| Node join `bun apps/node join --core ws://<host>:7420 --code ABCD-EFGH` | `keith-node join --core <url> --code <code>` with an `http(s)` URL; `ws://` is converted, and a plain remote URL needs `--insecure` (`docs/specs/node.md`) |
| Memory in `data/memory/owner/` | `<dataDir>/memory/<personId>/` per person; `owner` is only the first install's folder (`docs/specs/hippocampus.md`) |
| The local socket as the owner with no login (implied by the one-owner design) | No implicit owner by default; a session is needed (`docs/specs/auth.md`, ADR-0014 amendment of 2026-11-09) |

**Location in the repo:** `docs/plans/active/P0-mvp.md`. This document is the master MVP plan; the per-milestone plans (`P1`–`P5`) are written next to it when a milestone starts, then moved to `docs/plans/done/` after its gate passes. The name `docs/design_system.md` should be avoided: the term "design system" usually means UI components, and the repo standard uses kebab-case for file names.

## Summary

The Keith MVP is one core node and one TUI client (Ink) you can chat with, while showing the "brain" at work: the conversation layer answers fast, Cortex workers do the tasks in the background, and the results are delivered proactively.

The product and repo name is **Keith** (`viandwi24/keith`, MIT license; CC BY-NC-SA 4.0 since Nov 14, 2026, ADR-0001 amendment). A fictional assistant is only a concept reference, not a name: it is not used for packages, env vars, files or UI text.

It sits at the same level as `examples/team` in the eharness repo, that is, a product (Ring 3) built on top of eharness. The difference is that Keith lives in a **separate repo**, following ADR-0062: a product is built on a released version.

Three rules for the MVP:

- **eharness is used as published**, pinned to `eharness@0.9.0` from npm. Every module the MVP needs (`subagent`, `shell`, `filesystem/node`, `memory`, `todos`, `permissions`, `activity`, `http`) has existed since 0.8.0. Version 0.9.0 (released 2026-10-26) adds `identity`, `scheduler`, `limits`, `handoff`, `channels`, `clock`, `browser` and `code`, all still Draft. The MVP uses the pairing helpers from `eharness/identity`; the rest is used only in phases after the MVP. Superseded: the pin is now eharness 0.14.1 (ADR-0011).
- **Nothing goes up to eharness.** Needs that eharness does not meet are built in the local package `packages/eh-ext`, named and shaped in the eharness style so they are easy to move later. Superseded: ADR-0011 (generic gaps go upstream and come back by an upgrade).
- **Take patterns from the examples.** The server and storage copy `examples/team` (Bun + Hono + SQLite), and the TUI copies `examples/coder` (Ink).

## MVP scope

The MVP is done when one scenario runs end to end: the user asks "find A", Keith answers right away, the user can keep talking about something else, and then Keith delivers the result of A on its own. Meanwhile, the brain panel in the TUI shows which region is active.

**In the MVP:**

- Core node: Bun + Hono server, eharness agents for the front layer and Cortex workers, SQLite + file storage.
- Conversation layer (Broca–Wernicke) with a few tools, delegating to Cortex through a background `subagent`.
- Task board, proactive notifications, and approval for risky actions (Amygdala).
- Brain event stream: all brain activity is emitted as events so it can be visualized.
- Nodes: peripheral node registration, pairing, heartbeat, and one simple remote capability (running shell commands on another node).
- TUI client (Ink): chat, brain panel, task board, node list and approvals.
- Minimal identity: one owner, login with a local token.
- Dynamic model providers: the provider list, connections (credentials) per provider and models per connection are set by the user from the TUI, with **OpenRouter** as the first and default provider. See "Extension points".

**Deferred:**

- Web UI and the desktop-web sandbox (next phase, see the last section).
- Voice and all modality adapters.
- People Contact, multi-user, kiosk mode, `PersonStore` from `eharness/identity` (the MVP uses only its pairing helpers).
- DMN: scheduler, reflection heartbeat, standing orders. Later built on `eharness/scheduler` (0.9.0) with a Keith-owned SQLite `ScheduleStore` adapter.
- Core failover, remote filesystem and browser on nodes.
- The full host plugin system. The MVP only needs the contract, with two bundled plugins (TUI API and node) as proof.

## Architecture

All messages come in through one door (Thalamus), are answered by the front layer, and long work is delegated to Cortex, which can act on any node through Motor.

&#91;embedded content: MVP architecture · brain regions and eharness modules\]

Each box is one folder in `apps/core/src/modules`, and the line under its name shows the eharness part it uses. The neurological naming is mapped to technical terms in `docs/ARCHITECTURE.md` (ADR-0004).

## Repo structure and conventions

The repo follows the standard in the "Repo standard" sections at the end of this document (adopted from an earlier repo standard): a monorepo `apps/*` + `packages/*` with Bun workspaces (no Turborepo, see ADR-0005), a modular monolith on the server, a vertical slice per feature, and every cross-app type from `packages/contracts`. This also matches the repo standard's lesson that an example that grows into a product moves to its own repo.

### Layout

```text
apps/
  core/                 core node: Hono + eharness (server, the only user of packages/db)
    src/
      modules/          one feature = one folder, imported only through index.ts
        thalamus/  wernicke-broca/  cortex/  motor/  amygdala/  ras/
        hippocampus/  tasks/  nodes/  brain-events/  auth/
      platform/         config (env schema), logger, db client, eharness wiring
      main.ts           wiring only, no logic
  node/                 peripheral node daemon: pairing, heartbeat, motor executor
  tui/                  Ink: src/features/{chat,brain,tasks,nodes,approvals}
packages/
  contracts/            zod: brain events, node protocol, Keith API contract
  db/                   Drizzle + bun:sqlite, migrations, eharness storage adapters (server-only)
  eh-ext/               local extensions on top of eharness (no upstream)
  host/                 host plugin contract and loader
  client/               typed client SDK: eharness/client + Keith contract
plugins/              big features (the web UI became apps/web, ADR-0035)
docs/
  ARCHITECTURE.md  decisions/  specs/  plans/active/  plans/done/
.claude/skills/         add-feature, add-brain-region, add-node-capability, release
AGENTS.md               repo map, ±100 lines
CLAUDE.md               contains only: @AGENTS.md
data/                   runtime, gitignored: keith.db, workspace/, memory/, logs/
```

One machine can run `core`, `node` and `tui` side by side (`bun run dev` starts all three in parallel with `bun run --filter`). The core also registers itself as a node, following the idea that a node can be a server, a client, or both.

### Dependency rules (checked by CI)

| Rule | Tool |
| --- | --- |
| `packages/*` must not import `apps/*`; a package imports only the dependencies declared in its `package.json` | `check-imports` (`undeclared-dependency`) |
| `packages/db` is used only by `apps/core` | `check-imports` |
| `apps/tui` imports only `packages/client` and `packages/contracts`, never core modules | `check-imports` |
| A module imports only `modules/<other>/index.ts`, never its internal files | `check-imports` |
| Request/response and event types come only from `packages/contracts` (except the `eharness/http` wire types, see ADR-0003) | `check-imports` + review |
| No import cycles | `check-imports` (`no-circular`) |

The third rule guarantees the web UI will later be equal to the TUI: both only have the same access through `client`.

### Gates and conventions

- `bun run check` = Biome (format + lint) + strict `tsc --noEmit` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) + `bun test` + boundaries + `check-size` (warning at 400 lines, failure at 800). CI runs the same command.
- Commits and PR titles follow Conventional Commits, checked by commitlint. Scope = app, package or module name: `core`, `node`, `tui`, `contracts`, `db`, `eh-ext`, `host`, `client`, `thalamus`, `cortex`, and so on. Examples: `feat(cortex): run delegated tasks as background subagents`, `fix(tui): keep the brain panel in sync after reconnect`.
- Files are kebab-case, tests are `<file>.test.ts` next to the code, DB tables are plural snake\_case, env is read once in `platform/config` through a schema.
- Branch model A (solo MVP): `main` only, direct push allowed, version 0.x. Changesets is initialized with `privatePackages`, because nothing is published.

### Day-one decisions (ADR)

| ADR | Decision |
| --- | --- |
| 0001 | Branch model A, Changesets, MIT license, public repo `viandwi24/keith` (decided Oct 26, 2026; license changed to CC BY-NC-SA 4.0 on Nov 14, 2026) |
| 0002 | Keith is a separate repo, built on `eharness@0.9.0` from npm, with no upstream changes Superseded: the pin is now eharness 0.14.1 (ADR-0011). |
| 0003 | Two plugin layers: Keith host plugins wrap eharness plugins; the chat route uses `eharness/http` as is, and Keith's extra contract uses contract-first oRPC in `packages/contracts` (decided Oct 26, 2026, reasoning in P1) |
| 0004 | Neurological naming: region names as module names, with a map to technical terms in `ARCHITECTURE.md` |
| 0005 | Bun workspaces without Turborepo during the MVP; Turborepo is added if `bun run check` passes 2 minutes |
| 0006 | Bun first: Bun built-ins are used first; other tools only when Bun cannot, with a written reason (decided Oct 26, 2026) |
| 0007 | Dynamic registries: definitions in code (core or plugin), instances as data the user creates through a form built from the schema; providers via `eharness/providers`, OpenRouter default, sealed credentials (decided Oct 26, 2026) |

### Keeping a large codebase efficient

Keith grows by adding plugins and modules, not by enlarging the core. The core holds only contracts, wiring and brain regions; every new capability (voice, display, other harnesses) comes in as a plugin. Clients are the exception: the TUI and the web UI are built-in apps (ADR-0035). Each rule below is enforced by machine from M0, because rules added after the codebase is large are expensive to catch up on.

| Area | Rule | Enforced by |
| --- | --- | --- |
| Growth | A new big feature = a folder in `plugins/*`; a plugin may import only `packages/host` and `packages/contracts` | `check-imports` |
| Public API | Every package and module has a narrow `index.ts`; public API changes must be deliberate | Per-package export snapshot (like eharness' `exports-snapshot`) in `check` |
| Build and typecheck | Typecheck per package with `bun run --filter`; `tsc` 7 (native) is fast enough without a cache. On PRs, test only what is affected (`bun test --changed`). Turborepo is added later if `bun run check` passes 2 minutes (ADR-0005) | Root `package.json` + CI |
| Internal packages | Export `.ts` directly (just-in-time), except those run standalone | Convention in the root `tsconfig.json` |
| Tests | Unit `*.test.ts` next to the code; integration `*.int.test.ts` as a separate task; fake models from `eharness/testing` (`scriptedModel`), no real models in CI | Root scripts + review |
| Size and cycles | Warning above 400 lines, failure above 800; no import cycles | `check-size`, `no-circular` |
| Dependencies | One version per dependency across the workspace through the Bun catalog; a new runtime dependency needs a reason | Root `package.json` + review |
| Documentation | `AGENTS.md` per app and package, a spec per module, finished plans archived and not linked from `AGENTS.md` | Review + `AGENTS.md` line limit |
| Runtime | Plugins load when enabled (dynamic import); SQLite indexes on `session_id` and `seq`; activity feed retention; tool output truncated; volatile text goes through reminders so the prompt cache stays intact | Module spec + tests |

The differences from the repo standard's default layout (a `plugins/` folder, neurological module names, `eharness/http` wire types outside `contracts`) are recorded in ADR-0003 and ADR-0004, following the repo standard rule that deviations are fine as long as the reason is written.

## Core node

The core node runs two kinds of eharness agents: a front layer that answers fast, and Cortex workers that work in the background as background subagents. A worker's result returns to the front layer as a wake turn, so Keith delivers it on its own without being asked.

### Two agents

| Agent | Module | Model | Tools |
| --- | --- | --- | --- |
| `front` (Wernicke–Broca) | `modules/wernicke-broca` | Fast and cheap | `agent` (delegation), `agent_stop`, `agent_output`, `nodes_status`, `datetime`. `send_message` is deferred because it is still Draft in eharness (P3) |
| `cortex.general` | `modules/cortex` | Strong | `shell` (local), workspace files, `web_fetch`, `web_search`, `todo_write`, memory, `motor_remote` |
| `cortex.research` | `modules/cortex` | Strong | `web_fetch`, `web_search`, memory |

Each agent's model is not written in code. Each role (`front`, `cortex`) stores a `profile:model` reference (for example `openrouter:anthropic/claude-haiku-5.5`) chosen by the user. The model comes from the provider manager (see "Extension points"), so changing the model or provider needs no redeploy.

The front layer is wired with `subagent({ approvals: 'park', background: { default: true }, messageTool: true })`. The `park` mode is chosen because only this mode lets background children survive a core restart (eharness ADR-0046). The front layer's session id is `front:<personId>`; in the MVP only `front:owner` exists.

### The "find A" flow

1. The TUI sends a message to `POST /sessions/front:owner/chat` (`eharness/http`). Thalamus checks the token and emits a `thalamus.routed` event.
2. The front layer turn answers "Sure sir, I'll look for it" and calls `agent` with `cortex.research`. The tool returns a task id immediately, and the turn ends within a few seconds.
3. The user keeps chatting. Each new message is a new turn in the same session; the worker keeps running.
4. If the worker needs permission (for example `motor_remote`), the worker turn parks. The request shows up in the attention queue, Amygdala emits an event, and the TUI shows the approval panel.
5. The worker finishes. eharness injects an `eh.event` into the front session with `wake: true`. If the user is in the middle of a turn, the report arrives at the next step boundary; if idle, a new turn starts.
6. The wake turn produces "Sir, I just finished looking for A, here are the results". RAS marks this message as proactive so the TUI shows it with a badge.

### Task board

The `tasks` module stores one row per delegation (task id, worker type, description, status, result summary), filled from the `tool.after` hook on the `agent` tool and from subagent report events. The front layer's `step.prepare` hook returns a `reminder` with the list of active tasks. The reminder is volatile, so it does not break the prompt cache, but the front layer can always answer "how far along is it?". At boot, `reconcileBackgroundChildren()` recovers interrupted tasks.

### Brain events

Each region emits `brain.<region>.<phase>` events to the same activity feed as eharness events (`activity()` accepts app-owned types). The TUI only needs to subscribe to one stream.

| Region | Emitted when | Source |
| --- | --- | --- |
| Thalamus | An incoming message is routed | Hono middleware |
| Wernicke | A front turn starts with user input | `turn.start` hook |
| Broca | The front layer starts and finishes speaking | `turn.start` / `turn.end` hooks |
| Cortex | A worker starts, a step finishes, a worker finishes | `turn-started` / `step-finished` events of the child session |
| Motor | An action tool runs, locally or on another node | `tool.before` / `tool.after` hooks |
| Amygdala | An approval decision, a pending permission request | `approval.decided` hook, attention queue |
| Hippocampus | Memory is read or written | `onWrite` callback of the `memory()` plugin, `tool.after` |
| RAS | A worker report is decided to be delivered | Turn with `kind: 'wake'` |

## Nodes

In the MVP there is one active core and a number of peripheral nodes that register through a pairing code, connect with WebSocket, and offer two capabilities: `system.info` and `shell.exec`. Core failover, remote filesystem and browser are deferred.

### Pairing

1. The owner types `/pair` in the TUI. The core makes an 8-character code with `generatePairingCode()` from `eharness/identity` (alphabet without `0 O 1 I L`), stores its `hashPairingCode()`, valid for 10 minutes (stricter than the eharness default of 1 hour), single use. Input is normalized with `normalizePairingCode()`. Code storage (`pairing_codes`) and binding to the node are still written in `modules/nodes`, because eharness' `PersonStore` is for people, not devices.
2. On another machine: `bun apps/node join --core ws://<host>:7420 --code ABCD-EFGH`.
3. The core gives the node a random token. The node stores it in `~/.keith/node.json`; the core stores only its hash.
4. Later connections only need the token. The owner can revoke a node from the TUI.

### Protocol (in `packages/contracts`)

| Message | Direction | Content |
| --- | --- | --- |
| `hello` | node → core | `nodeId`, token, manifest |
| `welcome` | core → node | Accepted or rejected, heartbeat interval |
| `heartbeat` | node → core | Every 10 seconds; no heartbeat for 30 seconds = offline |
| `invoke` | core → node | `callId`, capability, input |
| `progress` | node → core | Output chunk (stdout) |
| `result` | node → core | `callId`, success or error, truncated output |
| `cancel` | core → node | `callId` |

The manifest holds the name, OS, architecture, version, and the list of capabilities with their risk (`read`, `write`, `external`, `destructive`), using eharness' risk terms so they match the approval rules directly.

### Motor

Cortex calls the tool `motor_remote({ node, capability, input })`. Motor checks that the node is online and the capability exists, then the tool.approve hook reads that capability's risk from the manifest (a tool's risk differs per call, so it cannot be static in the metadata), so `shell.exec` automatically goes through Amygdala (user approval). A call has a 120-second timeout and the output is truncated before it enters the model context. Longer operations will later move to eharness' `externalTool` so the turn can park.

A node also has its own policy in `node.json` (for example `allowShell`, working directory). So even when the core has granted permission, the node can still refuse. The core itself registers as the node `core` in-process, so Cortex uses the same path for the local machine and remote ones.

The MVP connection has no TLS and is only for localhost or a private network such as Tailscale. TLS and mTLS come before nodes are used on an open network.

## Client and TUI

The TUI is an ordinary client: it only talks through `packages/client` to the core's HTTP, the same as the web UI later. Its UX has two focuses: chat that feels instant, and a brain panel that makes Keith's work visible.

### Client SDK

`packages/client` wraps `eharness/client` (`createChatSession`, `createActivityFeed`, `createAttentionList`) and adds Keith contract calls: node list, task list, pairing. `eharness/client` reads streams through `fetch`, not `EventSource`, so it can run on Bun. This still has to be proven in the first milestone.

MVP authentication: when the core first boots, it prints the owner token once. `bun run tui login` stores it in `~/.keith/client.json`, and every request carries `Authorization: Bearer`. The `authorize` hook in `createHarnessHttp` checks that token.

### Layout

```text
╭─ KEITH ─ core online · 2 nodes · claude-haiku / sonnet ────────────────────╮
│ Chat                                       │ Brain                          │
│                                            │ ● Thalamus   ◐ Cortex ×1       │
│ you   find a 14" laptop under 15M          │ ○ Wernicke   ○ Motor           │
│ keith Sure sir, looking for it now.        │ ○ Broca      ○ Amygdala        │
│ you   show me today's news please          │ ○ RAS        ○ Hippocampus     │
│ keith Here are the top five stories…       │ › cortex.research step 4       │
│ ◆ keith Sir, the laptop search is done…    │ Tasks                          │
│                                            │ ◐ agent-1 laptop 14"   02:13   │
│                                            │ Nodes                          │
│                                            │ ● core  ● laptop-e  ○ server-b │
├────────────────────────────────────────────┴────────────────────────────────┤
│ ›  _                                                                        │
╰─ Tab focus · Ctrl+B brain · Ctrl+T tasks · Esc stop · / commands ───────────╯
```

### UX behavior

- **Streaming chat**: text appears per token, markdown is rendered, proactive messages are marked with `◆`.
- **Brain panel**: a region lights up on an event and dims within 1.5 seconds. The bottom line shows the latest event. `/brain trace` opens the full timeline for demos and debugging.
- **Tasks**: status (waiting, running, needs permission, done, failed), elapsed time. Enter on a task opens its report.
- **Approval**: shows as a bar above the input with a summary of the action (node, command). Key `y` allows, `n` denies, `a` allows for the session.
- **Commands**: `/pair`, `/nodes`, `/tasks`, `/brain trace`, `/new`, `/help`.
- **Resilience**: if the connection drops, the TUI reconnects and resumes the running turn through `chat.resume`. A narrow terminal (under 100 columns) stacks the panels below the chat.

Ink implementation reference: `examples/coder/src/ui` (input, stream rendering, approval dialog).

## Storage

All core state lives in one SQLite file `data/keith.db` (Drizzle on top of `bun:sqlite`, WAL mode, 5-second `busy_timeout`), while the agent's working content is plain files in `data/`. The SQLite adapters for eharness are adapted from `examples/team/server` and then proven with the conformance suite from `eharness/testing`.

### Tables

| Table | Owner | Main content |
| --- | --- | --- |
| `eh_messages` | eharness adapter | `session_id`, `message_id`, order, `UIMessage` JSON |
| `eh_states` | eharness adapter | `session_id`, state JSON, version for compare-and-set |
| `eh_inbox_items` | eharness adapter | Queue, steer and wake items that survive restarts (needed by background reports) |
| `activity_records` | `ActivityStore` | `seq`, `type`, `session_id`, `agent_id`, payload; eharness events and brain events together |
| `people` | Keith | MVP: one row, the owner |
| `client_tokens` | Keith | TUI token hash, owner, revoked time |
| `nodes` | Keith | Name, OS, version, manifest JSON, token hash, status, `last_seen_at` |
| `pairing_codes` | Keith | Code hash, `expires_at`, `used_at` |
| `config_profiles` | eharness `ProfileStore` | `kind`, `id`, `definition_id`, label, settings (secrets sealed by `SecretVault`), `enabled`. One table for provider connections now and other connections (connectors, channels) later |
| `catalog_cache` | eharness `CatalogCache` | Public model catalog (OpenRouter, models.dev): prices and context windows |
| `settings` | Keith | Key-value: model per role (`front`, `cortex`), default provider |
| `tasks` | Keith | Task id, parent and child session, worker type, description, status, result summary |

The eharness stream log (for resume across restarts) uses the in-memory adapter in the MVP. Resume still works as long as the core does not die. Superseded: see ADR-0011 for the adapters and the eharness 0.14.1 pin.

### Files

```text
data/
  keith.db
  workspace/          Cortex workspace (nodeWorkspace + diskFs), the only folder agents may write
  memory/owner/       root of the owner's memory() plugin
  logs/               structured logs, daily rotation
```

Migrations are made with `drizzle-kit generate` and run as a separate step (`bun run db:migrate`), not automatically at boot, following the repo standard.

## Local layer on top of eharness

Everything eharness 0.9 does not provide is built in `packages/eh-ext`, using only the public eharness API, in eharness naming style (`definePlugin`, port + in-memory adapter + test). No patches to `node_modules` and no PRs to eharness during the MVP. Superseded: ADR-0011 moves generic gaps upstream; the pin is eharness 0.14.1.

| Part | Shape | Why local | Future |
| --- | --- | --- | --- |
| `sqliteStorage()` | Adapters `MessageAdapter`, `StateAdapter`, `SessionLock`, `InboxAdapter`, `ActivityStore`, `ProfileStore`, `CatalogCache`. Lives in `packages/db` (not `eh-ext`) because it needs its tables, and only the core may use `packages/db` | eharness ships only in-memory adapters; database adapters belong to the product | Stays in Keith (repo standard and ADR-0062) Superseded: eharness 0.14.1 ships SQLite adapters (`src/sqlite/`); ADR-0011 plans them upstream. |
| `brainEvents()` | Plugin: hooks → `brain.*` events to the activity store | Brain naming is specific to Keith | Stays in Keith |
| `taskBoard()` | Plugin: `tool.after` hook on `agent` + reminder in `step.prepare` | The eharness background registry is in memory per session | Compare with "shared task lists" on the eharness roadmap |
| `proactive()` | Plugin: marks messages from `wake` turns with the data part `keith.proactive` | RAS policy is product-specific | Stays in Keith |
| `remoteMotor()` | Tool `motor_remote` + `tool.approve` hook that reads risk from the manifest | eharness risk is static per tool | Candidate for a remote `Sandbox` driver later |

Working rules:

- Every file in `eh-ext` starts with a one-line comment: why it lives here and which eharness module replaces it, if any.
- eharness bugs are handled with a workaround in `eh-ext` plus a test that reproduces it, then recorded in the Gotchas section of `AGENTS.md`. Superseded: ADR-0011 (fix upstream, adopt by upgrade).
- When eharness releases a new version, check the "Future" column and delete what is now available upstream. A feature that another product turns out to need is only then discussed for promotion, following the two-consumer rule.

## Extension points (dynamic registries)

Keith will be extended through plugins. So things that will grow later must not be hardcoded in the core. Each of them has a **registry**: the core and plugins register *definitions* (code), while the user creates *instances* (data) through a form generated from the definition's zod schema. The TUI and the future web UI do not need to know each provider's specific fields. They just render a form from the `formSpec` the core sends.

The pattern comes from `eharness/providers` (spec 23) and `eharness/connectors` (spec 24), exactly like `examples/team`.

| Registry | Definition (code, from core or plugin) | Instance (data, user-created) | eharness module | Milestone |
| --- | --- | --- | --- | --- |
| Model provider | `ProviderDefinition`: id, label, settings schema, `create`, `listModels`, `test` | Connection (`ProviderProfile`): provider, label, settings (`apiKey`, `baseURL`, `headers`, extra fields), list of allowed models | `eharness/providers`: `createProviderManager`, `openRouterProvider`, `formSpec`, `sealedProfileStore`, `webCryptoVault` | M1 |
| Model | Obtained from the provider's `listModels` + the public catalog (prices, context windows) | Model choice per role (`front`, `cortex`) as `profile:model` | `manager.models()`, `manager.catalog()` | M1 |
| Connector (MCP, outside services) | `ConnectorDefinition` | Connection + credentials (OAuth, API key) | `eharness/connectors` | After the MVP |
| Cortex worker type | Subagent catalog (`cortex.general`, `cortex.research`, …) | Enabled/disabled per owner | `subagent()` catalog | M2 |
| Node capability | Node manifest (`system.info`, `shell.exec`, …) with risk | Paired nodes | Keith (`modules/nodes`) | M3 |
| Host plugin | `KeithPlugin`: routes, WebSocket channels, assets, registered providers/connectors/workers | Active plugins | Keith (`packages/host`) | Contract in M1, full loader after the MVP |

Rules:

- **OpenRouter is the first and default provider** (`openRouterProvider` + `@openrouter/ai-sdk-provider`). Other providers (OpenAI, Anthropic, OpenAI-compatible for local servers) only need to be registered as extra definitions, without changing the flow.
- User credentials are stored in `config_profiles` and sealed with `webCryptoVault` (AES-256-GCM). The key is `KEITH_SECRET_KEY`; in dev mode, the key is created once in `data/secret.key`. Secrets are never sent to the client: the API only returns redacted profiles (`{ set: true, hint: '…abcd' }`).
- The `OPENROUTER_API_KEY` environment variable becomes a read-only connection (`source: 'env'`), suited to servers without a UI.
- Changing `baseURL` clears the stored secret (default eharness behavior), so the key is not sent to the new host.
- Plugins register definitions through `@keith/host` (for example `host.providers.register(def)`). The core does not import plugins.

## Milestones

The MVP is split into five sequential milestones. Each milestone closes with a gate that can run as a test or eval, following the repo standard principle that every change has evidence. Dates are not set yet.

The original diagram was lost when P0 was exported to Markdown. This table is its reconstruction, approved by viandwi24 on Oct 26, 2026.

| Milestone | Content | Gate |
| --- | --- | --- |
| M0 Repo foundation | Monorepo, machine gates, CI | `bun run check` green on a clean clone and in `act` (done, `docs/plans/done/P1-m0-foundation.md`) |
| M1 End-to-end chat | eharness SQLite adapters, provider registry (OpenRouter) + connections + model choice, front agent through `eharness/http`, owner token, `packages/client`, streaming chat in the TUI, oRPC skeleton, `/health` with version + SHA | End-to-end test with a fake model: client → core → stream back; history survives a restart; a provider connection is created through the API with no secret leaking to the client |
| M2 Visible brain | Cortex as a background subagent, task board, RAS (proactive reports), brain events + activity feed, brain and task panels in the TUI | The "find A" scenario: immediate answer, the user can keep chatting, the result arrives on its own |
| M3 Nodes and Motor | Pairing, node daemon, heartbeat, `motor_remote`, Amygdala approval in the TUI | `shell.exec` on another node runs after approval, and is refused otherwise |
| M4 Hardening | Hippocampus, reconnect/resume, cost budget, the "show me the news" eval | Eval passes; the TUI recovers after a dropped connection (done, `docs/plans/done/P5-m4-hardening.md`) |

Milestone 2 is the core of the MVP: at this point the brain abstraction can be seen working from the TUI. M3 and M4 extend and harden it.

Status Oct 26, 2026: M0 through M4 are implemented. The M4 gate evidence is in `docs/plans/done/P5-m4-hardening.md`; all that remains is the "show me the news" eval with a real model, which viandwi24 runs with his OpenRouter key. P6 "Ready to test" (`docs/plans/done/P6-ready-to-test.md`) closes the security review, the smoke test, and the manual testing guide `docs/manual-testing.md`; next, viandwi24 tests with that guide.

## Starting the repo

This design is enough as the master plan. Per-milestone plans are not written now, but made by the agent at the start of each milestone from this document, reviewed, then executed. Plans written long before the work go stale quickly, and the repo standard asks for active plans to stay short.

### Repo contents before init

```text
keith/
  docs/
    plans/active/P0-mvp.md      this document (Markdown export), already contains the repo standard
```

Note: the `eharness` package on npm contains only `dist`, no `docs/`. The agent needs to read the specs and examples from its GitHub repo. The safest way: clone it to `.ref/eharness` (gitignored) at tag `eharness@0.9.0`.

### Workflow per milestone

1. **Plan:** the agent reads P0 and writes `docs/plans/active/P<n>-<name>.md` with steps, exact commands, and the evidence for its gate. The agent stops here.
2. **Review:** you read and correct the plan.
3. **Execute:** the agent works the plan until `bun run check` is green and the gate evidence is attached.
4. **Close:** the plan moves to `docs/plans/done/`, new gotchas are recorded in `AGENTS.md`.

### First prompt (M0)

```text
Read docs/plans/active/P0-mvp.md to the end, including the "Repo standard" sections at the end.
Clone https://github.com/viandwi24/eharness into .ref/eharness at tag eharness@0.9.0
(add .ref/ to .gitignore) and use it as a reference, especially examples/team and examples/coder.

This session's task is ONLY to write the plan for milestone M0 "Repo foundation" in
docs/plans/active/P1-m0-foundation.md. Do not run any scaffold and do not write code.

The plan must contain:
- The order of OFFICIAL scaffold commands per part, following the "Official scaffold commands"
  table in P0. Before writing each command, check that tool's latest documentation (--help or
  its official docs) and write the version that will be used. You must not hand-write
  package.json, tsconfig or entrypoints when an official generator exists.
- The list of files that really have no generator (AGENTS.md, CLAUDE.md, ADRs, ARCHITECTURE.md,
  boundaries config, the check-size script) with an outline of their content.
- The content of bun run check and the ci.yml workflow.
- The M0 gate evidence: check green in CI.
- Things that wait for my decision ([DECIDE]) as a list of questions at the end.

When the plan is done, summarize it in 10 lines and wait for my approval.
```

After the plan is approved, the next prompt can simply be: `Run docs/plans/active/P1-m0-foundation.md. Done means bun run check is green; attach its output.`

### Prompt for the next milestones

```text
Milestone M<n> "<name>" starts. Read P0 (the milestones section and relevant parts), AGENTS.md,
and the plans in docs/plans/done/. Write docs/plans/active/P<n+1>-m<n>-<name>.md: steps per module,
official commands for new packages or apps, the tests that prove the M<n> gate, and risks.
Do not execute anything. Summarize in 10 lines then wait for my approval.
```

### Official scaffold commands

Versions checked on npm as of Oct 26, 2026. The agent must still re-check at init.

| Part | Official command | Notes |
| --- | --- | --- |
| Monorepo (Bun workspaces) | `bun init -y` at the root, then `workspaces` through `bun pm pkg set` | Bun 1.4.2. Turborepo is not used in the MVP (ADR-0005) |
| Biome | `bunx @biomejs/biome init` | Biome 2.6.3, replaces ESLint/Prettier from the starter |
| `apps/core` | `bun create hono@latest apps/core --template bun --pm bun` | create-hono 0.19.5 |
| `apps/tui` | `bunx create-ink-app --typescript apps/tui` | create-ink-app 3.0.2, Ink 8. Replace its default tooling (test runner, linter) with `bun test` and Biome |
| `apps/node` and every `packages/*` | `bun init -y` in its folder | The official Bun generator for an empty project |
| `apps/web` (ADR-0035) | `bunx sv create apps/web --template minimal --types ts --install bun` | sv 1.1.1, replaces `create-svelte`. Official add-ons through `--add`, for example `tailwindcss` |
| Changesets | `bunx changeset init` | @changesets/cli 3.0.3 |
| eharness | `bun add eharness@0.9.0 ai zod` in `apps/core` | Per the eharness README; `@ai-sdk/mcp` only when using MCP |
| Drizzle | `bun add drizzle-orm` + `bun add -d drizzle-kit` in `packages/db` | No project generator; `drizzle.config.ts` follows the Drizzle docs for `bun:sqlite` |
| commitlint | `bun add -d @commitlint/cli @commitlint/config-conventional` | No generator; a one-line config per the commitlint docs |

Only files that really have no generator may be hand-written: documents (`AGENTS.md`, `CLAUDE.md`, ADRs, specs, plans), config for tools whose docs ask for a manual file (`drizzle.config.ts`, `commitlint.config.js`, and internal scripts such as `check-size` and `check-imports`). This rule is written as a hard rule in `AGENTS.md` from M0.

## Toward the desktop-web sandbox

Desktop-web will later be treated as a **display node**: the web UI registers like any other node, with the capability to show something on screen. That way, "show today's news on the screen" uses the Motor path already built in the MVP, with no new mechanism.

Example display node capabilities:

| Capability | Input | Example |
| --- | --- | --- |
| `display.window.open` | Window type, title, position | Opening a news window |
| `display.text.show` | Markdown | Summary of search results |
| `display.image.show` | URL or blob | Product image |
| `display.map.show` | Coordinates, markers | Location map |
| `display.media.play` | Video URL | A viral YouTube video |
| `display.window.close` | Window id | Tidying the screen |

MVP decisions that prepare for this phase:

- **Equal clients.** The TUI uses only `packages/client`, so the web UI gets exactly the same access.
- **Client-agnostic brain events.** The TUI's brain panel and the web visualization read the same stream.
- **Manifest-based Motor.** A new capability only needs to be declared in the node manifest, with no change to Cortex.
- **The host plugin contract already exists.** The future web UI plugin registers routes, WebSocket channels, static assets and display capabilities through the same contract. eharness also has per-request client tools and page context (ADR-0028), which suit a window that is currently open.
- **Open worker types.** The plan to merge well-known harnesses can enter as a new Cortex worker type, for example through AI SDK Harnesses (`@ai-sdk/harness`), which wrap an existing harness.

One thing needs confirmation: which reference the desktop-web phase should follow. The need is not included in this design.

## Risks and open questions

| Risk | Impact | Handling |
| --- | --- | --- |
| `eharness/http`, `client`, `activity` are still Draft | The API may change on upgrade | Pin exactly `0.9.0`, upgrade deliberately in its own PR. Once data is stored, do not downgrade: 0.9 stores `media-ref`, which 0.8 cannot read |
| `eharness/client` is not yet proven on Bun/Ink | The TUI is delayed | Spike in the first milestone; fallback: read the stream directly with `readUIMessageStream` like `examples/coder` |
| `eharness/providers` and `connectors` are still Draft | The profile shape may change on upgrade | Pin `0.9.0`; the `ProfileStore` adapter is tested with `profileStoreConformance` |
| Delegation cost multiplies | The model bill balloons | `budget.maxTurnUsd` and `maxSessionUsd` in Cortex, at most 3 workers running at once |
| Remote shell without TLS and sandbox | Nodes could be abused | Only localhost or Tailscale, `shell.exec` always asks permission, `allowShell` is off by default on the node |
| The front layer claims success too early | Keith lies about status | Firm instructions + the "show me the news" scenario eval before the MVP counts as done |
| Scope creep | The MVP never finishes | Repo standard principle no. 7: a feature without a user does not go in |

Questions that need a decision:

- [x] Open source or private repo, and the license (ADR-0001): public, MIT. Superseded Nov 14, 2026: CC BY-NC-SA 4.0 (source-available, non-commercial, share-alike).
- [x] Keith API contract (ADR-0003): oRPC.
- [x] Model provider (Oct 26, 2026): OpenRouter as the first and default provider; other providers through the registry. Each role's model is chosen by the user from the connection's model list.
- [x] TUI to a core on another machine (Oct 26, 2026): not in the MVP; localhost or Tailscale, TLS together with the web UI.
- [ ] Which reference the desktop-web phase should follow.

## Repo standard: principles and working with agents

This section and the next two are adopted from an earlier repo standard, trimmed to what is relevant for Keith (no mobile, Next.js or Postgres). The folder structure and dependency rules are in the "Repo structure and conventions" section above.

### 10 core principles

1. **What a machine enforces beats what is written in prose.** An important rule = lint, script, hook or CI.
2. **Contract first, code later.** Schemas and specs are the source of truth; code that differs from the spec means one of them is updated in the same PR.
3. **One feature = one folder.** Route, service, repo, schema, test and the feature README live close together.
4. **Small files, narrow interfaces.** File size limits are checked by CI; a module exposes a small public API through `index.ts`.
5. **Short, layered agent instructions.** The root `AGENTS.md` is ±100 lines as a map; details live in per-app or per-package `AGENTS.md`, skills and docs.
6. **Every change has evidence.** Typecheck, lint, tests and, for UI, a recording or screenshot must be green before it counts as done.
7. **A new feature needs a user.** No feature without a clear user or screen.
8. **Main is always releasable.** After the MVP, every change goes through a PR with green CI.
9. **Versions are produced by a process, not typed by hand.** Changeset → release bot → tag + changelog.
10. **Reference content is not invented by agents.** Reference data is taken from verified sources and stored with attribution.

### Lessons from eharness and earlier projects

| Keep | Avoid |
| --- | --- |
| Specs as contracts, plus ADRs | Scope creep: an example that grew 2.7× the library |
| `check-imports`, `check-cycles`, `exports-snapshot` | God files: 2,000–6,000 lines per file |
| One source of truth, generated files must not be edited | Features spread per layer, not per feature folder |
| Simulator or recorded tests, example code is tested too | A bloated `AGENTS.md`, path lists written in prose |
| A "Known gotchas" list | Tests named by time (`v03-final`), giant commits, piled-up plans |

### Where to put what

| Content | Place | When loaded |
| --- | --- | --- |
| Repo map, commands, hard rules, gotchas | Root `AGENTS.md` (±100, max 200 lines) | Always |
| Local rules of an app or package | `apps/x/AGENTS.md`, `packages/y/AGENTS.md` | When working in that folder |
| Repeated workflows | `.claude/skills/<n>/SKILL.md` | When used |
| Why something is this way | `docs/decisions/` (ADR) | When referenced |
| Behavior contracts | `docs/specs/` | When touching that module |
| Rules that must always run | Hooks, lint, CI | Automatically |

`CLAUDE.md` contains only `@AGENTS.md`, so every coding agent reads one source.

### `AGENTS.md` template for Keith

```markdown
# AGENTS.md — keith

Keith: a personal agent harness (core node, peripheral nodes, TUI client) built on eharness.

## Map
| Need | Read |
|---|---|
| MVP design and milestones | docs/plans/active/P0-mvp.md |
| Architecture and brain-region names | docs/ARCHITECTURE.md |
| Contract of the module you touch | docs/specs/<module>.md |
| Why a decision was made | docs/decisions/ |
| Active plan | docs/plans/active/ |
| eharness source, specs, examples | .ref/eharness (tag eharness@0.9.0) |

## Commands
bun install · bun run dev · bun run check · bun run db:migrate · bunx changeset

## Hard rules
1. Specs are contracts: change the code → change the spec in the same commit.
2. Shared types come only from packages/contracts.
3. A feature = a folder in modules/ or features/; import other features only through index.ts.
4. apps/tui talks to core only through packages/client.
5. Use eharness as published (0.9.0). No patches to node_modules; gaps go to packages/eh-ext. Superseded: the pin is now eharness 0.14.1 (ADR-0011).
6. Scaffold with official generators after reading their current docs; never hand-write
   package.json, tsconfig or entrypoints that a generator creates.
7. Never edit generated files or lockfiles by hand.
8. Done = `bun run check` passes + evidence in the report.

## Gotchas
- The eharness npm package ships dist only; read docs/specs in .ref/eharness.
- run_in_background is only offered in root sessions (the front session).
```

### Flow of one feature

1. A short spec in `docs/specs/` and the `packages/contracts` change come first. Big features: a plan in `docs/plans/active/`.
2. A clean session, one feature folder. Clear the context between unrelated tasks.
3. Gate: `bun run check` through a Stop hook or CI; the agent must not declare done before it is green.
4. Review by another session or agent that did not see the work happen, plus human review.
5. A mistake repeated twice → a gotcha line; repeated again → a lint or test, then delete the prose line.

### Suggested hooks

| Hook | Content |
| --- | --- |
| After a file edit | Format + lint the changed file |
| Stop / before finishing | `bun run check` must exit 0 |
| Before a shell tool | Block `git push --force`, `rm -rf`, `git reset --hard` |
| Before an edit | Block generated files and lockfiles unless asked |

## Repo standard: code, commits, branches, versions

One command `bun run check` runs all the gates; CI runs the same command, so green locally means green in CI.

### Automatic gates

| Gate | Tool | Rule |
| --- | --- | --- |
| Format | Biome | Format on save + hook |
| Lint | Biome | `noExplicitAny`, `noUnusedImports`, `useImportType`, no `console` outside the logger |
| Typecheck | `tsc --noEmit` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Boundaries | `scripts/check-imports.ts` (Bun's built-in parser and resolver) | The dependency rules in the repo structure section |
| File size | `check-size` script | Warning above 400 lines, failure above 800 (generated files excluded) |
| Tests | `bun test`; eharness conformance suite for adapters | Every feature or fix commit includes a test |
| Commit message | commitlint | Conventional Commits |
| Changeset | CI | Required when changing released behavior (after the MVP) |
| Secrets | gitleaks or GitHub secret scanning | No keys in the repo |
| Dependencies | Dependabot + `bun audit` (built into Bun, in CI at level `high`) | Weekly updates, grouped; `eharness` is excluded from auto-update |

### Naming

| Thing | Style | Example |
| --- | --- | --- |
| Files and folders | kebab-case | `task-board.ts`, `motor.service.ts` |
| React (Ink) components | PascalCase | `BrainPanel` |
| Functions and variables | camelCase, verbs for functions | `delegateTask`, `isOnline` |
| Global constants | SCREAMING\_SNAKE | `HEARTBEAT_INTERVAL_MS` |
| Types and schemas | PascalCase, schemas end in `Schema` | `NodeManifestSchema`, `type NodeManifest = z.infer<…>` |
| DB tables | plural snake\_case | `pairing_codes` |
| Env vars | `KEITH_` prefix | `KEITH_DATA_DIR` |
| Tests | `<file>.test.ts` next to the code, named by feature | `pairing.test.ts` |

### Code writing rules

1. Validate at every boundary (HTTP, WebSocket, env, storage) with a schema from `contracts`; inside a module, trust the types.
2. Expected errors are returned as values (`Result` or error codes); throw only for bugs.
3. Env is read once in `platform/config` through a schema; scattered `process.env` is forbidden.
4. No big barrel files; a module's `index.ts` exports only the public API.
5. Exported functions have an explicit return type.
6. A new runtime dependency needs a reason in the commit or PR (an ADR if big).
7. Comments explain why, not what.

### Conventional Commits

```text
<type>(<scope>): <summary, imperative mood, lower case>

type : feat | fix | perf | refactor | docs | test | build | ci | chore | revert
scope: app, package or module name, e.g. core, tui, node, contracts, db, eh-ext, cortex, motor
BREAKING: add "!" (feat(contracts)!: …) + footer "BREAKING CHANGE: …"

examples:
feat(cortex): run delegated tasks as background subagents
fix(tui): keep the brain panel in sync after reconnect
```

### Branches

| Model | Branch | When | Status in Keith |
| --- | --- | --- | --- |
| A. Solo MVP | `main`, direct push allowed | No users yet, version 0.x | **Used now** |
| B. Trunk + PR | `main` + short-lived feature branches | Maintenance phase | After the MVP is in use |
| C. dev → main | `dev` (staging) + `main` | There is a staging that testers really use | Not needed yet |

Branch names (model B): `feat/<scope>-<name>`, `fix/<scope>-<name>`, `chore/…`, `docs/…`, `hotfix/<name>`. Maximum age a few days. Merge features into `main` with squash; PR title = Conventional Commit.

A private repo on GitHub Free has no branch protection or rulesets. If it is private and not upgraded, enforce locally: a `pre-push` hook that rejects pushes to `main` in model B, with CI still running on every PR.

### Versions

SemVer `MAJOR.MINOR.PATCH`, staying at 0.x during the MVP; it goes to 1.0.0 when the core flow is used for real and ready to keep compatible. In 0.x, a breaking change bumps MINOR, new features and fixes bump MINOR or PATCH.

- **What is versioned:** Keith releases as a whole (tag `v0.x.y`). The core's `GET /health` returns the version + commit SHA.
- **Not versioned on their own:** internal packages (`packages/*`); Changesets uses `privatePackages` only for the changelog.
- **Node protocol:** the `hello` message carries the protocol version. The core rejects nodes with a version below `minSupportedProtocol`, because an old node can keep running on another machine.
- **Database:** schema changes use the expand → migrate → contract pattern.
- **Release tool:** Changesets (repo standard default).

## Repo standard: templates, CI, checklists

The templates below are made in M0 and stored in `.github/`. Action versions follow the repo standard as of Oct 25, 2026; the agent re-checks at init.

### `.github/pull_request_template.md`

```markdown
## What & why
<1–3 sentences. Link the plan/spec: docs/plans/active/P2-m1-chat.md · docs/specs/nodes.md>

## Type
- [ ] feat  - [ ] fix  - [ ] refactor  - [ ] docs/chore
- [ ] Breaking change (describe the migration below)

## Evidence
<`bun run check` output, TUI recording, or manual test steps>

## Checklist
- [ ] PR title follows Conventional Commits
- [ ] Tests added/updated for the behaviour
- [ ] Spec/ADR updated if a contract or decision changed
- [ ] Changeset added (if released behaviour changed)
- [ ] No generated files or lockfiles edited by hand
- [ ] DB migration is backward compatible (expand → contract)

## Built with an AI agent?
- [ ] Yes — I have read the whole diff and run the checks myself
```

### `.github/ISSUE_TEMPLATE/bug.yml`

```yaml
name: Bug
description: Report something that behaves wrongly
labels: [bug]
body:
  - type: textarea
    id: what
    attributes: { label: What happened, description: Short steps to reproduce }
    validations: { required: true }
  - type: textarea
    id: expected
    attributes: { label: What you expected }
  - type: input
    id: version
    attributes: { label: Keith version, placeholder: 0.3.0 (sha abc1234) }
  - type: dropdown
    id: part
    attributes: { label: Part, options: [Core, Node, TUI, Web UI] }
```

Also make `feature.yml` with these fields: the problem it solves, **who the user is**, and alternatives. The "who the user is" field is the brake on scope creep.

### `.github/CODEOWNERS` and changeset

```text
*    @viandwi24
```

```markdown
---
"@keith/core": minor
"@keith/contracts": minor
---

cortex: run delegated tasks as background subagents
```

### `.github/workflows/ci.yml`

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: PR title (Conventional Commits)
        if: github.event_name == 'pull_request'
        env: { TITLE: "${{ github.event.pull_request.title }}" }
        run: echo "$TITLE" | bunx commitlint
      - run: bun run check        # lint, typecheck, test, boundaries, check-size, exports
      - run: bun run build
```

`TITLE` goes through env, not inserted directly into `run`, so a PR title cannot inject shell commands. The `release.yml` workflow (Changesets) is added only when moving to model B; Docker deploy is not needed yet because the core runs on a personal machine.

### Day-one checklist (M0)

- [x] Scaffold with official commands ("Official scaffold commands" table) after reading their latest docs
- [x] ADR-0001 to 0004 in `docs/decisions/`
- [x] Root `AGENTS.md` (±100 lines) + `CLAUDE.md` containing `@AGENTS.md`
- [x] `docs/ARCHITECTURE.md`, `docs/specs/`, `docs/plans/{active,done}/`
- [x] `bun run check` = lint + typecheck + test + boundaries + check-size
- [ ] Agent hooks: format after edit, check before finishing, block destructive commands
- [x] `.github/`: `ci.yml`, PR template, issue template, CODEOWNERS
- [x] Changesets initialized with `privatePackages`
- [ ] Dependabot + `bun audit` + secret scanning enabled
- [x] `.env.example` + env config through a schema
- [x] `.ref/` and `data/` in `.gitignore`

### Entering the maintenance phase (after the MVP is in use)

- [ ] Turn off direct push; everything goes through a PR with green CI (model B)
- [ ] Add `release.yml` and start release tags through Changesets
- [ ] Audit unused features; delete them before adding new ones

### Every release

- [ ] The "Version Packages" PR has the right changelog
- [ ] DB migrations are backward compatible and run before the new code
- [ ] Node protocol version and `minSupportedProtocol` checked
- [ ] A rollback plan is written in the release PR
- [ ] After release: `/health` shows the new version
