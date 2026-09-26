# Core: Mind, threads, scheduler

Code lives in `packages/core/src/{mind,scheduler,memory,builtins}`. Concepts come from [model.md](../concept/model.md), and behavior targets come from [scenarios.md](../concept/scenarios.md).

## Internal interfaces

Core folders depend on each other **only through these interfaces** (R-3). Lanes build against them in parallel. Each block's comment names the `types.ts` file it lives in. Changing one needs an update to this doc in the same change.

### Shared domain types (`shared/types.ts`)

```ts
type PersonId = `per_${string}`;  type ThreadId = `thr_${string}`;  type NodeId = `nod_${string}`
type MessageId = `msg_${string}`; type TaskId = `tsk_${string}`;    type CommitmentId = `cmt_${string}`
type DeliveryId = `dlv_${string}`; type MemoryId = `mem_${string}`; type TurnId = `trn_${string}`

type Tier = 'owner' | 'member' | 'guest'          // order: owner > member > guest
type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking'
type Lane = 'foreground' | 'delivery' | 'background'
type ModelRole = 'foreground' | 'background' | 'utility'
type Urgency = 'low' | 'normal' | 'high' | 'critical'
type Visibility = 'subject' | 'thread' | 'household' | 'owner'
type Viewer = { participants: PersonId[] }        // who a context is built for (I-3, I-4)

interface Logger { debug(m: string, f?: object): void; info(…): void; warn(…): void; error(…): void; child(f: object): Logger }
interface Clock { now(): number }
interface Ids { next<P extends string>(prefix: P): `${P}_${string}` }

interface Task {
  id: TaskId; personId: PersonId; threadId: ThreadId | null; agentId: string; goal: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; attempt: number
  visibility: Visibility                          // 'subject' (direct thread) or 'thread' (group thread)
  summary: string | null; detail: string | null; ui: UiBlock | null
  createdAt: number; startedAt: number | null; finishedAt: number | null
}
type TaskSpec = { personId: PersonId; threadId: ThreadId | null; agentId: string; goal: string;
                  notify: 'when-done' | 'silent'; promise?: string }

interface Commitment {
  id: CommitmentId; threadId: ThreadId; personId: PersonId; taskId: TaskId; promise: string
  status: 'open' | 'fulfilled' | 'cancelled' | 'expired'
  createdAt: number; resolvedAt: number | null; expiresAt: number
}
type NewCommitment = Pick<Commitment, 'threadId' | 'personId' | 'taskId' | 'promise'>

interface Delivery {
  id: DeliveryId; threadId: ThreadId; personId: PersonId
  kind: 'task_result' | 'task_failed' | 'plugin' | 'reminder' | 'relay' | 'invitation'
  authorPersonId: PersonId | null; source: string   // 'core' or the plugin id
  urgency: Urgency; content: string; ui: UiBlock | null
  status: 'pending' | 'delivered' | 'dismissed'; createdAt: number; deliveredAt: number | null
}
type NewDelivery = Pick<Delivery, 'personId' | 'kind' | 'content'> &
  Partial<Pick<Delivery, 'threadId' | 'authorPersonId' | 'source' | 'urgency' | 'ui'>>   // threadId default: person's main

// Memory and NewMemory: see memory.md "Memory record". MemoryFilter: see storage.md "Memory search filter" (lives in storage/types.ts).
```

`UiBlock` and `CoreFrame` come from `@keith/protocol`. `LlmMessage` and `LlmEvent` come from `@keith/sdk`.

### Server (`server/types.ts`), implemented by `server/`

```ts
interface AttachmentRegistry {                    // constructed first; shared by server and mind (breaks the cycle)
  attach(nodeId: NodeId, threadId: ThreadId): void
  detach(nodeId: NodeId, threadId?: ThreadId): void
  attachedTo(threadId: ThreadId): NodeId[]
  send(nodeId: NodeId, frame: CoreFrame): void     // no-op if the node is gone
}
type NodeSink = Pick<AttachmentRegistry, 'send' | 'attachedTo'>
interface Presence {
  isPresent(personId: PersonId): boolean
  lastSeenAt(personId: PersonId): number | null    // persisted in persons.last_seen_at
  flushPresence(): Promise<void>                    // write last_seen_at for everyone present (shutdown)
}
```

### Mind (`mind/types.ts`), implemented by `mind/`

```ts
type Arrival = { awayMs: number | null }          // null = first-ever attach
interface OpenedThread { thread: ThreadDto; messages: MessageDto[] }

interface ThreadManager {
  // The server calls open() and sends the thread.opened frame itself from the return value.
  open(a: { personId: PersonId; nodeId: NodeId; threadId?: ThreadId; arrival: Arrival | null }): Promise<OpenedThread>
  detach(a: { nodeId: NodeId; threadId?: ThreadId }): void
  input(a: { threadId: ThreadId; personId: PersonId; nodeId: NodeId; modality: 'text' | 'audio'; text: string }): Promise<void>
  cancel(a: { threadId: ThreadId; nodeId: NodeId }): void
  state(threadId: ThreadId): TurnState
}

// A pure function built from registries + repositories. Used by the mind for turns and by the scheduler for tasks.
type RunLoop = (a: {
  system: string; messages: LlmMessage[]; tools: string[]; modelRole: ModelRole; maxSteps: number
  runCtx: { personId: PersonId; participants: PersonId[]; threadId: ThreadId | null; taskId: TaskId | null }
  persist: { threadId: ThreadId } | null          // null = don't write tool messages to a thread (tasks)
  signal: AbortSignal
  onEvent?: (e: RunLoopEvent) => void             // the caller turns these into frames; RunLoop never sends frames
}) => Promise<{ text: string; steps: number; stoppedBy: 'stop' | 'step_limit' | 'cancelled' }>

type RunLoopEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | { type: 'tool.completed'; toolCallId: string; name: string; ok: boolean; summary?: string }
  | { type: 'ui'; toolCallId: string; toolName: string; block: UiBlock; fallbackText: string }
  | { type: 'step.completed'; step: number }
```

The ThreadManager maps `RunLoopEvent`s to `message.delta`, `tool.activity` and `ui.render` frames. The scheduler ignores most of them for tasks (it keeps `ui` for the task result).

### Scheduler (`scheduler/types.ts`), implemented by `scheduler/`

```ts
interface Scheduler { run<T>(lane: Lane, job: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> }
interface TaskService {
  start(spec: TaskSpec): Promise<Task>
  cancel(id: TaskId): Promise<void>
  get(id: TaskId): Promise<Task | null>
  active(): Promise<Task[]>
}
interface CommitmentService {
  create(c: NewCommitment): Promise<Commitment>
  resolveForTask(taskId: TaskId, outcome: 'fulfilled' | 'cancelled'): Promise<Commitment | null>
  openFor(threadId: ThreadId): Promise<Commitment[]>
}
interface DeliveryQueue {
  enqueue(d: NewDelivery): Promise<Delivery>        // persists, then emits `delivery.enqueued`
  pendingFor(threadId: ThreadId): Promise<Delivery[]>   // ordered by urgency, then age
  markDelivered(ids: DeliveryId[], messageId: MessageId): Promise<void>
}
```

### Memory (`memory/types.ts`), implemented by `memory/`

```ts
interface MemoryService {
  write(m: NewMemory): Promise<Memory>
  recall(q: { text: string; viewer: Viewer; limit?: number }): Promise<Memory[]>
  core(viewer: Viewer): Promise<Memory[]>                              // pinned, visible, capped
  index(viewer: Viewer): Promise<string[]>                             // subjects/topics not in core()
  digest(a: { threadId: ThreadId; viewer: Viewer }): Promise<string>   // awareness digest, ≤ 5 lines
}
```

The digest builds its activity picture from events (`thread.state_changed`, `task.*`) plus repositories. It never calls the mind, so there is no cycle.

Storage repositories (`storage/types.ts`) are the only way other folders touch the database. See [storage.md](storage.md).

### Construction order (bootstrap)

The only order that has no cycles. `bootstrap.ts` follows it:

1. config → logger, clock, ids
2. db + repositories → event bus
3. registries: services, tools, skills, agents, providers (standalone objects from `plugins/`)
4. `AttachmentRegistry` + `Presence` (from `server/`)
5. `RunLoop` (from `mind/`, needs providers, tools, repositories)
6. scheduler, tasks, commitments, deliveries (needs `RunLoop`)
7. memory (needs repositories, events, tasks)
8. `ThreadManager` (needs everything above). It subscribes to `delivery.enqueued`, so nothing calls into it from below. Arrival reaches it only through `open({ arrival })`, never through the `person.arrived` event (which is for plugins).
9. server (needs `ThreadManager`, attachments, presence) builds its http and ws registries, **without listening yet**
10. built-in tools registered through the privileged `tools.registerBuiltin()`
11. plugin host (needs registries, server http/ws, the delivery sink) → load → `setup` → `start`
12. server `listen()` → emit `core.started`

## Threads and turn state

Each Thread has one `TurnState` held in memory (not persisted) and broadcast as `thread.state` frames. Direct threads are created on demand: `open` without a `threadId` gets or creates the person's direct thread with slug `main`.

```
          input.text / audio start
   idle ───────────────────────────► thinking ──first text delta──► speaking
    ▲  ▲                                 │                             │
    │  └──────── turn ends ──────────────┴─────────────────────────────┘
    │
    └─ listening (voice only, phase 3): VAD detected speech on the focus node
```

Rules:
- **Input while `thinking` or `speaking`.** Text input is queued and becomes the next turn. Nothing is lost, and the model sees both messages. Voice barge-in is phase 3.
- **`input.cancel`** aborts the running turn's `AbortSignal`. The partial assistant text is persisted with `meta.cancelled = true`.
- **Focus** is set to the node of each new input. Audio output goes to the focus node only. Text and UI go to every node attached to the Thread (I-7).
- Each new user input is echoed to the *other* attached nodes as `message.user`.

## The turn loop

One function, `RunLoop`, powers user turns, delivery turns, briefing turns and tasks. What differs is the context and the model role.

```
runLoop({ system, messages, tools, modelRole, maxSteps, runCtx, persist, signal, onEvent }):
  for step in 1..maxSteps:
    stream = providers.llm.resolve(modelRole).stream({ system, messages, tools }, signal)
    forward text deltas → onEvent ; collect tool calls
    if no tool calls: return final text
    run tool calls through tools.invoke (in parallel, each with its own timeout)
    append the assistant message (with toolCalls) + one tool message per call ; persist if `persist`
  return final text, stoppedBy 'step_limit'
```

- **Step limit:** `mind.turn.maxSteps` (default 8) for turns, `mind.task.maxSteps` (default 20) for tasks.
- **Stall watchdog:** a step with no stream event for `mind.turn.stallMs` (default 120 000) is aborted and reported.
- **Tool errors** never crash a turn. The error text becomes the tool result so the model can recover. Unknown tools, invalid arguments and tier refusals are handled the same way.
- **Tool tier check:** `tools.invoke` enforces `tool.minTier` against the **lowest tier among `runCtx.participants`** (for tasks, the task's person).
- **Provider errors:** retryable ones (network, 429, 5xx) are retried by the loop up to 2 times with backoff, then surface as an `error` frame plus a short assistant apology message.
- **Tool call ids:** the provider's `LlmToolCall.id` is persisted as-is. See [storage.md](storage.md#messages-and-tool-calls).
- A tool result's `ui` block is persisted on the assistant message and sent as a `ui.render` frame to attached nodes that declared `ui.render@1`. The model only ever sees `content` (text).

## Context builder

Builds `{ system, messages, tools }` for a Viewer. The system prompt is assembled in this order. Each section is a separate, testable function:

1. **Persona:** `~/.keith/persona.md` (see [config.md](config.md)).
2. **Now:** current date/time and timezone, plus the focus node's capabilities (so the model knows whether it can show UI or is being heard).
3. **Participants:** each participant's relationship card (name, tier, tone, notes).
4. **Core memories:** `MemoryService.core(viewer)`.
5. **Memory index:** `MemoryService.index(viewer)`, so the model knows recall is worth trying.
6. **Awareness digest:** `MemoryService.digest(...)`, 5 lines at most.
7. **Open commitments** in this Thread.
8. **Pending deliveries:** only in delivery turns and arrival turns, with instructions to phrase them naturally.
9. **Skills index:** name + one-line description of every registered skill (full text loads through `skill.load`).

**Messages:** the last `mind.context.recentMessages` messages (default 40). A running thread summary is added in phase 4.

**Tools:** built-ins, plus registry tools where `tool.minTier` is at or below the lowest participant tier (owner > member > guest) and `tool.requires ⊆` the focus node's capabilities.

## Scheduler

Three lanes, each with its own concurrency limit. Separate pools make I-5 structural rather than a matter of priority tuning. A **job** is any unit of work the scheduler runs: a turn or a task step.

| Lane | Used by | Default concurrency (config key) |
|---|---|---|
| `foreground` | User turns | 4 (`scheduler.foreground`) |
| `delivery` | Delivery and briefing turns | 2 (`scheduler.delivery`) |
| `background` | Tasks, reflection (phase 4) | 2 (`scheduler.background`) |

A **tick** fires every `scheduler.tickMs` (default 30 000) and emits `scheduler.ticked`. Plugins, commitment expiry and phase-4 reminders use it. Jobs in one lane never wait on another lane's pool.

## Tasks

A Task is background work run with an Agent.

- Started by the built-in tool `task.start({ agent?, goal, notify, promise? })`. `notify` is `'when-done'` (creates a Commitment) or `'silent'`. `agent` defaults to the built-in `general`, whose tools are every non-reserved registry tool plus `memory.recall`, `memory.remember` and `skill.load`. Plugins add agents through the agent registry.
- **Task context:** the Agent's system prompt + a short persona line + the goal + the task person's relationship card. Tasks don't get thread history. They use `memory.recall` when they need more. The task runs `RunLoop` with the Agent's tools, the `background` model role, `persist: null`, and `runCtx.participants = [personId]` (the group's participants in phase 5).
- **Visibility:** `subject` when started in a direct thread, `thread` when started in a group thread.
- **v1 limits:** tasks cannot start tasks, at most `mind.task.maxPerPerson` (default 3) running per Person, and a timeout of `mind.task.timeoutMs` (default 1 800 000).
- **Status:** `queued → running → completed | failed | cancelled`. On core start, tasks left `running` are re-queued once (`attempt` 2). A second interruption fails them.
- The result is stored on the task as `summary` (short text for contexts and deliveries) plus `detail` (full text) plus optional `ui`. In phase 1, results are *not* written as memories. They reach later contexts through the delivery message in thread history and through `task.status`. Phase 4 reflection distills them.
- Emits `task.started`, `task.completed`, `task.failed`, `task.cancelled`.

## Commitments

- Created by `task.start` when `notify = 'when-done'`, with `promise` holding the user-facing wording.
- `open → fulfilled | cancelled | expired`. Expiry is `mind.commitment.ttlMs` (default 604 800 000 = 7 days) without resolution, checked on tick (I-10).
- When a task ends:
  - completed → commitment `fulfilled` + a `task_result` Delivery
  - failed → commitment `fulfilled` (the promise to *report back* is kept) + a `task_failed` Delivery with an apology
  - cancelled by the person → commitment `cancelled`, no Delivery

## Deliveries

A Delivery is anything the Mind should surface in a Thread without being asked.

| Kind | Source | Phase |
|---|---|---|
| `task_result` / `task_failed` | Commitment resolution | 1 |
| `plugin` | `ctx.deliveries.enqueue` from a `tool` or `client-app` plugin | 1 |
| `reminder` | `reminder.set` built-in | 4 |
| `relay` | `relay.send` built-in (I-13) | 5 |
| `invitation` | `thread.start_group` | 5 |

**Flush triggers.** The ThreadManager checks the queue when (a) a `delivery.enqueued` event arrives for a thread, (b) a turn ends, (c) an arrival's hold ends (below), and (d) `open` is called and no hold starts (a reconnect below the threshold, or `briefing = off`). It flushes only when the thread is `idle`, the person is present, and no arrival hold is active.

**Delivery turn.** Runs in the `delivery` lane. All pending items go into context at once (section 8), ordered by urgency. Frames are `proactive: true`. After the assistant message is persisted, every item that was in context is marked delivered (with that `messageId`), whether or not the model mentioned it. `critical` items flush before any queued user input.

**Away.** Deliveries wait until the person is present again.

## Presence and arrival

- A Person is **present** while at least one attended node has one of their Threads open. `persons.last_seen_at` is written when they become away, refreshed on every scheduler tick while they are present, and written for every present person on graceful shutdown. Arrival detection survives restarts and crashes, and a crash costs at most one tick of accuracy.
- The server decides arrival when a person's first node attaches: `awayMs = now − last_seen_at`. It is an arrival if `awayMs ≥ mind.arrival.awayAfterMinutes × 60 000` (fractional minutes allowed), or if `last_seen_at` is null (first-ever attach, `awayMs: null`, a first meeting). The server then passes `arrival` to `ThreadManager.open` and emits `person.arrived`. Plugins may enqueue Deliveries in response (news, weather).
- `mind.arrival.briefing` controls what happens on arrival:
  - `on-greeting` (default): an **arrival hold** starts, and no delivery turn runs. The first user turn after arrival gets all pending deliveries in context (section 8). If the input is a greeting or a catch-up question, the model leads with them. Otherwise it answers first and then mentions them briefly. After that turn's reply is persisted, the included items are marked delivered. If no input arrives within `mind.arrival.holdMs` (default 120 000), the hold ends and a normal delivery turn runs.
  - `auto`: after a grace period of `mind.arrival.graceMs` (default 1 500, so plugin deliveries can land), a briefing turn runs in the delivery lane. It is a delivery turn whose instructions also say to greet.
  - `off`: no hold, normal flush.

## Built-in tools

Registered with `tools.registerBuiltin()`. Their namespaces are reserved.

| Tool | Phase | Purpose |
|---|---|---|
| `task.start`, `task.status`, `task.cancel` | 1 | Background work |
| `skill.load` | 1 | Load a skill's full instructions |
| `memory.remember`, `memory.recall`, `memory.forget` | 1 (FTS), 4 (reflection) | Write, search and delete memories |
| `reminder.set`, `reminder.cancel` | 4 | Time-based deliveries |
| `relay.send` | 5 | S-5 |
| `thread.start_group`, `thread.invite`, `thread.leave` | 5 | S-6 |

> Planned (phase 5): **Group threads.** Participants are stored from phase 1 (`thread_participants`), and messages carry `authorPersonId` from phase 1. Phase 5 adds the addressing detector (a rule-based pass, then a `utility`-model fallback), a turn for human-to-human messages that only fans out (no LLM), `thread` visibility for memories written in the group, and invitation deliveries. See [scenarios.md S-6](../concept/scenarios.md#s-6-collaboration-a-group-thread-with-shared-state).
