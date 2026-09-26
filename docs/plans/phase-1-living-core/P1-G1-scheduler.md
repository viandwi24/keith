---
id: P1-G1
title: Scheduler, tasks, commitments, delivery queue
phase: 1
wave: 1
lane: G
status: in-progress
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

- [ ] I-5: with `background = 1` and a long-running task, foreground jobs still start immediately (lane isolation test).
- [ ] `task.start` with `when-done` creates Task + Commitment. Completion → commitment `fulfilled` → a `task_result` delivery enqueued → a `delivery.enqueued` event is emitted (S-2).
- [ ] Task failure → `task_failed` delivery, and the commitment is still resolved (never dropped, I-10).
- [ ] Restart recovery: a `running` task at boot is re-queued with `attempt = 2`, and a second interruption fails it.
- [ ] Commitment expiry on tick (fake clock).
- [ ] Per-person task limit returns a tool error the model can read.
- [ ] `bun run check` passes.

## Outcome

_To be filled._
