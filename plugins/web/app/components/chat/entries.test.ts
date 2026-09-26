import { expect, test } from 'bun:test'
import type { MessageEntry } from '@keith/client'
import { isHiddenEntry } from './entries.tsx'

const base: MessageEntry = {
  kind: 'message',
  key: 'm',
  id: 'm',
  role: 'assistant',
  text: '',
  proactive: false,
  streaming: false,
  cancelled: false,
  local: false,
  ui: [],
}

test('only finished, empty assistant rows without blocks are hidden (tool steps from history)', () => {
  expect(isHiddenEntry(base)).toBe(true)
  expect(isHiddenEntry({ ...base, text: '  ' })).toBe(true)
  expect(isHiddenEntry({ ...base, text: 'hi' })).toBe(false)
  expect(isHiddenEntry({ ...base, streaming: true })).toBe(false)
  expect(isHiddenEntry({ ...base, cancelled: true })).toBe(false)
  expect(isHiddenEntry({ ...base, role: 'user' })).toBe(false)
  expect(
    isHiddenEntry({ ...base, ui: [{ block: { type: 'markdown', id: 'x', text: 'x' }, fallbackText: 'x' }] }),
  ).toBe(false)
  expect(isHiddenEntry({ kind: 'notice', key: 'n', level: 'info', text: '' })).toBe(false)
})
