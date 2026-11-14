# Tasks (task board)

Code: `apps/core/src/modules/tasks/{board,reminder,reconcile,procedures,status}.ts`, storage in
`packages/db` (`tasksRepo`, see `db.md`), wire types in `packages/contracts/src/tasks.ts`.
Tests: `tasks.test.ts`, `apps/core/src/delegation.e2e.test.ts`.

## Purpose

One row per delegated worker, so the person who asked, the TUI and the front agent can answer "how far along
is it?" from a table and not from a model.

## Task and statuses

`Task` (`TaskSchema`): `id` (= child session id = worker session id), `parentSessionId` (the front
session), `agent` (catalog key), `description`, `status`, `steps`, `summary`, `error`,
`createdAt`, `updatedAt`, `finishedAt` (all epoch ms, `finishedAt` null while active).

Statuses (`TaskStatusSchema`): `queued`, `running`, `waiting`, `done`, `failed`, `stopped`,
`timed_out`, `interrupted`. Active = `queued | running | waiting` (`isActive`).

| From | To | Source |
| --- | --- | --- |
| none, `waiting` | `running` | worker `turn.start` |
| `running` | `waiting` | worker `turn.end` with `stop: 'tool-pending'` (parked on an approval) |
| `running` | `done` | `turn.end` with `stop: 'complete'` |
| `running` | `stopped` | `turn.end` with `stop: 'aborted'`, or `tasks.stop` |
| `running` | `failed` | `turn.end` with any other stop (`error` = the error message, else "the worker stopped: <stop>"; for `cost-cap` with no text, summary and error are `COST_CAP_SUMMARY`, `budget.md`) |
| active | `done`, `failed`, `stopped`, `interrupted`, `timed_out` | `applyReconcile` |

`queued` exists in the contract but nothing in M2 writes it. A task row in a final state (`done`, `failed`, `stopped`, `timed_out`, `interrupted`) never goes back to an active one (ADR-0027 §11): the board's hooks return early for it, and `TasksRepo.upsert` keeps the stored status and `finishedAt` when the new status is active (a second guard). Stopping a task also cancels its parked approval (see `tasks.stop`).

## taskBoard (`taskBoard({ tasks, store })`, plugin `keith-tasks`)

Installed on the workers. In park mode the lead's `agent` call fires no `tool.after`, so the only
reliable source is a hook inside the child session. It acts only when `ctx.session.parent` is set;
a root session never touches the board.

- `turn.start`: upsert `running` (parent session, agent and description from `ctx.session.parent`;
  steps, summary and `createdAt` kept on a resumed turn; `error` cleared). Emits `task-changed`;
  emits `brain.cortex.start` only when the task was not already running. A row in a final state
  is left alone (no upsert, no event).
- `step.end`: `steps + 1`, emits `task-changed` and `brain.cortex.step` (`stepIndex`). A final row is left alone.
- `turn.end`: final status per the table; summary = last assistant text, whitespace collapsed,
  clipped to `SUMMARY_CHARS` (500). A finished row emits `task-changed` and `brain.cortex.end`
  (summary clipped to 200). A `waiting` row emits only `task-changed`. A row in a final state is
  left alone: a `turn.end` that arrives after `tasks.stop` recorded `stopped` changes nothing.

`task-changed` (`TASK_CHANGED`, payload `{ task }`, `TaskChangedPayloadSchema`) is appended to the
activity feed with `sessionId = parentSessionId`, `agentId = null`, through the fire-and-forget
`emit` (`brain-events.md`). It is not a brain event: the TUI uses it for the task panel.

## Front reminder (`taskReminder({ tasks })`, plugin `keith-task-reminder`)

Installed on the front agent. `step.prepare` lists the active tasks of the current session
(`tasks.list({ parentSessionId: ctx.session.id, active: true })`); with none it returns nothing.
Otherwise it returns `{ reminder }`: a header ("Background tasks you delegated that are still
active (use these ids with agent_output and agent_stop):") and one line per task:
`- <id> · <agent> · <status> · <n> steps · started <age> ago: <description>`. A reminder is
volatile: never stored in history or the system prompt, so the prompt cache holds.

## applyReconcile

`applyReconcile(tasks, store, entries)` takes the result of `cortex.reconcile` and, for entries
with `outcome: 'reported'`, maps the status: `completed` to `done`, `failed`, `stopped`,
`interrupted` (error "the core restarted while the worker was running"), `timed_out` (error "the
worker ran past its time limit"), `not_started` to `failed` (error "the worker never started").
Only rows that are still active change, so a report the hook already recorded is never
overwritten (a worker that died never ran `turn.end`). Each change emits `task-changed`.

## oRPC (`taskProcedures`, contract `tasks.*`)

Both need the `tasks.own` capability (`permissions.md`). `sessionOf(principal)` is `front:<personId>`.

- `tasks.list({ active?, limit? })` (limit 1 to 200): the principal's tasks, newest update first,
  `Task[]`. Only tasks whose `parentSessionId` is the principal's front session.
- `tasks.stop({ id })`: `NOT_FOUND` ("no task <id>") for an unknown id or another person's task
  (indistinguishable on purpose). A task that is no longer active returns `{ ok: true }` untouched.
  Otherwise the procedure first marks the row `stopped` (so a late `turn.end` of the worker cannot
  record another status; the board ignores a final row), calls `onStopped(task)`, then `stop(task)`
  (compose: `worker.session(id).abort('stopped')`, then `cortex.cancelPending(id, agent, reason)`,
  which denies every approval the worker is parked on, ADR-0027 §11; a failure of the cancel is a
  warning). Returns `{ ok: true }`.
- `onStopped(task)` is called with the stopped row; compose passes `announceFinished(store, task)`,
  so it emits `task-changed` and `brain.cortex.end` (status `stopped`) like any other end.
  `applyReconcile` and `taskBoard`'s `turn.end` use the same `announceFinished`.

## Timers in compose

`compose.ts` reconciles at boot and every `reconcileEveryMs` (default 60 s) for the front session of
every active person (`front:<id>`, opened with the shared lock; `createSessionCare.reconcileAll`).
Each person has its own `try`: a failure is logged with that person's id and the loop goes on, so one
broken person never stops the repair of the others (ADR-0027 §15, F-008). The people reconciled are
`peopleFor('route', …)`: active only. A suspended person's rows are repaired at boot (`recover`: active
and suspended) and reconciled again once the person is active. It also prunes the feed at boot and
every `pruneEveryMs` (600 s). `close()` clears both timers. Tests shorten them through `CoreOptions.timing`.

## Per person

Tasks are person-scoped: `parentSessionId` is the person's front session, `tasks.list` and
`tasks.stop` only see and stop the rows of the caller's own front session (another person's task is
"not found"), the reminder lists the active tasks of the session it runs in, and a worker's report,
its dead letter and its owner-routed approval carry the person of its parent chain. The owner does
not see members' tasks.

## Invariants

- The id of a task is the id of its worker session; one row per worker session.
- Only the board plugin and `applyReconcile` write status; the procedure writes `stopped` only as
  the fallback above.
- A person sees and stops only their own tasks.

## Tests

`tasks.test.ts`: running, step count, `done` with final text; a failing model ends `failed` with
the reason; a `stopped` or `done` row stays so after a later `turn.start`, and the repo upsert
refuses the regress; a root session does not touch the board; reminder lists active tasks and is empty
otherwise; `applyReconcile` changes active rows only; `list` filtering by principal, `active`,
`limit`; `stop` marks the row before it touches the worker, a finished task is a no-op, other person or
unknown id is `NOT_FOUND`. `motor.e2e.test.ts`: `tasks.stop` on a worker parked on a `shell.exec`
approval denies it, the node gets no command, the row stays `stopped`. `delegation.e2e.test.ts`: running then done through `tasks.list`, reminder in the prompt,
restart ending `interrupted`, `tasks.stop` end to end.
