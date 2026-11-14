import { TASK_CHANGED } from '@keith/contracts'
import type { TaskRecord, TasksRepo } from '@keith/db'
import { definePlugin, type HarnessPlugin, type HarnessUIMessage } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { emit } from '../brain-events/index.ts'
import { isActive } from './status.ts'

export interface TaskBoardOptions {
  tasks: TasksRepo
  store: ActivityStore
}

/** Summary and error of a task that stopped on a spending limit. */
export const COST_CAP_SUMMARY =
  'Stopped because the cost limit was reached (cost-cap). Change the limit with /budget, then ask again.'

/** Longest result summary kept on a task row. */
export const SUMMARY_CHARS = 500
/** Longest summary a `brain.cortex.end` event carries (the contract allows 200). */
const EVENT_SUMMARY_CHARS = 200

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** The text of the last assistant message of a turn, whitespace collapsed. */
function finalText(messages: HarnessUIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const text = (last?.parts ?? [])
    .map((p) => (p.type === 'text' ? (p as { text: string }).text : ''))
    .join('')
  return text.replace(/\s+/g, ' ').trim()
}

/** Emit `task-changed` with the row, after any change. */
export function announceTask(store: ActivityStore, task: TaskRecord): void {
  emit(store, TASK_CHANGED, task.parentSessionId, null, { task })
}

/** Announce a task that just finished: `task-changed`, then `brain.cortex.end` (feed only). */
export function announceFinished(store: ActivityStore, row: TaskRecord): void {
  announceTask(store, row)
  if (row.finishedAt === null) return
  emit(store, 'brain.cortex.end', row.id, row.agent, {
    region: 'cortex',
    taskId: row.id,
    agent: row.agent,
    description: row.description,
    status: row.status,
    summary: clip(row.summary ?? '', EVENT_SUMMARY_CHARS),
  })
}

/**
 * Plugin for the WORKER agents: the one reliable source of task state in park mode, since the
 * lead's `agent` call fires no `tool.after`. It acts only in child sessions (`ctx.session.parent`):
 * `turn.start` marks the task running, `step.end` counts a step, `turn.end` finishes it with a
 * short summary. Every change emits `task-changed`, and the matching `brain.cortex.*` event.
 */
export function taskBoard(options: TaskBoardOptions): HarnessPlugin<'keith-tasks'> {
  const { tasks, store } = options
  return definePlugin({
    name: 'keith-tasks',
    setup: () => ({
      hooks: {
        'turn.start': (ctx) => {
          const parent = ctx.session.parent as
            | { sessionId: string; agent?: string; description?: string }
            | undefined
          if (parent === undefined) return
          const before = tasks.get(ctx.session.id)
          // a row in a final state (stopped, done, ...) never reopens (ADR-0027 §11)
          if (before !== undefined && !isActive(before)) return
          const row = tasks.upsert({
            id: ctx.session.id,
            parentSessionId: parent.sessionId,
            agent: parent.agent ?? ctx.agent.id,
            description: parent.description ?? before?.description ?? '',
            status: 'running',
            steps: before?.steps ?? 0,
            summary: before?.summary ?? null,
            error: null,
            createdAt: before?.createdAt ?? Date.now(),
            finishedAt: null,
          })
          announceTask(store, row)
          if (before?.status !== 'running') {
            emit(store, 'brain.cortex.start', ctx.session.id, ctx.agent.id, {
              region: 'cortex',
              taskId: row.id,
              agent: row.agent,
              description: row.description,
            })
          }
        },
        'step.end': (ctx, e) => {
          if (ctx.session.parent === undefined) return
          const before = tasks.get(ctx.session.id)
          if (before === undefined || !isActive(before)) return
          const row = tasks.upsert({ ...before, steps: before.steps + 1, updatedAt: Date.now() })
          announceTask(store, row)
          emit(store, 'brain.cortex.step', ctx.session.id, ctx.agent.id, {
            region: 'cortex',
            taskId: row.id,
            agent: row.agent,
            description: row.description,
            stepIndex: e.stepIndex,
          })
        },
        'turn.end': (ctx, e) => {
          if (ctx.session.parent === undefined) return
          const before = tasks.get(ctx.session.id)
          if (before === undefined || !isActive(before)) return
          const text = finalText(e.messages)
          // a budget stop leaves an empty reply: say why on the row (the lead relays the row's report)
          const capped = e.stop === 'cost-cap'
          const summary =
            text === '' ? (capped ? COST_CAP_SUMMARY : undefined) : clip(text, SUMMARY_CHARS)
          let row: TaskRecord | undefined
          if (e.stop === 'tool-pending') {
            row = tasks.upsert({ ...before, status: 'waiting', updatedAt: Date.now() })
          } else {
            const status =
              e.stop === 'complete' ? 'done' : e.stop === 'aborted' ? 'stopped' : 'failed'
            const error =
              status === 'failed'
                ? (e.error?.message ??
                  (capped ? COST_CAP_SUMMARY : `the worker stopped: ${e.stop}`))
                : undefined
            row = tasks.markFinished(before.id, {
              status,
              ...(summary === undefined ? {} : { summary }),
              ...(error === undefined ? {} : { error }),
            })
          }
          if (row === undefined) return
          announceFinished(store, row)
        },
      },
    }),
  })
}
