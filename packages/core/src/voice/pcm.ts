// PCM16LE helpers for the voice pipeline (ADR-0013): bytes <-> samples, linear resampling.

/** The rate the VAD and STT see. Nodes send it in v1; other rates are resampled to it. */
export const PIPELINE_SAMPLE_RATE = 16_000

/**
 * PCM16LE bytes to samples. An odd trailing byte (not a whole sample) is dropped. Reads through a
 * DataView, so the payload may start at any byte offset.
 */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const count = bytes.byteLength >> 1
  const out = new Int16Array(count)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/** Samples to PCM16LE bytes. */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true)
  return out
}

/**
 * Linear-interpolation resampler, one chunk at a time (v1: good enough for speech; each chunk is
 * resampled on its own, so chunk edges are not interpolated across).
 */
export function resampleLinear(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || samples.length === 0) return samples
  const length = Math.max(1, Math.round((samples.length * to) / from))
  const out = new Int16Array(length)
  const step = from / to
  const last = samples.length - 1
  for (let i = 0; i < length; i++) {
    const pos = i * step
    const left = Math.min(Math.floor(pos), last)
    const right = Math.min(left + 1, last)
    const frac = pos - left
    const a = samples[left] ?? 0
    const b = samples[right] ?? 0
    out[i] = Math.round(a + (b - a) * frac)
  }
  return out
}

export function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples * 1000) / sampleRate
}
