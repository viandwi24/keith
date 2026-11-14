import {
  TASK_CHANGED,
  type Task,
  TaskChangedPayloadSchema,
  type TaskStatus,
} from '@keith/contracts'
import type { Tone } from '@keith/ui'
import { G } from '@keith/ui'

/** Most tasks kept in memory. */
export const TASK_LIMIT = 50

export const ACTIVE: readonly TaskStatus[] = ['queued', 'running', 'waiting']

export const isActive = (task: Task): boolean => ACTIVE.includes(task.status)

const ICON: Record<TaskStatus, string> = {
  queued: G.idle,
  running: G.working,
  waiting: G.waiting,
  done: G.done,
  failed: G.failed,
  stopped: G.stopped,
  timed_out: G.timedOut,
  interrupted: G.interrupted,
}
const TONE: Record<TaskStatus, Tone> = {
  queued: 'muted',
  running: 'info',
  waiting: 'warning',
  done: 'success',
  failed: 'danger',
  stopped: 'muted',
  timed_out: 'danger',
  interrupted: 'muted',
}
export const statusTone = (status: TaskStatus): Tone => TONE[status]
export const statusIcon = (status: TaskStatus): string => ICON[status]

/** The task of a `task-changed` record, or undefined for any other record or a bad payload. */
export function taskChangedOf(record: { type: string; payload: unknown }): Task | undefined {
  if (record.type !== TASK_CHANGED) return undefined
  const parsed = TaskChangedPayloadSchema.safeParse(record.payload)
  return parsed.success ? parsed.data.task : undefined
}

/**
 * Merge tasks into the board by id (the row with the newer `updatedAt` wins, so a slow list
 * response cannot undo a newer event). Active tasks first, then newest first.
 */
export function mergeTasks(current: readonly Task[], incoming: readonly Task[]): Task[] {
  const byId = new Map(current.map((t) => [t.id, t]))
  for (const task of incoming) {
    const have = byId.get(task.id)
    if (have === undefined || task.updatedAt >= have.updatedAt) byId.set(task.id, task)
  }
  return [...byId.values()]
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.updatedAt - a.updatedAt)
    .slice(0, TASK_LIMIT)
}

/** `02:13`, or `1:02:13` from an hour on. A running task counts up to `now`. */
export function formatElapsed(task: Task, now: number): string {
  const total = Math.max(0, Math.floor(((task.finishedAt ?? now) - task.createdAt) / 1000))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`
}

/** `research` for `cortex.research`: the name the owner knows the worker by. */
export const shortAgent = (agent: string): string => agent.replace(/^cortex\./, '')

/** `timed out` for `timed_out`. */
export const statusWord = (status: TaskStatus): string => status.replace('_', ' ')
