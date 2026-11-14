import { expect, test } from 'bun:test'
import { parsePluginEvent } from './plugin-events.ts'

test('a plugin record parses; other records and mismatched types do not', () => {
  const payload = { plugin: 'notes', event: 'shared', to: 'ana', data: { id: 1 } }
  expect(parsePluginEvent({ type: 'plugin.notes.shared', payload })).toEqual({
    type: 'plugin.notes.shared',
    plugin: 'notes',
    event: 'shared',
    to: 'ana',
    data: { id: 1 },
  })
  expect(parsePluginEvent({ type: 'plugin.other.shared', payload })).toBeUndefined()
  expect(parsePluginEvent({ type: 'brain.broca.start', payload })).toBeUndefined()
  expect(parsePluginEvent({ type: 'plugin.notes.shared', payload: null })).toBeUndefined()
})
