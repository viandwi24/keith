import { describe, expect, test } from 'bun:test'
import { TASK_CHANGED, TaskChangedPayloadSchema, TaskSchema, TaskStatusSchema } from './tasks.ts'

const task = {
  id: 'c1',
  parentSessionId: 'p1',
  agent: 'cortex.research',
  description: 'find a',
  status: 'running',
  steps: 0,
  summary: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
}

describe('tasks', () => {
  test('status values', () => {
    expect(TaskStatusSchema.options).toEqual([
      'queued',
      'running',
      'waiting',
      'done',
      'failed',
      'stopped',
      'timed_out',
      'interrupted',
    ])
    expect(TaskStatusSchema.safeParse('paused').success).toBe(false)
  })

  test('a task row parses; bad status or missing field fails', () => {
    expect(TaskSchema.safeParse(task).success).toBe(true)
    expect(TaskSchema.safeParse({ ...task, status: 'paused' }).success).toBe(false)
    expect(TaskSchema.safeParse({ ...task, finishedAt: undefined }).success).toBe(false)
  })

  test('task-changed payload wraps a task', () => {
    expect(TASK_CHANGED).toBe('task-changed')
    expect(TaskChangedPayloadSchema.safeParse({ task }).success).toBe(true)
    expect(TaskChangedPayloadSchema.safeParse({}).success).toBe(false)
  })
})
