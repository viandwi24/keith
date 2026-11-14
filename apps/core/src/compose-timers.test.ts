import { describe, expect, test } from 'bun:test'
import { createProtocolTimer, createPrune, type PruneDeps } from './compose-timers.ts'

describe('the protocol timer', () => {
  test('a tick setting that cannot be read does not throw out of the timer: it warns once and the timer can be stopped', async () => {
    const warnings: string[] = []
    let beats = 0
    const timer = createProtocolTimer({
      tickMs() {
        throw new Error('disk I/O error')
      },
      async beat() {
        beats += 1
      },
      warn: (message) => warnings.push(message),
    })
    // arming read the setting once, failed, and kept the timer: stopping it must not throw either
    await timer.stop()
    expect(beats).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('tick setting unreadable')
  })

  test('re-arming after a tick survives a setting that became unreadable in between', async () => {
    const warnings: string[] = []
    let calls = 0
    let beats = 0
    const timer = createProtocolTimer({
      tickMs() {
        calls += 1
        // the first arm reads fine (1 ms), every later read fails like a closed database
        if (calls === 1) return 1
        throw new Error('disk I/O error')
      },
      async beat() {
        beats += 1
      },
      warn: (message) => warnings.push(message),
    })
    await Bun.sleep(40)
    await timer.stop()
    expect(beats).toBe(1)
    expect(warnings.filter((w) => w.includes('unreadable'))).toHaveLength(1)
  })

  test('three unreadable settings in a row (a closed database) end the timer chain: no timer is left re-arming', async () => {
    const warnings: string[] = []
    let reads = 0
    const real = globalThis.setTimeout
    let scheduled = 0
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      // only the timer chain under test counts: `bun test` runs every file in one process, and another file's timers
      // set during these 50 ms are not re-arms of this chain
      if (/compose-timers\.ts/.test(new Error().stack ?? '')) scheduled += 1
      // fire at once so the chain runs to its end inside the test
      return real(fn, 0 * (ms ?? 0))
    }) as typeof setTimeout
    try {
      const timer = createProtocolTimer({
        tickMs() {
          reads += 1
          throw new Error('disk I/O error')
        },
        async beat() {},
        warn: (message) => warnings.push(message),
      })
      await Bun.sleep(50)
      await timer.stop()
    } finally {
      globalThis.setTimeout = real
    }
    expect(reads).toBe(3)
    expect(scheduled).toBe(2)
    expect(warnings.some((w) => w.includes('stops until the next start'))).toBe(true)
  })
})

describe('the prune tick (P30.4.1: the room sweep)', () => {
  /** A prune tick whose tables are no-ops, except the room sweep and the stream log, which the tests count. */
  function tick(sweep: () => unknown) {
    const warnings: string[] = []
    let streamPurges = 0
    const deps = {
      logger: {
        debug() {},
        info() {},
        error() {},
        warn: (message: string) => warnings.push(message),
      },
      sqlite: {} as PruneDeps['sqlite'],
      audit: {} as PruneDeps['audit'],
      store: { prune: async () => {} },
      rooms: { sweep },
      reviews: { sweep() {}, purgeDecided: () => 0 },
      auditRetention: { prune() {} },
      deviceLogin: { purge() {} },
      removal: { purge: async () => ({ failed: [] }) },
      streams: {
        purgeExpired() {
          streamPurges += 1
        },
      },
      pairing: { purgeExpired: () => 0 },
      retention: { pairingCodesMs: 1000 } as PruneDeps['retention'],
    } as unknown as PruneDeps
    return { run: createPrune(deps), warnings, streamPurges: () => streamPurges }
  }

  test('every tick sweeps the rooms once, between the ended rows and the stream log', async () => {
    let sweeps = 0
    const t = tick(() => {
      sweeps += 1
      return { invites: 0, requests: 0 }
    })
    await t.run()
    await t.run()
    expect(sweeps).toBe(2)
    expect(t.streamPurges()).toBe(2)
  })

  test('a failing room sweep is logged and the rest of the tick still runs', async () => {
    const t = tick(() => {
      throw new Error('database is locked')
    })
    await t.run()
    expect(t.warnings).toContain('room sweep failed: database is locked')
    expect(t.streamPurges()).toBe(1)
  })
})
