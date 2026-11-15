import { describe, expect, test } from 'bun:test'
import { viewIdOfRoute, viewRoute } from './routes.ts'

describe('plugin view routes', () => {
  test('a view id is two path segments, never a file name', () => {
    expect(viewRoute('notes.list')).toBe('/apps/notes/list')
    expect(viewRoute('my-plugin.main_view')).toBe('/apps/my-plugin/main_view')
  })
  test('the id comes back from the path; other paths have none', () => {
    expect(viewIdOfRoute('/apps/notes/list')).toBe('notes.list')
    expect(viewIdOfRoute('/apps/notes')).toBeUndefined()
    expect(viewIdOfRoute('/apps/notes/list/x')).toBeUndefined()
    expect(viewIdOfRoute('/tasks')).toBeUndefined()
  })
})
