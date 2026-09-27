/** Deterministic synthetic PCM16 signals for VAD tests. Nothing binary is committed. */

export type Segment =
  | { kind: 'noise'; ms: number; amp: number }
  | { kind: 'tone'; ms: number; amp: number; hz: number }
  /** Noise whose amplitude moves exponentially from `fromAmp` to `toAmp` over the segment. */
  | { kind: 'ramp'; ms: number; fromAmp: number; toAmp: number }

/** Room silence: very quiet noise (about -75 dBFS). */
export const ROOM = 10
/** Speech-level noise (about -25 dBFS). */
export const SPEECH = 3000

export const silence = (ms: number): Segment => ({ kind: 'noise', ms, amp: ROOM })
export const speech = (ms: number): Segment => ({ kind: 'noise', ms, amp: SPEECH })

/** mulberry32: a small seeded PRNG, so fixtures are identical on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function synth(segments: Segment[], sampleRate = 16_000, seed = 1): Int16Array {
  const rand = prng(seed)
  const total = segments.reduce((n, s) => n + Math.round((s.ms * sampleRate) / 1000), 0)
  const out = new Int16Array(total)
  let i = 0
  for (const s of segments) {
    const n = Math.round((s.ms * sampleRate) / 1000)
    for (let k = 0; k < n; k++, i++) {
      let v: number
      if (s.kind === 'noise') v = (rand() * 2 - 1) * s.amp
      else if (s.kind === 'tone') v = Math.sin((2 * Math.PI * s.hz * k) / sampleRate) * s.amp
      else v = (rand() * 2 - 1) * s.fromAmp * (s.toAmp / s.fromAmp) ** (k / n)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v)))
    }
  }
  return out
}

/** Splits `pcm` into consecutive chunks of the given sizes, cycling through them. */
export function chunk(pcm: Int16Array, sizes: number[]): Int16Array[] {
  const out: Int16Array[] = []
  let offset = 0
  let k = 0
  while (offset < pcm.length) {
    const size = sizes[k++ % sizes.length] ?? 1
    out.push(pcm.subarray(offset, offset + size))
    offset += size
  }
  return out
}
