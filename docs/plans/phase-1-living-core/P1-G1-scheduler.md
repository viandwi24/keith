---
id: P1-G1
title: Scheduler, tasks, commitments, delivery queue
phase: 1
wave: 1
lane: G
status: review
owner: agent-P1-G1
depends: [P0-04]
owns:
  - packages/core/src/scheduler/**
  - packages/core/src/builtins/task.ts
reads:
  - docs/architecture/core.md
  - docs/concept/scenarios.md
  - docs/contracts/events.md
updates:
  - docs/architecture/core.md
scenarios: [S-2]
---

# P1-G1: Scheduler, tasks, commitments, delivery queue

## Goal

Keith can promise, work in the background without slowing anyone down, and turn finished work into deliveries that are never dropped.

## Scope

**In:**
- `Scheduler`: three lanes with independent concurrency limits from config, `run(lane, job, signal)`, plus the tick timer emitting `scheduler.ticked`.
- `TaskService`: `start(spec)` persists a Task and runs it in the `background` lane using the injected `RunLoop` (from `mind/types.ts`) with the Agent from the agent registry and the `background` model role. Handles per-person limit, timeout, cancel, status transitions and events, plus restart recovery (`running` → re-queue once, then fail).
- `CommitmentService`: create, `resolveForTask`, `openFor`, and expiry on tick.
- `DeliveryQueue`: `enqueue` persists and emits `delivery.enqueued` (the mind reacts to the event; the queue never calls the mind). Also `pendingFor` (ordered by urgency, then age) and `markDelivered(ids, messageId)`.
- On task end, per core.md "Commitments": completed → commitment `fulfilled` + `task_result`; failed → commitment `fulfilled` + `task_failed`; cancelled → commitment `cancelled`, no delivery.
- Task context and visibility per core.md "Tasks" (agent prompt + persona line + goal + relationship card; `subject` or `thread` visibility; `persist: null`).
- `builtins/task.ts`: `task.start` (`notify: 'when-done' | 'silent'`; creates the commitment when `when-done`), `task.status`, `task.cancel`.
- The plugin-facing `DeliverySink` implementation (maps `ctx.deliveries.enqueue` to the queue with `source = pluginId`).

**Out:**
- The turn loop itself (E1). Reminders (phase 4). Relays and invitations (phase 5).

## Acceptance criteria

- [x] I-5: with `background = 1` and a long-running task, foreground jobs still start immediately (lane isolation test).
- [x] `task.start` with `when-done` creates Task + Commitment. Completion → commitment `fulfilled` → a `task_result` delivery enqueued → a `delivery.enqueued` event is emitted (S-2).
- [x] Task failure → `task_failed` delivery, and the commitment is still resolved (never dropped, I-10).
- [x] Restart recovery: a `running` task at boot is re-queued with `attempt = 2`, and a second interruption fails it.
- [x] Commitment expiry on tick (fake clock).
- [x] Per-person task limit returns a tool error the model can read.
- [x] `bun run check` passes.

## Outcome

**Built** (`packages/core/src/scheduler/`, `packages/core/src/builtins/task.ts`):

- `lanes.ts`: `createLaneScheduler`, three independent FIFO pools sized from `scheduler.*` (I-5), plus a tick timer that emits `scheduler.ticked`.
- `tasks.ts`: `createTaskService` (a `TaskService` plus `recover()` and `shutdown()`). It persists tasks, enforces the per-person limit (`TASK_LIMIT_REACHED`), creates the commitment before scheduling, runs `RunLoop` in the `background` lane (agent prompt + persona line + goal + relationship card, `background` role, `persist: null`, `participants = [personId]`), and applies the timeout, cancel, status events and end-of-task rules from core.md "Commitments". Restart recovery re-queues `running` tasks with `attempt + 1` and fails them on a second interruption.
- `commitments.ts`: `createCommitmentService` with `expireDue()`, called on every `scheduler.ticked`.
- `deliveries.ts`: `createDeliveryQueue` (persist, then emit `delivery.enqueued`; `markDelivered` emits `delivery.delivered`) and `createDeliverySinks`, the `PluginScoped<DeliverySink>` for the plugin host.
- `index.ts`: `createScheduling(deps)` for bootstrap step 6. It returns `{ scheduler, tasks, commitments, deliveries, deliverySinks, start(), stop() }`. `start()` recovers tasks, subscribes commitment expiry to ticks and starts the timer.
- `builtins/task.ts`: `createTaskTools({ tasks })` returns `task.start`, `task.status` and `task.cancel` for `registerBuiltin` in bootstrap.
- Tests: `lanes`, `tasks`, `commitments`, `deliveries` and `task-tools` (37 tests), against in-memory fakes built from the other lanes' `types.ts` in `scheduler/testing/`.

**Decisions / deviations:**

- `TaskSpec` already carries `notify`/`promise`, so `TaskService.start` creates the commitment, not the tool. That removes a race where a fast task could finish before the tool created its commitment. `task.start` passes `notify` through.
- A task's model role is always `background` (per core.md). `Agent.modelRole` is not used yet; the integration task should confirm this.
- The per-person limit counts `queued + running` tasks (`TasksRepository.countActiveFor`).
- A run that returns empty text counts as failed ("the task produced no result"). The timeout starts when the task starts running, not while it waits in the queue.
- `Scheduler.run` rejects with the abort signal's reason (like `fetch`), not a `KeithError`, because there is no cancellation code in `KEITH_ERROR_CODES`.
- `DeliveryQueue.enqueue` without a `threadId` throws `NOT_FOUND` when the person has no `main` thread yet. The queue doesn't create threads; the ThreadManager owns that.
- The plugin sink validates input with zod (`TOOL_INPUT_INVALID`) and returns `FORBIDDEN` for a thread the person isn't in, or after `removeByPlugin`.
- The three `task.*` tools require tier `member`. core.md doesn't specify a tier, so this is my choice.
- The tool tests live in `scheduler/task-tools.test.ts`, because `builtins/task.test.ts` isn't in `owns`.
- Added `zod@^4.6.5` to `@keith/core` (via `bun add`, same range as protocol/sdk). `packages/core/package.json` and `bun.lock` changed as a result.

**Follow-ups for integration:** wire `createScheduling` into bootstrap (step 6), pass `deliverySinks` to the plugin host, register `createTaskTools(...)` through `registerBuiltin`, call `scheduling.start()` before `listen()` and `stop()` on shutdown. Re-run the S-2 tests against real storage, the event bus, the agent registry and `RunLoop`.
