import type { TaskStatus, TasksRepo } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import type { reconcileBackgroundChildren } from 'eharness/subagent'
import { announceFinished } from './board.ts'
import { isActive } from './status.ts'

type Entry = Awaited<ReturnType<typeof reconcileBackgroundChildren>>[number]

const FINAL: Record<string, { status: TaskStatus; error?: string }> = {
  completed: { status: 'done' },
  failed: { status: 'failed' },
  stopped: { status: 'stopped' },
  interrupted: { status: 'interrupted', error: 'the core restarted while the worker was running' },
  timed_out: { status: 'timed_out', error: 'the worker ran past its time limit' },
  not_started: { status: 'failed', error: 'the worker never started' },
}

/**
 * Bring the task board in line with what `reconcileBackgroundChildren` found: a worker whose
 * process died never ran its `turn.end` hook, so its row still says running. Only rows that are
 * still active change, so a report the hook already recorded is never overwritten.
 */
export function applyReconcile(tasks: TasksRepo, store: ActivityStore, entries: Entry[]): void {
  for (const entry of entries) {
    if (entry.outcome !== 'reported' || entry.status === undefined) continue
    const final = FINAL[entry.status]
    const row = tasks.get(entry.sessionId)
    if (final === undefined || row === undefined || !isActive(row)) continue
    const next = tasks.markFinished(row.id, {
      status: final.status,
      ...(final.error === undefined ? {} : { error: final.error }),
    })
    if (next !== undefined) announceFinished(store, next)
  }
}
