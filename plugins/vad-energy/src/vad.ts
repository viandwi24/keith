/**
 * An energy VAD: RMS level in dBFS per fixed-duration frame, compared against an adaptive noise floor.
 *
 * - Speech starts when the level stays at or above `floor + startDb` for `minSpeechMs`.
 * - Speech ends when the level stays below `floor + endDb` for `hangoverMs`.
 * - The floor follows the level with a slow EMA (`floorRiseMs`) upward and a faster one (`floorFallMs`)
 *   downward, and only while not speaking. It starts at the first frame's level and never drops below
 *   `floorMinDb`.
 * - Event `atMs` is the boundary itself (the first frame of the loud or quiet run), measured from the
 *   stream's first sample, not the moment the event was confirmed.
 */
import { ProviderError, type VadEvent, type VadProvider, type VadStream } from '@keith/sdk'
import { z } from 'zod'

export const ENERGY_VAD_ID = 'energy'

/** Level reported for an all-zero frame. */
const SILENCE_DB = -120

export const energyVadOptions = z
  .object({
    /** Analysis frame length. Frames are sized by time, so any sample rate works. */
    frameMs: z.number().min(10).max(50).default(20),
    /** dB above the noise floor that counts as speech for a start. */
    startDb: z.number().positive().default(12),
    /** dB above the noise floor below which speech counts as ended. Keep it at or below `startDb`. */
    endDb: z.number().positive().default(8),
    /** How long the level must stay above the start threshold before `speech.start`. */
    minSpeechMs: z.number().min(0).default(120),
    /** How long the level must stay below the end threshold before `speech.end`. */
    hangoverMs: z.number().min(0).default(500),
    /** Lowest value of the noise floor, so near-digital silence doesn't make tiny sounds count as speech. */
    floorMinDb: z.number().max(0).default(-70),
    /** Time constant of the floor's EMA when the level is above it (slow: fan noise, not speech). */
    floorRiseMs: z.number().positive().default(1500),
    /** Time constant of the floor's EMA when the level is below it. */
    floorFallMs: z.number().positive().default(150),
  })
  .refine((o) => o.endDb <= o.startDb, { message: 'endDb must not exceed startDb', path: ['endDb'] })

export type EnergyVadOptions = z.output<typeof energyVadOptions>
export type EnergyVadOptionsInput = z.input<typeof energyVadOptions>

/** Level of PCM16 samples as RMS in dBFS (full scale = 32768). */
export function levelDb(samples: Int16Array): number {
  if (samples.length === 0) return SILENCE_DB
  let sum = 0
  for (const s of samples) sum += s * s
  const rms = Math.sqrt(sum / samples.length)
  return rms === 0 ? SILENCE_DB : Math.max(SILENCE_DB, 20 * Math.log10(rms / 32768))
}

export function createEnergyVad(input: EnergyVadOptionsInput = {}): VadProvider {
  const opts = energyVadOptions.parse(input)
  return {
    id: ENERGY_VAD_ID,
    create({ sampleRate }) {
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new ProviderError('bad_request', `invalid sample rate: ${sampleRate}`)
      }
      return createEnergyVadStream(opts, sampleRate)
    },
  }
}

function createEnergyVadStream(opts: EnergyVadOptions, sampleRate: number): VadStream {
  const frameSamples = Math.max(1, Math.round((sampleRate * opts.frameMs) / 1000))
  const frameMs = (frameSamples * 1000) / sampleRate
  const riseAlpha = 1 - Math.exp(-frameMs / opts.floorRiseMs)
  const fallAlpha = 1 - Math.exp(-frameMs / opts.floorFallMs)

  const frame = new Int16Array(frameSamples)
  let filled = 0
  let frameIndex = 0
  let floor: number | undefined
  let speaking = false
  /** Start frame of the current run that may flip the state (loud run while silent, quiet run while speaking). */
  let runStart = -1
  let closed = false

  const msAt = (index: number): number => Math.round((index * frameSamples * 1000) / sampleRate)

  function processFrame(out: VadEvent[]): void {
    const level = levelDb(frame)
    const f = Math.max(opts.floorMinDb, floor ?? level)
    const index = frameIndex++

    if (!speaking) {
      if (level >= f + opts.startDb) {
        if (runStart < 0) runStart = index
        if ((index + 1 - runStart) * frameMs >= opts.minSpeechMs) {
          speaking = true
          out.push({ type: 'speech.start', atMs: msAt(runStart) })
          runStart = -1
        }
      } else {
        runStart = -1
      }
      if (!speaking) {
        const alpha = level > f ? riseAlpha : fallAlpha
        floor = Math.max(opts.floorMinDb, f + alpha * (level - f))
      }
      return
    }

    floor = f
    if (level < f + opts.endDb) {
      if (runStart < 0) runStart = index
      if ((index + 1 - runStart) * frameMs >= opts.hangoverMs) {
        speaking = false
        out.push({ type: 'speech.end', atMs: msAt(runStart) })
        runStart = -1
      }
    } else {
      runStart = -1
    }
  }

  return {
    push(pcm16) {
      const out: VadEvent[] = []
      if (closed) return out
      let offset = 0
      while (offset < pcm16.length) {
        const n = Math.min(frameSamples - filled, pcm16.length - offset)
        frame.set(pcm16.subarray(offset, offset + n), filled)
        filled += n
        offset += n
        if (filled === frameSamples) {
          processFrame(out)
          filled = 0
        }
      }
      return out
    },
    close() {
      closed = true
    },
  }
}
