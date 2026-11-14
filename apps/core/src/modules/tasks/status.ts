import type { TaskRecord } from '@keith/db'

/** A task that is not finished: its worker may still run or wait. */
export const isActive = (task: Pick<TaskRecord, 'status'>): boolean =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting'
