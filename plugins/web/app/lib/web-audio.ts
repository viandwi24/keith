/// <reference lib="dom" />
import type { PlaybackSink } from '@keith/client'

/**
 * Playback of the core's audio with Web Audio: each chunk becomes an `AudioBuffer` at the rate the
 * core announced in `audio.start`, played by an `AudioBufferSourceNode` started at the time the
 * `@keith/client` playback queue picked, so chunks play back to back. `stop()` cuts a node at once.
 */

/** The part of `AudioContext` playback needs (a fake in tests). */
export type PlaybackContext = Pick<
  AudioContext,
  'currentTime' | 'state' | 'destination' | 'createBuffer' | 'createBufferSource' | 'resume' | 'close'
>

export type AudioOutput = {
  sink: PlaybackSink
  /** Resumes a context the autoplay policy suspended. Call it from a user gesture. */
  resume(): Promise<void>
  close(): Promise<void>
}

export function webAudioSink(context: PlaybackContext): PlaybackSink {
  return {
    now: () => context.currentTime,
    play(samples, sampleRate, at, onEnded) {
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.getChannelData(0).set(samples)
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      node.onended = () => {
        node.disconnect()
        onEnded()
      }
      if (context.state === 'suspended') context.resume().catch(() => {})
      node.start(at)
      return {
        stop() {
          node.onended = null
          try {
            node.stop()
          } catch {
            // Already stopped.
          }
          node.disconnect()
        },
      }
    },
  }
}

/** A playback `AudioContext`, created on first use. */
export function createAudioOutput(create: () => PlaybackContext = () => new AudioContext()): AudioOutput {
  let context: PlaybackContext | null = null
  const get = () => {
    context ??= create()
    return context
  }
  const sink: PlaybackSink = {
    now: () => get().currentTime,
    play: (samples, sampleRate, at, onEnded) => webAudioSink(get()).play(samples, sampleRate, at, onEnded),
  }
  return {
    sink,
    async resume() {
      const ctx = get()
      if (ctx.state === 'suspended') await ctx.resume()
    },
    async close() {
      const ctx = context
      context = null
      await ctx?.close().catch(() => {})
    },
  }
}
