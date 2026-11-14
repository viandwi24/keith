import { describe, expect, test } from 'bun:test'
import { TASK_CHANGED } from '@keith/contracts'
import { task } from '../../testing/fixtures.ts'
import { formatElapsed, mergeTasks, taskChangedOf } from './tasks-state.ts'

describe('tasks state', () => {
  test('merge: the newer row wins, active first, then newest', () => {
    const board = mergeTasks(
      [task({ id: 'a', status: 'done', updatedAt: 5 }), task({ id: 'b', updatedAt: 3 })],
      [task({ id: 'b', status: 'done', updatedAt: 2 }), task({ id: 'c', updatedAt: 9 })],
    )
    expect(board.map((t) => [t.id, t.status])).toEqual([
      ['c', 'running'],
      ['b', 'running'], // the older list row did not undo the newer one
      ['a', 'done'],
    ])
  })

  test('elapsed time: mm:ss, hours when long, frozen once finished', () => {
    expect(formatElapsed(task({ createdAt: 0 }), 133_000)).toBe('02:13')
    expect(formatElapsed(task({ createdAt: 0 }), 3_723_000)).toBe('1:02:03')
    expect(formatElapsed(task({ createdAt: 0, finishedAt: 5000 }), 999_000)).toBe('00:05')
  })

  test('task-changed records parse; other types and bad payloads do not', () => {
    expect(taskChangedOf({ type: TASK_CHANGED, payload: { task: task() } })?.id).toBe('t1')
    expect(taskChangedOf({ type: 'brain.x', payload: { task: task() } })).toBeUndefined()
    expect(taskChangedOf({ type: TASK_CHANGED, payload: { task: 1 } })).toBeUndefined()
  })
})
