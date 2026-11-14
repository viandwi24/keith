import { describe, expect, test } from 'bun:test'
import type { PresenceRaw } from '@keith/contracts'
import { presenceLines } from './presence-command.ts'

const raw = (over: Partial<PresenceRaw['presence']> = {}, busy = false): PresenceRaw => ({
  presence: {
    personId: 'duta',
    state: 'active',
    reachableOn: ['c1', 'c2'],
    activeClient: 'c1',
    note: null,
    asOf: 1,
    ...over,
  },
  clients: [],
  status: busy
    ? { busy: true, note: 'in a meeting', until: Date.UTC(2026, 10, 10, 14, 30) }
    : { busy: false, note: null, until: null },
})

describe('keith-core presence', () => {
  test('the state, the active client and the online count, one line each', () => {
    expect(presenceLines(raw(), 'duta')).toEqual([
      'duta: active',
      'active client: c1',
      'online clients: 2',
    ])
  })

  test('a busy status shows its end and note; a note of the overlay is shown with the state', () => {
    const lines = presenceLines(raw({ state: 'busy', note: 'lunch' }, true), 'duta')
    expect(lines[0]).toBe('duta: busy (lunch)')
    expect(lines[1]).toBe('status: busy until 2026-11-10 14:30, in a meeting')
  })

  test('no active client and no clients print none', () => {
    const lines = presenceLines(
      raw({ state: 'offline', reachableOn: [], activeClient: null }),
      'duta',
    )
    expect(lines).toEqual(['duta: offline', 'active client: none', 'online clients: 0'])
  })
})
