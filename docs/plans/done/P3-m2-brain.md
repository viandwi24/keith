# P3 — M2 "Visible brain"

Oct 26, 2026 · plan for milestone M2 of `P0-mvp.md` · status: **done** (Oct 26, 2026)

## Goal and limits

M2 is done when the "find A" scenario from P0 runs end to end:

1. The owner asks "find A". Keith answers right away and hands the work to Cortex.
2. The owner can keep chatting about something else while Cortex works.
3. After Cortex finishes, Keith delivers the result of A on its own. The message is marked proactive (◆).
4. Meanwhile, the brain panel in the TUI lights up the active region, and the task board shows the status of every delegation.

In M2:

- Cortex: two worker types as background subagents of the front agent, `cortex.research` and `cortex.general`.
- The task board (the `tasks` module).
- RAS: the proactive message marker.
- Brain events in the eharness activity feed.
- A brain panel and a task panel in the TUI.
- Task recovery after a core restart.

Not in M2:

- `shell`, `motor_remote`, nodes and the approval panel (M3). Approval only becomes meaningful once there is an Amygdala UI, so high-risk tools are deferred to M3.
- Memory/Hippocampus (M4).
- Two-way `send_message` to workers, which is still Draft in eharness.

## Decisions (CTO, Oct 26, 2026)

| Topic | Decision | Basis |
| --- | --- | --- |
| Delegation pattern | Full **park** mode, following `examples/team`. The front agent uses `subagent({ agents, selfAgent, approvals: 'park', background: { default: true, timeoutMs: 3_600_000 }, maxDepth: 1, maxConcurrent: 3, outputTool: true, stopTool: true })`. Each worker is its own `HarnessAgent` with `subagent({ agents: {}, approvals: 'park', parentAgent, selfAgent, onPark: 'notice' })`. All agents share the same SQLite adapters | Spec 20 §park; only park survives a restart (eharness ADR-0046). `onPark: 'notice'` (new in 0.9) so a parked worker does not add model calls on the front agent |
| `messageTool` (`send_message`) | Deferred | Still Draft in eharness, and the M2 scenario does not need it. P0 is updated |
| Worker model | The `cortex` role through `roleModel('cortex')`, the same mechanism as the front agent. OpenRouter default: `anthropic/claude-sonnet-5.5` | ADR-0007 |
| `cortex.research` tools | `web_search` and `web_fetch` (`eharness/web`). `web_search` uses the OpenRouter `web` plugin through one `generateText` with a fast model, like `examples/team/server/src/infra/eh/web-search.ts`. Without a connection that can search, the tool is not offered | No extra API key |
| `cortex.general` tools | `web_search`, `web_fetch`, files in `data/workspace` (`eharness/filesystem/node`, root locked to that folder), and `todo_write` (`eharness/todos`) | P0 "Two agents", no shell (M3) |
| Approval in M2 | An `allow` policy for risk `read`, `write` (only in the workspace) and `external` (web). No `destructive` tools in M2 | The approval panel only arrives in M3 |
| Task board | A `tasks` table in `packages/db`. Task id = child session id. Filled by a `taskBoard()` plugin that runs **in the worker session**: `turn.start` (running), `step.end` (step n), `turn.end` (done/failed/waiting + summary), plus the result of `reconcileBackgroundChildren` | In park mode, the `agent` tool does not trigger `tool.after`; the only reliable source is a hook in the child session (`ctx.session.parent`) |
| "How far along is it?" | A plugin on the front agent: `step.prepare` returns a `reminder` with the list of active tasks from the `tasks` table | P0 "Task board"; a reminder does not break the prompt cache |
| Activity feed | An `events` table + `sqliteActivityStore` in `packages/db` (adapted from team, proven by `activityStoreConformance`). The plugin `activity({ store, messages: false })` on every agent. `createHarnessHttp` gets the option `activity: { store, bootId, filter: () => 'all' }` | Spec 25/26 |
| Brain events | The plugin `brainEvents()` writes `brain.<region>.<phase>` to the same store. The source is hooks, never `tool.before` (it can be called repeatedly). See the table below | P0 "Brain events" |
| RAS (proactive) | The plugin `proactive()` on the front agent marks a `kind: 'wake'` turn (or `source: 'event'`) with the event `brain.ras.deliver` and a `keith.proactive` data part on that turn's assistant message. The exact shape is proven in step 1 (spike) | P0 "The find A flow" no. 6 |
| Feed retention | Prune at boot and every 10 minutes: `keepLast: 10_000`, `olderThan: 7 days`, `keepLatestOf` for `brain.*.state` | Team pattern (`main.ts:658-700`) |
| Reconcile | `reconcileBackgroundChildren` at boot and every 60 seconds; `openChild` picks the agent from `info.agent` | Team pattern |
| Budget | Worker: `budget.maxTurnUsd = 1`, `maxSessionUsd = 3` (changeable through settings later). The default `toolCalls.maxIdenticalResults` of 0.9 stays active | The risk "delegation cost multiplies" in P0 |
| Feed in the TUI | `createActivityFeed` + `useActivityFeed` (`eharness/client/react`). At boot and on resync, the TUI fetches the task list through the oRPC `tasks.list`, because the feed sends no history | Spec 27 |

### Brain event map

| Event | When | Source |
| --- | --- | --- |
| `brain.thalamus.routed` | A chat message comes in and passes auth | Hono middleware on `POST /sessions/*/chat` |
| `brain.wernicke.start` | A front turn starts with user input (`kind: 'send'`) | `turn.start` hook of the front agent |
| `brain.broca.start` / `brain.broca.end` | The front agent starts/finishes answering | `turn.start` / `turn.end` of the front agent |
| `brain.cortex.start` / `.step` / `.end` | A worker starts, finishes one step, finishes | `turn.start` / `step.end` / `turn.end` in the worker session |
| `brain.motor.act` | An action tool runs (web, files) | `step.end.toolResults` in any session |
| `brain.amygdala.decide` | A permission decision (in M2 always from policy) | `approval.decided` hook |
| `brain.ras.deliver` | A worker report is delivered to the owner | The `proactive()` plugin |
| `task-changed` | A task row changes | The `taskBoard()` plugin |

Each event's payload is defined as zod in `packages/contracts/src/brain.ts`, one source for the core and the TUI.

## Versions

No new npm packages. All from `eharness@0.9.0`: `subagent`, `activity`, `web`, `filesystem/node`, `todos`, `client`, `client/react`, `testing`. If `web_search` needs an extra package, the step stops first and asks for a decision.

## Steps

Each step is done by a Sonnet 5.5 subagent with a brief from the orchestrating session, then reviewed and committed here. Steps 2 and 3 can run in parallel (different files); the rest are sequential.

### 1. Park + wake spike (core, tests only)

A test in `apps/core` with `scriptedProvider` proves:

- The front agent calls `agent` in the background then answers in the same turn.
- The worker finishes, and its report wakes the front agent (a wake turn).
- How to mark a wake message as proactive (a data part or metadata) that reaches `GET /sessions/:id/messages`.

The spike result decides the final shape of `proactive()`. If the finding differs from the plan, note it in "Execution notes" and adjust before continuing.

### 2. `packages/db`

- The tables `events` (seq `AUTOINCREMENT`) and `tasks`, then `bun run --filter @keith/db db:generate`.
- `src/eh/activity-store.ts` (`sqliteActivityStore`, adapted from team, MIT), proven with `activityStoreConformance`.
- `src/repos/tasks.ts`: `upsert`, `list({ parent, active? })`, `get`.

### 3. `packages/contracts`

- `brain.ts`: `BrainRegionSchema`, `BrainEventSchema` per type.
- `tasks.ts`: `TaskSchema` with status `queued | running | waiting | done | failed | stopped | timed_out`.
- The oRPC contract `tasks.list` and `tasks.stop`. The export snapshot is updated.

### 4. `apps/core`

| Module | Content |
| --- | --- |
| `cortex` | The worker catalog (`cortex.research`, `cortex.general`): agent, instructions, tools, budget; `web-search.ts` (search through the OpenRouter connection) |
| `tasks` | `taskBoard()` (hook in the worker session), the reminder plugin for the front agent, the oRPC procedures `tasks.*` |
| `ras` | `proactive()` |
| `brain-events` | `brainEvents()`, the Thalamus middleware, the event writer to the store |
| `wernicke-broca` | The front agent gets the lead `subagent(...)`, `activity()`, `brainEvents()`, `proactive()`, the task reminder; instructions on when to delegate |
| `thalamus` | The `activity` option in `createHarnessHttp`; the `brain.thalamus.routed` middleware |
| `compose.ts` | The activity store, reconcile at boot and periodically, periodic prune, closing timers on `close()` |

### 5. `packages/client`

`feed()` (`createActivityFeed`) and `tasks` through `rpc`. Brain event types from contracts.

### 6. `apps/tui`

- `src/features/brain/`: the region panel. A region lights up when an event comes in and dims within 1.5 seconds. The last line shows the latest event.
- `src/features/tasks/`: a task list with status and duration; Enter opens the result summary.
- Chat: proactive messages are marked `◆`; the text "Sent to the running turn" and other notices show as toasts.
- P0 layout: chat on the left, brain, tasks and nodes on the right. Under 100 columns, the panels stack below the chat. Commands `/tasks`, `/brain trace`; `Ctrl+B` and `Ctrl+T` open the panels.
- Ink tests with a fake core that also serves `/activity/stream`, plus one PTY test.

### 7. Documents

Specs `cortex.md`, `tasks.md`, `ras.md`, `brain-events.md`; updates to `thalamus.md`, `wernicke-broca.md`, `ARCHITECTURE.md`, and the P0 line about `send_message`.

## M2 gate (evidence)

| Evidence | How |
| --- | --- |
| The activity adapter is correct | `activityStoreConformance` is green |
| "Find A" end to end | `apps/core/src/delegation.e2e.test.ts` with a scripted model. The front agent calls `agent` (`cortex.research`) and answers with an acknowledgement ("Sure, I'll look for it") **before** the worker finishes (the worker is held until the test releases it). The owner sends another message and gets an answer. The worker is released, the report wakes the front agent, and the wake message marked proactive is stored and shows in `messages` |
| Task board | During the test: `tasks.list` shows `running`, then `done` with a summary; the front agent's reminder contains the active task (checked from the scripted model's prompt) |
| Brain events | The `/activity` feed contains the sequence `brain.thalamus.routed` → `brain.wernicke.start` → `brain.broca.*` → `brain.cortex.start` → `brain.cortex.end` → `brain.ras.deliver`, with payloads valid per the contracts schema |
| Recovers after a restart | The core is stopped while a worker runs, then started again. Reconcile reports the task (`interrupted` or finished) to the front agent, and the status on the task board is consistent |
| Budget and limits | A fourth worker is rejected with a model-readable message while 3 workers run (`maxConcurrent`) |
| TUI | Ink tests: the brain panel lights up from fake core events; the task panel; the ◆ marker; a narrow layout. PTY test: the chat flow keeps working with the panels active |
| `bun run check` | Green from a clean clone, and in `act` |

The demo with real OpenRouter stays with viandwi24: "find today's AI news" then keep chatting.

## Risks

| Risk | Handling |
| --- | --- |
| The wake turn and the proactive marking are not as assumed | The spike in step 1 before anything else is built |
| `subagent`, `activity`, `client` are still Draft | Pin 0.9.0; the e2e tests catch changes on upgrade |
| A task gets stuck without a report | Reconcile every 60 seconds; a 1-hour timeout with `stopOnTimeout` |
| Worker cost | `maxConcurrent: 3`, a budget per turn and session, the `cortex` model can be changed |
| The feed sends no history | The TUI loads `tasks.list` at boot and on resync |
| A slow hook blocks a turn (hook limit of 30 seconds) | Event writing is fire-and-forget with `.catch(warn)`, like team |
| The TUI slows down because events come too often | The brain panel is throttled (renders at most every 100 ms) |

## Execution notes

Executed Oct 26, 2026. Each step was done by a Sonnet 5.5 subagent. The orchestrating session reviewed each result, re-ran its tests itself, then committed. Steps 1–3 ran in parallel.

| Step | Finding | Handling |
| --- | --- | --- |
| 1 | After the front agent delegates, `send().result.stop` is `tool-pending`; the answer comes in a continuing `respond` turn | Tests and UI do not depend on that `stop` |
| 1 | A turn woken by a worker report is always `kind: 'wake'` (without `source`) | `proactive()` checks only `kind` |
| 1 | `metadata.app` cannot be written from a hook | The proactive marker is a `data-keith.proactive` data part (`model: 'omit'`) written in `turn.start` |
| 1 | `subagentChild` is not needed | Workers use `subagent({ agents: {}, parentAgent, selfAgent, onPark: 'notice' })` like team |
| 3 | The `tasks.*` contract made the core fail typecheck before step 4 | A temporary stub in `compose.ts`, replaced in step 4 |
| 4 | eharness offers `send_message` by default | `messageTool: false` on the front agent and workers |
| 4 | `brain.thalamus.routed` fits eharness' `chat.validate` hook better than a Hono middleware | No need to clone the body; only for `kind: 'send'` |
| 4 | `brain.ras.deliver` needs a `taskId` | Taken from the `message.saved` hook that sees the `subagent` report event |
| 4 | The `cortex.general` worker is not given `delete_file`, and approval rejects risk `destructive` | Stricter than the plan |
| 4 | `tasks.stop` on a task whose worker is already gone did not send `task-changed` (found while writing the spec) | `announceFinished` is used on every task end path, with a new test |
| 4 | `keepLatestOf` for `brain.*.state` is not needed | There is no `brain.*.state` event; prune uses `keepLast` and `olderThan` |
| 4 | The gate test was 418 lines | Split: `delegation.e2e.test.ts`, `task-recovery.e2e.test.ts`, helper `testing/core-harness.ts` |
| 6 | `useActivityFeed` creates a second feed per client | The TUI uses `client.feed()` directly, the state lives in `App` so Ctrl+B/Ctrl+T do not delete it |
| 6 | ink-testing-library is always 100 columns | `App` accepts a `columns` prop |
| 6 | The task description is truncated at 38 columns in the wide layout | Accepted for M2 |

Known gap: a worker report that arrives while the owner is in a turn (instead of waking the front agent) is not marked proactive. This is documented in `docs/specs/ras.md`.

### M2 gate evidence

| Evidence | Result |
| --- | --- |
| The activity adapter is correct | `activityStoreConformance`: 13 cases green |
| "Find A" end to end | `delegation.e2e.test.ts`: the front agent acknowledges while the worker is still held; the second message is answered; after release, the wake answer marked `data-keith.proactive` reaches `messages` through the client |
| Task board | `tasks.list`: `running` then `done` with a summary; the active-task reminder is in the front agent's model prompt |
| Brain events | The sequence `brain.thalamus.routed` → `wernicke.start` → `broca.start` → `cortex.start` → `cortex.end` → `ras.deliver`; every payload passes `parseBrainEvent`; `/activity` rejects without a token |
| Recovers after a restart | `task-recovery.e2e.test.ts`: a new core on the same DB, reconcile ends the task as `interrupted`, and the owner gets a proactive message |
| Limits | The fourth delegation is rejected with a message the model reads; `tasks.stop` yields `stopped` (also when the worker is already gone) |
| TUI | 30 tests: the brain panel lights up and dims, the task panel (mount, `task-changed`, resync), ◆, `/tasks` and stop, `/brain trace`, Ctrl+B/Ctrl+T, wide and narrow layouts; real PTY at 120 and 80 columns with events shown and chat still working |
| `bun run check` from a clean clone | Exit 0, 210 tests, 16 seconds; lockfile unchanged |
| `act push -j check` | Every step green, including `bun run check` (210/0) and `bun audit`; the post step of setup-bun failed because of the act environment |
| `gitleaks git` | No leaks |

Not yet proven: the demo with real OpenRouter ("find today's AI news"), which waits for viandwi24.

## [DECIDE]

Nothing is required. One thing you can change before execution: the worker cost limits (default 1 USD per turn, 3 USD per task) and the number of parallel workers (default 3).
