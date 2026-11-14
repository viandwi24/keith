import { z } from 'zod'

/** Lifecycle of a delegated task (P3 "task board"). */
export const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'done',
  'failed',
  'stopped',
  'timed_out',
  'interrupted',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/** One row of the task board. The id is the child session id. */
export const TaskSchema = z.object({
  /** Task id (= worker session id). */
  id: z.string(),
  /** Session that delegated the task. */
  parentSessionId: z.string(),
  /** Catalog key of the worker agent, e.g. `cortex.research`. */
  agent: z.string(),
  /** What the worker was asked to do. */
  description: z.string(),
  status: TaskStatusSchema,
  /** Steps completed so far. */
  steps: z.number().int().nonnegative(),
  /** Short result summary once finished. */
  summary: z.string().nullable(),
  /** Failure reason, when the task failed. */
  error: z.string().nullable(),
  /** Epoch ms. */
  createdAt: z.number(),
  /** Epoch ms. */
  updatedAt: z.number(),
  /** Epoch ms; null while the task is still active. */
  finishedAt: z.number().nullable(),
})
export type Task = z.infer<typeof TaskSchema>

/** Activity event type emitted when a task row changes. */
export const TASK_CHANGED = 'task-changed'

export const TaskChangedPayloadSchema = z.object({ task: TaskSchema })
export type TaskChangedPayload = z.infer<typeof TaskChangedPayloadSchema>
