import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, presenceSignalsRepo } from '@keith/db'
import { createOverlayRegistry } from './overlay.ts'
import { createParietalPorts } from './ports.ts'

// The ports of the region (docs/specs/parietal.md, "Ports"): `lastSign` counts only the signals that name a sign-in
// or use, `disclosedFor` answers from the rule it is given, `addOverlay` registers a source.

const setup = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const signals = presenceSignalsRepo(sqlite)
  const overlays = createOverlayRegistry()
  const disclosure = { disclosedFor: async () => ({ level: 'none' as const, line: null }) }
  return { signals, overlays, ports: createParietalPorts({ signals, overlays, disclosure }) }
}

describe('lastSign', () => {
  test('is null before any signal', async () => {
    const { ports } = setup()
    expect(await ports.lastSign('ana')).toBeNull()
  })

  test('counts activity, client.active and client.connected, newest wins', async () => {
    const { signals, ports } = setup()
    signals.record({ personId: 'ana', clientId: 'c1', type: 'client.connected', at: 100 })
    expect(await ports.lastSign('ana')).toBe(100)
    signals.record({ personId: 'ana', clientId: 'c1', type: 'client.active', at: 200 })
    expect(await ports.lastSign('ana')).toBe(200)
    signals.record({ personId: 'ana', type: 'activity', at: 300 })
    expect(await ports.lastSign('ana')).toBe(300)
  })

  test('ignores node.event and any other person', async () => {
    const { signals, ports } = setup()
    signals.record({ personId: 'ana', type: 'node.event', at: 900 })
    signals.record({ personId: 'ben', type: 'activity', at: 800 })
    expect(await ports.lastSign('ana')).toBeNull()
    expect(await ports.lastSign('ben')).toBe(800)
  })

  test('a heartbeat without active writes no signal, so it does not count', async () => {
    const { ports } = setup()
    // a heartbeat with active false writes nothing (the service never records a signal for it)
    expect(await ports.lastSign('ana')).toBeNull()
  })
})

describe('ports', () => {
  test('disclosedFor answers from the disclosure rule it is given', async () => {
    const { ports } = setup()
    expect(await ports.disclosedFor('ben', 'ana')).toEqual({ level: 'none', line: null })
  })

  test('addOverlay registers a source the overlay registry answers from', () => {
    const { ports, overlays } = setup()
    ports.addOverlay({ id: 'agenda', busy: () => ({ note: 'standup', until: 5 }) })
    expect(overlays.busyOf('ana', 1)).toEqual({ note: 'standup', until: 5 })
  })
})
