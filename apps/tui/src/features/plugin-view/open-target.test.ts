import { describe, expect, test } from 'bun:test'
import { openTargetOf } from './open-target.ts'

const views = [{ viewId: 'notes.list', label: 'Notes' }]

describe('openTargetOf (an open.view delivery name)', () => {
  test('plugin:<id>:<view> is the menu view <id>.<view>', () => {
    expect(openTargetOf('plugin:notes:list', views)).toEqual({
      kind: 'view',
      viewId: 'notes.list',
      label: 'Notes',
    })
  })

  test('tasks is the Tasks screen', () => {
    expect(openTargetOf('tasks', views)).toEqual({ kind: 'tasks' })
  })

  test('a view the menu does not list, a room and protocols are not openable here', () => {
    expect(openTargetOf('plugin:ghost:view', views)).toBeUndefined()
    expect(openTargetOf('room:abc', views)).toBeUndefined()
    expect(openTargetOf('protocols', views)).toBeUndefined()
  })

  test('a name that is not a view id at all is not openable', () => {
    expect(openTargetOf('notes.list', views)).toBeUndefined()
    expect(openTargetOf('plugin:Notes:list', views)).toBeUndefined()
    expect(openTargetOf('', views)).toBeUndefined()
  })
})
