import { describe, expect, test } from 'bun:test'
import type { Task } from '@keith/contracts'
import {
  failedStop,
  filterCounts,
  filterTasks,
  summaryLine,
  taskDetailOf,
  taskRowOf,
} from './tasks-view.ts'

const task = (over: Partial<Task>): Task => ({
  id: 't1',
  parentSessionId: 's1',
  agent: 'cortex.research',
  description: 'look it up',
  status: 'running',
  steps: 1,
  summary: null,
  error: null,
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
  ...over,
})

const board = [
  task({ id: 'a', status: 'running' }),
  task({ id: 'b', status: 'waiting' }),
  task({ id: 'c', status: 'done', finishedAt: 5000 }),
  task({ id: 'd', status: 'failed', finishedAt: 5000, error: 'boom' }),
  task({ id: 'e', status: 'timed_out', finishedAt: 5000 }),
  task({ id: 'f', status: 'stopped', finishedAt: 5000 }),
  task({ id: 'g', status: 'interrupted', finishedAt: 5000 }),
]

describe('filters', () => {
  test('each filter keeps its statuses and the board order', () => {
    expect(filterTasks(board, 'all')).toHaveLength(7)
    expect(filterTasks(board, 'running').map((t) => t.id)).toEqual(['a', 'b'])
    expect(filterTasks(board, 'done').map((t) => t.id)).toEqual(['c'])
    expect(filterTasks(board, 'failed').map((t) => t.id)).toEqual(['d', 'e'])
    expect(filterTasks(board, 'stopped').map((t) => t.id)).toEqual(['f', 'g'])
  })
  test('counts feed the chips', () => {
    expect(filterCounts(board)).toEqual({ all: 7, running: 2, done: 1, failed: 2, stopped: 2 })
  })
  test('the summary line counts running tasks', () => {
    expect(summaryLine(board)).toBe('7 tasks · 2 running')
    expect(summaryLine([task({ status: 'done', finishedAt: 1 })])).toBe('1 task')
  })
})

describe('rows and detail', () => {
  test('a row uses the short agent, the status word and the elapsed time', () => {
    const row = taskRowOf(task({ status: 'timed_out', finishedAt: 62_000 }), 0)
    expect(row).toMatchObject({
      agent: 'research',
      status: 'timed out',
      time: '01:02',
      steps: '1 step',
      active: false,
      tone: 'danger',
    })
  })
  test('a running task counts up to now', () => {
    expect(taskRowOf(task({}), 5000).time).toBe('00:05')
  })
  test('the detail carries the failure, the summary and the empty line', () => {
    const failed = taskDetailOf(task({ status: 'failed', error: 'boom', finishedAt: 1 }), 0)
    expect(failed.error).toBe('Failed: boom')
    expect(failed.emptySummary).toBe('No summary.')
    expect(taskDetailOf(task({}), 0).emptySummary).toBe('No result yet.')
    expect(taskDetailOf(task({ summary: 'ok' }), 0).summary).toBe('ok')
  })
  test('a stop failure names its cause', () => {
    expect(failedStop(new Error('nope'))).toBe('Failed to stop: nope')
  })
})
