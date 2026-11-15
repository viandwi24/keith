import { describe, expect, test } from 'bun:test'
import { isAlert, type OrbSignals, orbModeFor } from './orb-signals.ts'

const calm: OrbSignals = { link: 'live', approvals: 0, busy: false, speaking: false, typing: false }

describe('orbModeFor', () => {
  test('idle, listening, thinking, speaking from the chat turn', () => {
    expect(orbModeFor(calm)).toBe('idle')
    expect(orbModeFor({ ...calm, typing: true })).toBe('listening')
    expect(orbModeFor({ ...calm, busy: true })).toBe('thinking')
    expect(orbModeFor({ ...calm, busy: true, speaking: true })).toBe('speaking')
    expect(orbModeFor({ ...calm, busy: true, typing: true })).toBe('thinking')
  })
  test('alert outranks everything: offline, logged out, an approval waiting', () => {
    expect(orbModeFor({ ...calm, link: 'disconnected', busy: true })).toBe('alert')
    expect(orbModeFor({ ...calm, link: 'logged-out' })).toBe('alert')
    expect(orbModeFor({ ...calm, approvals: 1, busy: true, speaking: true })).toBe('alert')
  })
  test('a reconnect window and the first connect are not an alert', () => {
    expect(isAlert('reconnecting', 0)).toBe(false)
    expect(isAlert('connecting', 0)).toBe(false)
    expect(isAlert('live', 0)).toBe(false)
  })
})
