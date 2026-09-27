# Event catalog v1

**Frozen: v1 (2026-09-26).** Changes follow the [freeze rules](README.md#freeze-rules).

Internal event bus (in-process). Not the wire protocol. Types live in `@keith/sdk` (`CoreEventMap`), and the bus lives in `core/src/events`.

## Conventions

- Name: `<namespace>.<noun>_<past-tense-verb>`, all lowercase, e.g. `task.completed`, `person.arrived`, `weather.alert_raised`. (A single past-tense verb with no noun is fine when the namespace is the noun: `task.completed`.)
- Events are **facts**. Never commands (see [ADR-0005](../decisions/0005-services-for-requests-events-for-facts.md)).
- Every event is delivered as `{ name, at: number, data }`. `data` is plain JSON (no class instances, no functions).
- Core namespaces are reserved: `core`, `plugin`, `node`, `person`, `thread`, `turn`, `tool`, `task`, `commitment`, `delivery`, `memory`, `scheduler`.
- Plugins emit only in their own namespace and should `ctx.events.define(name, schema)` their events.
- Ids in payloads are the typed prefixed ids from `@keith/protocol` (`PersonId`, `ThreadId`, …). `error` fields carry an error message; `turn.failed.code` is a `KeithErrorCode`. `delivery.enqueued.kind` is a delivery kind from [core.md](../architecture/core.md#deliveries) (`task_result`, `task_failed`, `plugin`, `reminder`, `relay`, `invitation`).
- In code: `CoreEventMap` (types), `CORE_EVENT_NAMES` (runtime list, checked against this table by a test), `CORE_EVENT_NAMESPACES`, `EVENT_NAME_PATTERN`.

## Core events

| Event | data | Emitted when | Phase |
|---|---|---|---|
| `core.started` | `{ version }` | All plugins started, server listening | 1 |
| `core.stop_requested` | `{}` | Shutdown began | 1 |
| `plugin.failed` | `{ pluginId, stage: 'setup' \| 'start', error }` | A plugin threw | 1 |
| `node.connected` | `{ nodeId, personId: string \| null, capabilities }` | `welcome` sent | 1 |
| `node.disconnected` | `{ nodeId, personId: string \| null }` | Socket closed | 1 |
| `person.arrived` | `{ personId, awayMs: number \| null }` (null = first-ever attach) | First attach after the away threshold, or ever | 1 |
| `person.left` | `{ personId }` | Last attended node detached | 1 |
| `thread.opened` | `{ threadId, personId, nodeId }` | A node opened a thread | 1 |
| `thread.state_changed` | `{ threadId, from, to }` | Turn state changed | 1 |
| `thread.message_added` | `{ threadId, messageId, role, authorPersonId }` | Any message persisted | 1 |
| `turn.started` | `{ threadId, turnId, kind: 'user' \| 'delivery' \| 'briefing' }` | Turn job began | 1 |
| `turn.completed` | `{ threadId, turnId, steps, cancelled: boolean }` | Turn finished | 1 |
| `turn.failed` | `{ threadId, turnId, code }` | Turn errored after retries | 1 |
| `tool.called` | `{ threadId \| null, taskId \| null, toolCallId, name }` | Tool execution began | 1 |
| `tool.completed` | `{ toolCallId, name, ok: boolean, ms }` | Tool finished | 1 |
| `task.started` | `{ taskId, personId, agentId }` | Task running | 1 |
| `task.completed` | `{ taskId, personId, summary }` | Task succeeded | 1 |
| `task.failed` | `{ taskId, personId, error }` | Task failed | 1 |
| `task.cancelled` | `{ taskId, personId }` | Task cancelled | 1 |
| `commitment.created` | `{ commitmentId, threadId, taskId }` | | 1 |
| `commitment.resolved` | `{ commitmentId, status: 'fulfilled' \| 'cancelled' \| 'expired' }` | | 1 |
| `delivery.enqueued` | `{ deliveryId, threadId, kind, urgency }` | | 1 |
| `delivery.delivered` | `{ deliveryId, threadId, messageId }` | | 1 |
| `memory.written` | `{ memoryId, visibility, subjectPersonId }` | | 1 |
| `scheduler.ticked` | `{ at }` | Every `scheduler.tickMs` | 1 |

## Delivery semantics

- Handlers run asynchronously after `emit` returns (a microtask queue). Emitters never await listeners.
- A throwing handler is caught, logged with the plugin id, and does not affect other handlers.
- In-process, at-most-once, not persisted. Anything that must survive a restart is a database record (tasks, deliveries), not an event.
