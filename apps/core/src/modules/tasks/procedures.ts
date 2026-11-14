import type { Task } from '@keith/contracts'
import type { TaskRecord, TasksRepo } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { Principal } from '../auth/index.ts'
import { isActive } from './status.ts'

export interface TaskProceduresOptions {
  tasks: TasksRepo
  /** The session whose tasks a principal may see and stop (its front session). */
  sessionOf: (principal: Principal) => string
  /** Abort the worker of a task and deny its parked approvals; resolves when both were requested. */
  stop: (task: TaskRecord) => Promise<void>
  /** Called with the row after `tasks.stop` marked it stopped (feed event). */
  onStopped?: (task: TaskRecord) => void
}

const toTask = (r: TaskRecord): Task => ({ ...r })

/** oRPC `tasks.list` and `tasks.stop` (the Keith contract). */
export function taskProcedures(options: TaskProceduresOptions) {
  const { tasks } = options
  return {
    list: rpc.tasks.list.handler(({ input, context }) =>
      tasks
        .list({
          parentSessionId: options.sessionOf(context.principal),
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .map(toTask),
    ),
    stop: rpc.tasks.stop.handler(async ({ input, context }) => {
      const task = tasks.get(input.id)
      // another person's task is as good as absent
      if (task === undefined || task.parentSessionId !== options.sessionOf(context.principal)) {
        throw new ORPCError('NOT_FOUND', { message: `no task ${input.id}` })
      }
      if (!isActive(task)) return { ok: true as const }
      // The row is final before the worker is touched: the turn.end that the cancel of a parked
      // approval triggers would otherwise record `done`. The board never reopens a final row.
      const row = tasks.markFinished(task.id, { status: 'stopped' })
      if (row !== undefined) options.onStopped?.(row)
      await options.stop(task)
      return { ok: true as const }
    }),
  }
}
