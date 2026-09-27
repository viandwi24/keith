import { AUDIO_IN_CHUNK_SAMPLES, AUDIO_IN_SAMPLE_RATE } from '@keith/client'

/**
 * Microphone samples → what the core expects (ADR-0013): PCM16 mono at 16 kHz in 20 ms chunks.
 * Pure and streaming, so it runs anywhere and is tested in Bun. The mic worklet hands the raw
 * float samples at the `AudioContext` rate (usually 48 kHz or 44.1 kHz) to a `Pcm16Encoder`.
 */

/** A float sample in [-1, 1] → int16 (clamped, rounded; -1 → -32768, 1 → 32767). */
export function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
}

/**
 * Downsamples a float stream from `inputRate` to `outputRate` (≤ `inputRate`) and converts it to
 * int16. Each output sample is the mean of the input samples in its window (a box low-pass that
 * keeps most aliasing out of the speech band). Window bounds are computed from the absolute
 * sample count in integers, so a long stream never drifts. Keeps the tail of one call for the next.
 */
export class Downsampler {
  readonly inputRate: number
  readonly outputRate: number
  /** Input samples not yet consumed. */
  private tail = new Float32Array(0)
  /** Absolute index of `tail[0]` in the input stream. */
  private tailStart = 0
  /** Output samples produced so far. */
  private produced = 0

  constructor(inputRate: number, outputRate = AUDIO_IN_SAMPLE_RATE) {
    if (!(outputRate > 0 && inputRate >= outputRate)) {
      throw new RangeError(`cannot downsample from ${inputRate} Hz to ${outputRate} Hz`)
    }
    this.inputRate = inputRate
    this.outputRate = outputRate
  }

  /** First input index of output sample `n`. */
  private boundary(n: number): number {
    return Math.floor((n * this.inputRate) / this.outputRate)
  }

  push(input: Float32Array): Int16Array {
    const buf = new Float32Array(this.tail.length + input.length)
    buf.set(this.tail)
    buf.set(input, this.tail.length)
    const end = this.tailStart + buf.length
    const out: number[] = []
    for (;;) {
      const from = this.boundary(this.produced)
      const to = this.boundary(this.produced + 1)
      if (to > end) break
      let sum = 0
      for (let i = from; i < to; i++) sum += buf[i - this.tailStart] ?? 0
      out.push(floatToInt16(sum / (to - from)))
      this.produced += 1
    }
    const keepFrom = this.boundary(this.produced)
    this.tail = buf.slice(keepFrom - this.tailStart)
    this.tailStart = keepFrom
    return Int16Array.from(out)
  }
}

/** Cuts an int16 stream into chunks of exactly `size` samples (default 320: 20 ms at 16 kHz). */
export class Pcm16Chunker {
  readonly size: number
  private buffer: Int16Array
  private filled = 0

  constructor(size = AUDIO_IN_CHUNK_SAMPLES) {
    this.size = size
    this.buffer = new Int16Array(size)
  }

  push(samples: Int16Array): Int16Array[] {
    const chunks: Int16Array[] = []
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(this.size - this.filled, samples.length - offset)
      this.buffer.set(samples.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === this.size) {
        chunks.push(this.buffer)
        this.buffer = new Int16Array(this.size)
        this.filled = 0
      }
    }
    return chunks
  }

  /** Drops a partial chunk (the stream ended). */
  reset(): void {
    this.filled = 0
  }
}

/** Float samples at the mic's rate in, 20 ms PCM16 chunks at 16 kHz out. */
export class Pcm16Encoder {
  private readonly downsampler: Downsampler
  private readonly chunker = new Pcm16Chunker()

  constructor(inputRate: number) {
    this.downsampler = new Downsampler(inputRate)
  }

  push(input: Float32Array): Int16Array[] {
    return this.chunker.push(this.downsampler.push(input))
  }
}
