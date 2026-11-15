import {
  formatElapsed,
  isActive,
  shortAgent,
  statusIcon,
  statusTone,
  statusWord,
  type Tone,
} from '@keith/app-model'
import type { Task, TaskStatus } from '@keith/contracts'

// View models of the Tasks screen: plain data in, plain rows out (no DOM, no state).

export type TaskFilter = 'all' | 'running' | 'done' | 'failed' | 'stopped'

export const TASK_FILTERS: readonly { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
]

const FAILED: readonly TaskStatus[] = ['failed', 'timed_out']
const STOPPED: readonly TaskStatus[] = ['stopped', 'interrupted']

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return isActive(task)
    case 'done':
      return task.status === 'done'
    case 'failed':
      return FAILED.includes(task.status)
    case 'stopped':
      return STOPPED.includes(task.status)
  }
}

/** The tasks of a filter, in board order (running first, then newest first: `mergeTasks` sorted them). */
export const filterTasks = (tasks: readonly Task[], filter: TaskFilter): Task[] =>
  tasks.filter((t) => matchesFilter(t, filter))

/** How many tasks each filter holds, for the chips. */
export function filterCounts(tasks: readonly Task[]): Record<TaskFilter, number> {
  return {
    all: tasks.length,
    running: filterTasks(tasks, 'running').length,
    done: filterTasks(tasks, 'done').length,
    failed: filterTasks(tasks, 'failed').length,
    stopped: filterTasks(tasks, 'stopped').length,
  }
}

/** `3 tasks · 1 running` (the TUI's summary line). */
export function summaryLine(tasks: readonly Task[]): string {
  const running = tasks.filter(isActive).length
  const head = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`
  return running > 0 ? `${head} · ${running} running` : head
}

export const stepsText = (steps: number): string => `${steps} ${steps === 1 ? 'step' : 'steps'}`

export interface TaskRowView {
  id: string
  agent: string
  description: string
  status: string
  icon: string
  tone: Tone
  active: boolean
  time: string
  steps: string
}

export function taskRowOf(task: Task, now: number): TaskRowView {
  return {
    id: task.id,
    agent: shortAgent(task.agent),
    description: task.description,
    status: statusWord(task.status),
    icon: statusIcon(task.status),
    tone: statusTone(task.status),
    active: isActive(task),
    time: formatElapsed(task, now),
    steps: stepsText(task.steps),
  }
}

export interface TaskDetailView extends TaskRowView {
  /** The failure line (`Failed: …`), or undefined. */
  error: string | undefined
  /** The result text, or undefined. */
  summary: string | undefined
  /** What stands where there is no summary. */
  emptySummary: string
  parentSessionId: string
  createdAt: number
  finishedAt: number | undefined
}

export function taskDetailOf(task: Task, now: number): TaskDetailView {
  const row = taskRowOf(task, now)
  return {
    ...row,
    error: task.error === null ? undefined : `Failed: ${task.error}`,
    summary: task.summary ?? undefined,
    emptySummary: row.active ? 'No result yet.' : 'No summary.',
    parentSessionId: task.parentSessionId,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt ?? undefined,
  }
}

/** The TUI's words for a stop. */
export const STOP_CONFIRM = 'Stop this task?'
export const STOPPED_TEXT = 'Task stopped.'
export const failedStop = (error: unknown): string =>
  `Failed to stop: ${error instanceof Error ? error.message : String(error)}`

/** `14 Nov 2026, 09:41`: a moment in the viewer's zone, for a title attribute or a detail row. */
export function whenText(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
