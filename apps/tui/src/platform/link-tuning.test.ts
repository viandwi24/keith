import { expect, test } from 'bun:test'
import { loadLinkTuning, secondsOf } from './config.ts'

test('defaults: a 5 s window to be live again, 15 s disconnected before each attempt', () => {
  expect(loadLinkTuning({})).toEqual({ windowMs: 5_000, waitMs: 15_000 })
})

test('KEITH_RECONNECT_WINDOW_SECONDS and KEITH_RECONNECT_WAIT_SECONDS are read in seconds', () => {
  expect(
    loadLinkTuning({ KEITH_RECONNECT_WINDOW_SECONDS: '8', KEITH_RECONNECT_WAIT_SECONDS: '30' }),
  ).toEqual({ windowMs: 8_000, waitMs: 30_000 })
})

test('an invalid, empty or sub-second value is the default', () => {
  for (const bad of ['', 'abc', '0', '-5', '0.5']) {
    expect(secondsOf(bad === '' ? undefined : bad, 15)).toBe(15)
  }
})
