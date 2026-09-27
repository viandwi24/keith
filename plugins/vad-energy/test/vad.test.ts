import { describe, expect, test } from 'bun:test'
import { isProviderError, type VadEvent, type VadProvider } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { createEnergyVad, ENERGY_VAD_ID, levelDb } from '../src/index.ts'
import { chunk, ROOM, SPEECH, silence, speech, synth } from './signal.ts'

function run(
  pcm: Int16Array,
  opts: { sampleRate?: number; vad?: VadProvider; chunks?: number[] } = {},
): VadEvent[] {
  const stream = (opts.vad ?? createEnergyVad()).create({ sampleRate: opts.sampleRate ?? 16_000 })
  const parts = opts.chunks ? chunk(pcm, opts.chunks) : [pcm]
  const events = parts.flatMap((p) => stream.push(p))
  stream.close()
  return events
}

function expectOneUtterance(events: VadEvent[], startMs: number, endMs: number): void {
  expect(events.map((e) => e.type)).toEqual(['speech.start', 'speech.end'])
  const [start, end] = events
  expect(Math.abs((start?.atMs ?? Number.NaN) - startMs)).toBeLessThanOrEqual(40)
  expect(Math.abs((end?.atMs ?? Number.NaN) - endMs)).toBeLessThanOrEqual(40)
}

describe('levelDb', () => {
  test('full-scale square wave is 0 dBFS and zeros are the silence level', () => {
    expect(levelDb(new Int16Array([-32768, -32768]))).toBeCloseTo(0, 5)
    expect(levelDb(new Int16Array(160))).toBe(-120)
    expect(levelDb(new Int16Array(0))).toBe(-120)
  })
})

describe('energy VAD', () => {
  test('S-7: silence produces no events', () => {
    expect(run(synth([silence(5000)]))).toEqual([])
    expect(run(new Int16Array(16_000 * 3))).toEqual([])
  })

  test('S-7: silence, 600 ms of speech-level noise, silence gives one start and one end at the boundaries', () => {
    const events = run(synth([silence(1000), speech(600), silence(1500)]))
    expectOneUtterance(events, 1000, 1600)
  })

  test('boundaries off the frame grid are still within 40 ms', () => {
    const events = run(synth([silence(1013), speech(600), silence(1500)]))
    expectOneUtterance(events, 1013, 1613)
  })

  test('a tone at speech level counts as speech', () => {
    const events = run(synth([silence(800), { kind: 'tone', ms: 700, amp: 4000, hz: 440 }, silence(1000)]))
    expectOneUtterance(events, 800, 1500)
  })

  test('works at other sample rates because frames are sized by time', () => {
    for (const rate of [8000, 24_000, 44_100, 48_000]) {
      const events = run(synth([silence(1000), speech(600), silence(1500)], rate), { sampleRate: rate })
      expectOneUtterance(events, 1000, 1600)
    }
  })

  test('a 60 ms click does not start speech', () => {
    expect(run(synth([silence(1000), { kind: 'noise', ms: 60, amp: 20_000 }, silence(1000)]))).toEqual([])
  })

  test('a pause shorter than hangoverMs does not end speech', () => {
    const events = run(synth([silence(1000), speech(400), silence(250), speech(400), silence(1500)]))
    expectOneUtterance(events, 1000, 2050)
  })

  test('a pause longer than hangoverMs splits into two utterances', () => {
    const events = run(synth([silence(1000), speech(400), silence(900), speech(400), silence(1500)]))
    expect(events).toEqual([
      { type: 'speech.start', atMs: 1000 },
      { type: 'speech.end', atMs: 1400 },
      { type: 'speech.start', atMs: 2300 },
      { type: 'speech.end', atMs: 2700 },
    ])
  })

  test('a slowly rising noise floor (fan noise) does not start speech', () => {
    // ~-75 dBFS to ~-35 dBFS over 12 s: 40 dB, far more than startDb, but slow.
    const pcm = synth([
      silence(1000),
      { kind: 'ramp', ms: 12_000, fromAmp: ROOM, toAmp: 1000 },
      { kind: 'noise', ms: 3000, amp: 1000 },
    ])
    expect(run(pcm)).toEqual([])
  })

  test('speech over fan noise is still detected once the floor has adapted', () => {
    const fan = 1000
    const pcm = synth([
      { kind: 'ramp', ms: 8000, fromAmp: ROOM, toAmp: fan },
      { kind: 'noise', ms: 3000, amp: fan },
      { kind: 'noise', ms: 600, amp: SPEECH * 4 },
      { kind: 'noise', ms: 1500, amp: fan },
    ])
    expectOneUtterance(run(pcm), 11_000, 11_600)
  })

  test('push with chunks of arbitrary sizes gives the same events as one large push', () => {
    const pcm = synth([
      silence(1000),
      speech(400),
      silence(250),
      speech(300),
      silence(900),
      speech(600),
      silence(1200),
    ])
    const whole = run(pcm)
    expect(whole.length).toBe(4)
    for (const sizes of [[1], [7, 3, 1000, 1], [320], [319, 321], [4096], [17, 90_000]]) {
      expect(run(pcm, { chunks: sizes })).toEqual(whole)
    }
  })

  test('each stream has its own state and time origin', () => {
    const vad = createEnergyVad()
    const a = vad.create({ sampleRate: 16_000 })
    a.push(synth([silence(1000), speech(300)]))
    const b = vad.create({ sampleRate: 16_000 })
    expect(b.push(synth([silence(500), speech(600), silence(1000)]))).toEqual([
      { type: 'speech.start', atMs: 500 },
      { type: 'speech.end', atMs: 1100 },
    ])
  })

  test('push after close returns no events and does not throw', () => {
    const stream = createEnergyVad().create({ sampleRate: 16_000 })
    stream.close()
    expect(stream.push(synth([silence(500), speech(600), silence(1000)]))).toEqual([])
    expect(stream.push(new Int16Array(0))).toEqual([])
  })

  test('thresholds come from options', () => {
    const pcm = synth([silence(1000), speech(100), silence(1000)])
    expect(run(pcm)).toEqual([])
    expectOneUtterance(run(pcm, { vad: createEnergyVad({ minSpeechMs: 60, hangoverMs: 200 }) }), 1000, 1100)
  })

  test('rejects invalid options and sample rates', () => {
    expect(() => createEnergyVad({ startDb: 6, endDb: 10 })).toThrow()
    expect(() => createEnergyVad({ frameMs: 5 })).toThrow()
    let error: unknown
    try {
      createEnergyVad().create({ sampleRate: 0 })
    } catch (e) {
      error = e
    }
    expect(isProviderError(error) && error.code === 'bad_request').toBe(true)
  })
})

describe('plugin', () => {
  test('registers the vad provider "energy" with default config', async () => {
    const ctx = await setupFakePlugin(plugin)
    expect(ctx.recorded.vad.map((p) => p.id)).toEqual([ENERGY_VAD_ID])
    expect(ENERGY_VAD_ID).toBe('energy')
  })

  test('passes config thresholds to the provider', async () => {
    const ctx = await setupFakePlugin(plugin, { config: { minSpeechMs: 60, hangoverMs: 200 } })
    const vad = ctx.recorded.vad[0]
    if (!vad) throw new Error('no vad registered')
    expectOneUtterance(run(synth([silence(1000), speech(100), silence(1000)]), { vad }), 1000, 1100)
  })

  test('invalid config fails with CONFIG_INVALID', async () => {
    await expect(setupFakePlugin(plugin, { config: { startDb: 6, endDb: 10 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
  })
})
