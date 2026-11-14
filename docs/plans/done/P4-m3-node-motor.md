# P4 — M3 "Nodes and Motor"

Oct 26, 2026 · plan for milestone M3 of `P0-mvp.md` · status: **done** (Oct 26, 2026)

## Goal and limits

M3 is done when Keith can act on another machine with the owner's permission:

1. The owner types `/pair` in the TUI, then runs one command on the other machine. The node connects and shows online.
2. The owner asks, for example, "check the disk on laptop-e". Cortex calls `motor_remote`.
3. `shell.exec` always stops first and waits for permission. The approval bar shows in the TUI, and the owner presses `y`, `n` or `a`.
4. Once allowed, the command runs on the node, its output returns to Cortex, and the result reaches the owner. If denied, the command never runs.

In M3:

- The node protocol in `contracts`.
- Pairing.
- The `apps/node` daemon.
- The node registry: online/offline through heartbeat, revoke a node.
- The core as an in-process node `core`.
- The `motor_remote` tool.
- Amygdala: the attention queue over HTTP, and the approval bar in the TUI.
- The node panel and the `/pair` and `/nodes` commands in the TUI.

Not in M3:

- TLS/mTLS. Nodes are only for localhost or a private network such as Tailscale, per P0.
- Remote filesystem and browser on nodes.
- Core failover.
- Memory (M4).
- `externalTool` for commands longer than one turn.

## Decisions (CTO, Oct 26, 2026)

| Topic | Decision | Basis |
| --- | --- | --- |
| Node transport | The built-in WebSocket of `Bun.serve` (`server.upgrade` in `fetch` before Hono, Bun's own `websocket` handler). The `hono/bun` adapter is not used because it is deprecated | ADR-0006 (Bun first) |
| Node connection auth | Header `Authorization: Bearer <node token>` at upgrade; rejected with 401 before the upgrade. A random token, the core stores only the SHA-256 hash | P0 "Pairing" |
| Pairing | The oRPC `nodes.pair` creates a code (`generatePairingCode`), the hash is stored in `pairing_codes`, valid 10 minutes, single use, at most 3 active codes. The node exchanges the code through `POST /nodes/join` (not WebSocket) with a name and manifest, and gets a `nodeId` + token. `pairingGuard` limits 5 failed attempts per hour per IP | `eharness/identity` (spec 30 §4) |
| Protocol | zod messages in `packages/contracts/src/node-protocol.ts`, each message carries `v: 1`. The core rejects nodes with a version below `MIN_PROTOCOL` | P0 "Protocol" and "Versions" |
| Heartbeat | The node sends `heartbeat` every 10 seconds; no heartbeat for 30 seconds = offline. The status is stored in the `nodes` table and emitted as a `node-changed` event | P0 |
| Capabilities and risk | The core has a **static capability table**: `system.info` = `read`, `shell.exec` = `destructive` → always `user-approval`. The node manifest only states which capabilities are available; a capability the core does not know is rejected | The approval hook is called again at validation, so its decision must not depend on changing node status (spec 11) |
| `motor_remote` | An ordinary tool with `execute` (not `externalTool`): 120-second timeout, output truncated head+tail to 30,000 characters, `abortSignal` → a `cancel` message to the node, progress as temporary output (`AsyncIterable`) | Research of specs 09 and 11; `externalTool` is only needed when a command outlives a turn |
| Approval | The `tool.approve` hook on `motor_remote`: `read` → approved, `shell.exec` → `user-approval`, unknown capability → `denied`. Most-restrictive-wins beats the worker's `external: approved` rule | Spec 11 §3 |
| "Allow for the session" (`a`) | `tool.grantScope` returns `<node>:<capability>`, so the permission applies to that node and capability only, in that worker session only (one task) | The eharness default stores permission per tool, which would open `shell.exec` on every node |
| Node policy | `~/.keith/node.json` (mode 0600): token, `nodeId`, `allowShell` (default **false**), `workdir`. The node refuses `shell.exec` when `allowShell` is off, even if the core granted permission | P0 "Motor" |
| Shell execution on the node | `Bun.spawn(['/bin/sh', '-c', cmd])` in `workdir`, minimal env, kill the whole process group on timeout or `cancel` (SIGTERM then SIGKILL after 2 seconds), bounded output | Bun first; eharness' `localSandbox` follows if OS isolation is needed |
| Core as a node | An in-process node `core` with `system.info` and `shell.exec` (default `allowShell` false, set through `KEITH_CORE_ALLOW_SHELL`). Cortex uses the same `motor_remote` path | P0 |
| Who uses `motor_remote` | Only `cortex.general`. The front agent gets `nodes_status` (read) to answer "which nodes are online?" | P0 "Two agents" |
| Attention over HTTP | The `attention` option of `createHarnessHttp`: roots `front:<personId>`, `peek` and `open` pick the agent from the catalog key (`front`, `cortex.*`), activity `store`, `allowRemember: true`, `canAnswer` only for sessions owned by the principal. The `/attention*` routes are mounted on Hono | Spec 25/26; team pattern |
| Amygdala events | `brain.amygdala.wait` (permission waiting) from the library event `pending-changed`, the existing `brain.amygdala.decide` | P0 "Brain events" |
| TUI | An approval bar above the input (`createAttentionList` attached to the feed): a summary of node + command, `y` allow, `n` deny (optional reason), `a` allow for the session. `/pair` shows the code and the join command; `/nodes` lists nodes, `r` revokes. A Node panel in the right column | P0 "UX behavior" |

## Steps

Each step is done by a Sonnet 5.5 subagent, reviewed and committed in the orchestrating session. Steps 1 and 2 can run in parallel.

### 1. `packages/contracts`

- `node-protocol.ts`: `hello`, `welcome`, `heartbeat`, `invoke`, `progress`, `result`, `cancel`, `NodeManifestSchema`, `CAPABILITIES` (id, risk, input schema), `PROTOCOL_VERSION`, `MIN_PROTOCOL`.
- `nodes.ts`: `NodeSchema` (id, name, os, arch, version, capabilities, status, lastSeenAt), the `node-changed` event.
- `brain.ts`: the `brain.amygdala.wait` payload.
- oRPC `nodes.list`, `nodes.pair` (→ code + join command), `nodes.revoke`.

### 2. `packages/db`

The tables `nodes` (id, name, os, arch, version, manifest JSON, token_hash, status, last_seen_at, revoked_at) and `pairing_codes` (hash, expires_at, used_at, created_by); the repos and their migration.

### 3. `apps/core`

| Module | Content |
| --- | --- |
| `nodes` | Pairing (`nodes.pair`, `POST /nodes/join`), the Bun WebSocket gateway (auth at upgrade, `hello`/`welcome`, heartbeat, offline after 30 seconds), the registry and `invoke` with `callId` correlation, cancel, revoke (closes the connection); the in-process node `core`; the `node-changed` event; the oRPC procedures `nodes.*` |
| `motor` | `motor_remote` (check the node is online and the capability exists, invoke, progress, timeout, abort → cancel, truncate output), the `tool.approve` and `tool.grantScope` hooks, `nodes_status` for the front agent |
| `amygdala` | The `attention` option for `createHarnessHttp`, the `/attention*` routes, `brain.amygdala.wait` |
| `cortex` | `cortex.general` gets `motor_remote` |
| `compose.ts` / `main.ts` | The `websocket` handler in `Bun.serve`, upgrade before Hono, closing node connections on `close()` |

### 4. `apps/node`

`bun src/main.ts join --core http://<host>:7420 --code ABCD-EFGH [--name laptop-e]` saves `~/.keith/node.json`; `bun src/main.ts run` connects, sends `hello` + manifest, heartbeat, runs `invoke`, and reconnects with backoff. `system.info` (OS, CPU, memory, disk via `os`/`df`) and `shell.exec` (per policy). Unit tests for the executor (timeout, kill process group, truncate output, `allowShell` off).

### 5. `packages/client`

`attention()` (`createAttentionList` attached to `feed()`), answer helpers `approve`, `deny`, `approveForSession`.

### 6. `apps/tui`

The approval bar, `/pair`, `/nodes` (revoke with confirmation), the Node panel, the node count in the header. Ink tests with a fake core (`/attention`, `/rpc/nodes/*`, `node-changed` and `pending-changed` events) and one PTY test: an approval shows and `y` is sent.

### 7. Documents

Specs `nodes.md`, `motor.md`, `amygdala.md`, `node.md` (the daemon), updates to `thalamus.md`, `cortex.md`, `tui.md`, ARCHITECTURE, AGENTS.md (join/run commands, gotchas), and `SECURITY.md` (nodes without TLS only on a private network).

## M3 gate (evidence)

| Evidence | How |
| --- | --- |
| Pairing | `node-pairing.e2e.test.ts`: `nodes.pair` → a node (a real daemon process or an in-process client using the same code) joins with the code → gets a token; the same code is rejected the second time; an expired code is rejected; 6 failed attempts are blocked |
| Connection and heartbeat | The node connects over a real WebSocket, `nodes.list` shows online; heartbeat stops → offline after the limit (sped up in the test); wrong token → 401 with no upgrade; an old protocol version is rejected |
| Permission denied | A worker (scripted model) calls `motor_remote` `shell.exec` → an item shows in `/attention` with the node and command → the owner answers deny → the command **never** reaches the node, and the model receives a denied result |
| Permission granted | Answer allow → the node runs `echo keith-m3` → the output returns to the worker, and the task report reaches the owner |
| Allow for the session | `a` on the first call → the second call to the same node and capability does not ask again; to another node it still asks |
| Node policy | `allowShell: false` → the node refuses even when allowed |
| `system.info` | Runs without permission (risk `read`) |
| Cancel and limits | `tasks.stop` while a long command runs → the node receives `cancel` and the process dies; a command beyond the time limit → a timeout result; large output is truncated |
| Revoke a node | `nodes.revoke` → the connection is closed, the token is no longer valid |
| Core as a node | `motor_remote` to the node `core` through the same path |
| TUI | Ink tests: the approval bar with `y`/`n`/`a`, `/pair`, `/nodes`, the node panel; a PTY test for approval |
| `bun run check` | Green from a clean clone, in `act`, and `gitleaks` clean |

A real demo by viandwi24: pair a second laptop (or a second node process on the same machine with a different `HOME`), then "check the free disk on that node".

## Risks

| Risk | Handling |
| --- | --- |
| Remote shell is abused | `shell.exec` always asks permission, `allowShell` is off by default on the node, the `a` permission is limited per node + capability per task, no TLS so only on a private network |
| The approval hook is not deterministic | Risk comes from the core's static table, not from node status |
| Child processes are left behind | Kill the process group, a dedicated test |
| The WebSocket drops mid-command | A `node disconnected` result to the model, the node cancels its own process when the connection drops |
| A pairing code is guessed | 31⁸ possibilities, single use, 10 minutes, `pairingGuard` |
| Bun's idle timeout cuts the WebSocket | A 10-second heartbeat and a matching `idleTimeout` |

## Execution notes

Executed Oct 26, 2026. Each step was done by a Sonnet 5.5 subagent. The orchestrating session reviewed, re-ran its tests, then committed. Steps 1–2 and 3–4 each ran in parallel.

| Step | Finding | Handling |
| --- | --- | --- |
| 1 | `JoinRequestSchema` first accepted only exactly `ABCD-EFGH` | It accepts free text of 8–16 characters; the core normalizes with `normalizePairingCode` |
| 1 | The new contract made the core fail typecheck and the TUI fail on an event switch | A temporary `nodes.*` stub in the core; the TUI handles `brain.amygdala.wait` |
| 3 | eharness 0.9 applies a `remember: 'session'` permission only one step after the continuation, so the next call still asked | `motor_remote` keeps its own per-session memory `<node>:<capability>` from the `approval.decided` hook (only owner decisions, only grows, lost on restart) |
| 3 | A conflicting node name used up the pairing code | The name is checked before the code is used; the name `core` is reserved |
| 3 | The core waited `timeoutMs` + a margin before declaring a timeout | The node's timeout result usually arrives first |
| 3 | `brain.amygdala.wait` fits better as an `ActivityStore` wrapper than as a plugin | `watchPending` wraps the store compose uses |
| 3 | The RFC 6455 example `Sec-WebSocket-Key` in a test was blocked by gitleaks | Generated at runtime |
| 4 | `Bun.spawn({ detached: true })` creates a new process group | `process.kill(-pid)` kills the whole process tree |
| 6 | "Lock the bar when input is empty" could approve a command through a message like "yes" | The bar now takes keys only after `Tab` |
| 6 | The `/pair` countdown showed `10:01` for a 10-minute code | Round down and count from when the code was received |
| 7 | On Linux CI, a process that had been killed looked alive | A zombie (status `Z`, parent PID 1 in the act container does not reap); the process-group kill works. The test counts a zombie as dead |
| 7 | Some TUI tests were flaky when the CPU was busy | Wait for the right condition (answer recorded, activity line rendered, board refetched), with no fixed sleep; tested 20/20 under load |
| 7 | The SIGKILL test searched for `sleep 30` across the whole machine | A unique marker; the spawn wait is bounded with a message naming the step |
| — | An agent worktree inside the repo was read by Biome and tests | `.claude/worktrees/` is excluded from git, Biome and `bun test` |

Outside the plan, at viandwi24's request in the middle of M3: the **OpenAI** (`openAIProvider`) and **DeepSeek** (`@ai-sdk/deepseek`, a local definition) providers were added next to OpenRouter, with per-role default models checked in the models.dev catalog (commit `3208b6f`).

### M3 gate evidence

| Evidence | Result |
| --- | --- |
| Pairing | `node-pairing.e2e.test.ts`: a 10-minute code and join command; the same code is rejected the second time; an expired code is rejected; the 6th attempt is blocked; a conflicting name does not use up the code |
| Connection and heartbeat | Wrong token → 401 with no upgrade; an old protocol version is rejected; online/offline through heartbeat; a core restart leaves no fake online nodes |
| Permission denied | The `/attention` item holds the node and command; the node never receives the call; the model receives the denial; the Amygdala event lights up |
| Permission granted | The node runs the command, the output reaches the worker, the report reaches the owner as a proactive message |
| Allow for the session | The same node and capability are not asked again; another node is still asked |
| Node policy | `allowShell` off → the node refuses even when allowed |
| `system.info` | Runs without permission |
| Cancel and limits | `tasks.stop` → the node receives `cancel`; timeout; output truncated head+tail to 30,000 characters; progress as temporary output |
| Revoke a node | The connection is closed, the token is no longer valid; a running call fails with a clear message |
| Core as a node | The same path; the core's shell is off by default |
| Real daemon | `node-daemon.e2e.test.ts`: real `join` + `run` processes against a real core, `echo` in the workdir after permission, offline after SIGTERM, refusal without `--allow-shell` |
| TUI | The approval bar (`Tab` then `y`/`n`/`N`/`a`), `/pair`, `/nodes` + revoke, the Node panel, a narrow layout; a real PTY for approval |
| `bun run check` from a clean clone | Exit 0, 393 tests, 33 seconds; lockfile unchanged |
| Stability | The full suite 40/40 under moderate CPU load and 10/10 without load |
| `act push -j check` | Twice in a row: `bun run check` 393/0 and `bun audit` green; the post step of setup-bun failed because of the act environment |
| `gitleaks git` | No leaks |

Not yet proven: the demo with two real machines by viandwi24. One rare flake (a 90-second timeout of the PTY test running together with the SIGKILL test, 2 of ±37 runs while many agents were working) did not appear again in the next 50 runs; if it does, the new time limit names the step that got stuck.

## [DECIDE]

Nothing is required. One thing you can change before execution: whether `shell.exec` on the `core` node (the machine the core runs on) may be on by default. The plan default: **off**, turned on with `KEITH_CORE_ALLOW_SHELL=true`.
