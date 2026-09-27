/**
 * Opt-in live smoke test (R-13 exception): `KEITH_LIVE=1 bun test live`. Skipped by default and in
 * CI. Hits the real Open-Meteo APIs (keyless).
 */
import { expect, test } from 'bun:test'
import { createOpenMeteo } from '../src/index.ts'

test.skipIf(process.env.KEITH_LIVE !== '1')(
  'live: Open-Meteo forecast for Berlin',
  async () => {
    const f = await createOpenMeteo().forecast('Berlin', 'metric', AbortSignal.timeout(20_000))
    expect(f.city).toBe('Berlin')
    expect(f.hourly.length).toBeGreaterThan(0)
    expect(typeof f.current.temperature).toBe('number')
    expect(f.today?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  },
  30_000,
)
