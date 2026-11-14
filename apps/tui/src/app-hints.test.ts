import { expect, test } from 'bun:test'
import { hintsOf, newlineHint } from './app-hints.ts'

const base = {
  stepUpOpen: false,
  barHasKeys: false,
  notReady: false,
  approvalsWaiting: false,
  chatBusy: false,
}

test('idle chat hints; an approval waiting adds tab first', () => {
  expect(hintsOf(base).map((h) => h.key)).toContain('enter')
  expect(hintsOf({ ...base, approvalsWaiting: true })[0]?.key).toBe('tab')
  expect(hintsOf({ ...base, chatBusy: true })[0]?.key).toBe('esc')
})

test('a dialog that has the keys lists them itself: the page says nothing', () => {
  expect(hintsOf({ ...base, barHasKeys: true })).toEqual([])
  expect(hintsOf({ ...base, stepUpOpen: true })).toEqual([])
})

test('signed out: only quit', () => {
  expect(hintsOf({ ...base, notReady: true })).toEqual([{ key: 'ctrl+c', action: 'quit' }])
})

test('the newline hint names a key that works: shift+enter only when the terminal reports it', () => {
  const keys = (kitty: boolean) => hintsOf({ ...base, kitty }).map((h) => h.key)
  expect(keys(true)).toContain('shift+enter')
  expect(keys(true)).not.toContain('ctrl+j')
  expect(keys(false)).toContain('ctrl+j')
  expect(keys(false)).not.toContain('shift+enter')
  expect(newlineHint(true).action).toBe('newline')
})

test('idle names esc for Home, busy names esc for stop and ctrl+g for Home, never both for one thing', () => {
  const idle = hintsOf(base).map((h) => `${h.key} ${h.action}`)
  expect(idle).toContain('esc home')
  expect(idle.some((h) => h.startsWith('ctrl+g'))).toBe(false)
  const busy = hintsOf({ ...base, chatBusy: true }).map((h) => `${h.key} ${h.action}`)
  expect(busy).toContain('esc stop')
  expect(busy).toContain('ctrl+g home')
  expect(busy.some((h) => h.startsWith('esc home'))).toBe(false)
  for (const h of [...idle, ...busy]) expect(h).not.toMatch(/pgup|pgdn/)
})
