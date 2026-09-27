import { describe, expect, test } from 'bun:test'
import { Downsampler, floatToInt16, Pcm16Chunker, Pcm16Encoder } from './pcm.ts'

describe('floatToInt16', () => {
  test('maps the float range onto int16, clamped and rounded', () => {
    expect([1, -1, 0, 0.5, -0.5, 2, -2, Number.NaN].map(floatToInt16)).toEqual([
      32767, -32768, 0, 16384, -16384, 32767, -32768, 0,
    ])
  })
})

describe('Downsampler (48 kHz float → 16 kHz int16)', () => {
  test('averages each window of three input samples', () => {
    const down = new Downsampler(48_000, 16_000)
    const input = Float32Array.from([0.5, 0.5, 0.5, 1, 1, 1, -1, -1, -1, 0.3, 0.6, 0.9])
    expect([...down.push(input)]).toEqual([16384, 32767, -32768, floatToInt16(0.6)])
  })

  test('keeps the partial window for the next call', () => {
    const whole = new Downsampler(48_000)
    const split = new Downsampler(48_000)
    const input = Float32Array.from({ length: 999 }, (_, i) => Math.sin(i / 7) * 0.8)
    const expected = [...whole.push(input)]
    const got = [
      ...split.push(input.subarray(0, 4)),
      ...split.push(input.subarray(4, 500)),
      ...split.push(input.subarray(500)),
    ]
    expect(got).toEqual(expected)
    expect(expected).toHaveLength(333)
  })

  test('a 1 kHz sine keeps its level; a 16 kHz tone (which would alias to 0 Hz) is removed', () => {
    const tone = (hz: number) =>
      Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 48_000))
    const rms = (s: Int16Array) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length) / 32768
    const low = new Downsampler(48_000).push(tone(1000))
    const high = new Downsampler(48_000).push(tone(16_000))
    expect(low).toHaveLength(1600)
    expect(rms(low)).toBeGreaterThan(0.33)
    expect(rms(high)).toBeLessThan(0.01)
  })

  test('44.1 kHz input gives 16 000 samples per second with no drift', () => {
    const down = new Downsampler(44_100)
    let count = 0
    for (let i = 0; i < 100; i++) count += down.push(new Float32Array(441).fill(0.25)).length
    expect(count).toBe(16_000)
  })

  test('16 kHz input passes through', () => {
    const down = new Downsampler(16_000)
    expect([...down.push(Float32Array.from([0, 0.5, -1]))]).toEqual([0, 16384, -32768])
  })

  test('refuses to upsample', () => {
    expect(() => new Downsampler(8_000)).toThrow(RangeError)
  })
})

describe('Pcm16Chunker and Pcm16Encoder', () => {
  test('cuts exact chunks across pushes', () => {
    const chunker = new Pcm16Chunker(4)
    const a = chunker.push(Int16Array.from([1, 2, 3]))
    const b = chunker.push(Int16Array.from([4, 5, 6, 7, 8, 9]))
    expect(a).toEqual([])
    expect(b.map((c) => [...c])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ])
    chunker.reset()
    expect(chunker.push(Int16Array.from([10, 11, 12, 13])).map((c) => [...c])).toEqual([[10, 11, 12, 13]])
  })

  test('48 kHz mic blocks become 20 ms chunks of 320 samples', () => {
    const encoder = new Pcm16Encoder(48_000)
    const chunks: Int16Array[] = []
    // The worklet hands over 128-sample render quanta: 75 of them are 200 ms.
    for (let i = 0; i < 75; i++) chunks.push(...encoder.push(new Float32Array(128).fill(-0.5)))
    expect(chunks).toHaveLength(10)
    expect(chunks.every((c) => c.length === 320 && c.every((s) => s === -16384))).toBe(true)
  })
})
