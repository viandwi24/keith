/// <reference lib="dom" />
import { Pcm16Encoder } from './pcm.ts'

/**
 * Microphone capture: `getUserMedia` with the browser's echo cancellation (the core does no AEC),
 * an AudioWorklet that hands raw float samples to the page in 20 ms batches, and a `Pcm16Encoder`
 * that turns them into 16 kHz PCM16 chunks of 320 samples (ADR-0013). No VAD here: the core's VAD
 * decides turns.
 */

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

export const MIC_PROCESSOR_NAME = 'keith-mic'

/**
 * The worklet module, loaded from a Blob URL so the bundler needs no extra entry. It copies the
 * first input channel into batches of `processorOptions.batch` samples and posts each batch
 * (transferred) to the page. It outputs silence.
 */
export const MIC_WORKLET_SOURCE = `
class KeithMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = Math.max(128, (options.processorOptions && options.processorOptions.batch) || 960)
    this.buffer = new Float32Array(this.size)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i]
        if (this.filled === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer])
          this.buffer = new Float32Array(this.size)
          this.filled = 0
        }
      }
    }
    return true
  }
}
registerProcessor('${MIC_PROCESSOR_NAME}', KeithMicProcessor)
`

export type MicCapture = {
  /** The capture context's rate (what the encoder downsamples from). */
  readonly sampleRate: number
  /** Stops the tracks (the browser's mic indicator goes off) and closes the context. */
  close(): Promise<void>
}

/** Why the mic could not open, as a short sentence for the chat screen. Text chat keeps working. */
export function micErrorMessage(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it in the browser to talk; text chat still works.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Text chat still works.'
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable. Text chat still works.'
    case 'MicUnsupportedError':
      return 'This browser cannot use the microphone here (it needs HTTPS or localhost). Text chat still works.'
    default:
      return 'The microphone could not start. Text chat still works.'
  }
}

function unsupported(): Error {
  const error = new Error('getUserMedia is not available')
  error.name = 'MicUnsupportedError'
  return error
}

/**
 * Opens the default microphone and calls `onChunk` with each 20 ms PCM16 chunk at 16 kHz until
 * `close()`. Rejects (see `micErrorMessage`) when permission is denied or there is no mic.
 */
export async function openMic(onChunk: (pcm16: Int16Array) => void): Promise<MicCapture> {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media?.getUserMedia || typeof AudioWorkletNode === 'undefined') throw unsupported()
  const stream = await media.getUserMedia({ audio: MIC_CONSTRAINTS })
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop()
  }
  let context: AudioContext | null = null
  try {
    context = new AudioContext()
    const url = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, MIC_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { batch: Math.round(context.sampleRate / 50) },
    })
    const encoder = new Pcm16Encoder(context.sampleRate)
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const chunk of encoder.push(event.data)) onChunk(chunk)
    }
    source.connect(node)
    // The node outputs silence; connecting it keeps the graph rendering in every browser.
    node.connect(context.destination)
    if (context.state === 'suspended') await context.resume()
    const ctx = context
    return {
      sampleRate: ctx.sampleRate,
      async close() {
        node.port.onmessage = null
        source.disconnect()
        node.disconnect()
        stopTracks()
        await ctx.close().catch(() => {})
      },
    }
  } catch (error) {
    stopTracks()
    await context?.close().catch(() => {})
    throw error
  }
}
