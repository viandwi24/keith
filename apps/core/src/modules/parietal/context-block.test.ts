import { describe, expect, test } from 'bun:test'
import type { ClientRecord } from '@keith/contracts'
import {
  activeClientOf,
  CLIENT_CONTEXT_HEADING,
  clientContextBlock,
  localClockOf,
} from './context-block.ts'

// docs/decisions/0033 §5: the "Where the person is now" block of the front agent's reminder, built from the person's own
// clients. Only the client in use, its facts, and one line about the missing location sensor.

const NOW = Date.UTC(2026, 10, 12, 13, 5) // Thu 12 Nov 2026, 13:05 UTC: 14:05 in Paris
const ENV = {
  host: 'ana-laptop',
  os: 'macos',
  osVersion: '16.0',
  arch: 'arm64',
  device: 'laptop',
  timezone: 'Europe/Paris',
  locale: 'id-ID',
} as const

const client = (over: Partial<ClientRecord> = {}): ClientRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  personId: 'ana',
  kind: 'tui',
  label: 'ana-laptop',
  capabilities: ['chat', 'notify', 'open.view', 'render.markdown'],
  version: '0.1.0',
  firstSeenAt: 1,
  lastSeenAt: NOW,
  lastActiveAt: NOW - 60_000,
  online: true,
  environment: ENV,
  network: 'loopback',
  ...over,
})

describe('the active client', () => {
  test('the presence active client first, then the most recently active online one', () => {
    const a = client({ id: 'a', lastActiveAt: 10 })
    const b = client({ id: 'b', lastActiveAt: 20 })
    const off = client({ id: 'c', lastActiveAt: 99, online: false })
    expect(activeClientOf([a, b, off], null)?.id).toBe('b')
    expect(activeClientOf([a, b], 'a')?.id).toBe('a')
    expect(activeClientOf([off], null)).toBeUndefined()
  })
})

describe('clientContextBlock', () => {
  test('no online client means no block at all', () => {
    expect(
      clientContextBlock({
        clients: [client({ online: false })],
        activeClient: null,
        now: NOW,
      }),
    ).toBeUndefined()
    expect(clientContextBlock({ clients: [], activeClient: null, now: NOW })).toBeUndefined()
  })

  test('the block names the app, host, OS, device, network and local time, in at most six lines', () => {
    const block = clientContextBlock({
      clients: [client()],
      activeClient: null,
      now: NOW,
    })
    expect(block).toBeDefined()
    const lines = (block ?? '').split('\n')
    expect(lines[0]).toBe(CLIENT_CONTEXT_HEADING)
    expect(block).toContain(
      'App: the terminal app "ana-laptop", host "ana-laptop", macos 16.0 arm64, a laptop.',
    )
    expect(block).toContain('Network: loopback.')
    expect(block).toContain('Local time: Thu 14:05 (Europe/Paris).')
    expect(lines.length).toBeLessThanOrEqual(6)
  })

  test('the line about the missing location sensor is there while no online client announced location.share', () => {
    const block = clientContextBlock({ clients: [client()], activeClient: null, now: NOW }) ?? ''
    expect(block).toContain('No location sensor is online')
    expect(block).toContain('answer from what the host, the network and the time zone show')
    expect(block).toContain('never name a city, address or building as a fact')
    expect(block).toContain('say plainly that the exact place is not known')
    const sensor = client({ capabilities: ['chat', 'location.share'] })
    const withSensor = clientContextBlock({ clients: [sensor], activeClient: null, now: NOW }) ?? ''
    expect(withSensor).not.toContain('No location sensor is online')
  })

  test('the block is written with no setting involved: the active client is the one of the block', () => {
    const other = client({
      id: 'other',
      lastActiveAt: NOW - 120_000,
      label: 'ana-phone',
      kind: 'mobile',
    })
    expect(
      clientContextBlock({ clients: [other, client()], activeClient: null, now: NOW }),
    ).toContain('App: the terminal app "ana-laptop"')
  })

  test('a client without environment still gets its app and network, and no host, OS or time', () => {
    const block =
      clientContextBlock({
        clients: [client({ environment: undefined })],
        activeClient: null,
        now: NOW,
      }) ?? ''
    expect(block).toContain('App: the terminal app "ana-laptop".')
    expect(block).not.toContain('Local time')
    expect(block).toContain('Network: loopback.')
  })

  test('the texts of a client are cleaned: control characters, quotes and angle brackets are removed, the host is cut', () => {
    const hostile = client({
      label: 'x"<script>\u001b[2J',
      environment: { ...ENV, host: `${'h'.repeat(70)}\u0007\n` },
    })
    const block = clientContextBlock({ clients: [hostile], activeClient: null, now: NOW }) ?? ''
    expect(block).not.toContain('<')
    expect(block).not.toContain('\u001b')
    expect(block).not.toContain('\u0007')
    expect(block).toContain(`host "${'h'.repeat(60)}"`)
  })

  test('an unknown time zone leaves the clock out instead of failing', () => {
    expect(localClockOf('Not/AZone', NOW)).toBeUndefined()
    const block =
      clientContextBlock({
        clients: [client({ environment: { ...ENV, timezone: 'Not/AZone' } })],
        activeClient: null,
        now: NOW,
      }) ?? ''
    expect(block).not.toContain('Local time')
    expect(block).toContain('App: the terminal app')
  })
})
