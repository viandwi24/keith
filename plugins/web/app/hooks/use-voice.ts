import {
  type AudioEvent,
  type AudioSupport,
  type ChatClient,
  createPlaybackQueue,
  type PlaybackQueue,
} from '@keith/client'
import type { AudioStreamId } from '@keith/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MicCapture } from '../lib/mic.ts'
import { micErrorMessage } from '../lib/mic.ts'
import type { VoiceEnv } from '../lib/voice.ts'
import type { AudioOutput } from '../lib/web-audio.ts'

export type Playback = {
  /** Passed to the chat client: `audio.in@1` / `audio.out@1` only when voice works here. */
  support: AudioSupport
  /** Passed to the chat client as `onAudio`. */
  onAudio: (event: AudioEvent) => void
  queue: PlaybackQueue
  output: AudioOutput
  /** Keith's audio is playing (the speaking indicator). */
  playing: boolean
}

/** The speaker: one playback queue on one lazily created `AudioContext`, for the screen's life. */
export function usePlayback(env: VoiceEnv): Playback {
  const [playing, setPlaying] = useState(false)
  const ref = useRef<{ output: AudioOutput; queue: PlaybackQueue } | null>(null)
  if (ref.current === null) {
    const output = env.createOutput()
    ref.current = { output, queue: createPlaybackQueue({ sink: output.sink, onPlayingChange: setPlaying }) }
  }
  const { output, queue } = ref.current
  const onAudio = useCallback((event: AudioEvent) => queue.handle(event), [queue])

  useEffect(
    () => () => {
      queue.stop()
      void output.close()
    },
    [queue, output],
  )

  const available = env.unavailable === null
  return { support: { input: available, output: available }, onAudio, queue, output, playing }
}

export type MicState = 'off' | 'opening' | 'on'
/** `open`: the mic stays on and the core's VAD decides turns. `hold`: on while the button is held. */
export type MicMode = 'open' | 'hold'

export type Mic = {
  state: MicState
  mode: MicMode | null
  error: string | null
  /** Opens the mic in `mode`, or closes it if it is open. */
  toggle(): void
  /** Hold-to-talk pressed: stops Keith's audio and opens the mic. */
  holdStart(): void
  /** Hold-to-talk released: ends the stream. */
  holdEnd(): void
}

const START_ERRORS = {
  offline: 'Not connected: the microphone was not opened.',
  unsupported: 'Voice is not available in this browser.',
} as const

/**
 * The microphone: opens it with `env.openMic`, starts an `audio.start` stream on the client and
 * sends each 20 ms chunk with the next sequence number. After a reconnect the core has forgotten
 * the stream, so the next chunk starts a new one. Closing sends `audio.end` and stops the tracks.
 */
export function useMic(opts: { client: ChatClient | null; env: VoiceEnv; playback: Playback }): Mic {
  const { client, env, playback } = opts
  const [state, setState] = useState<MicState>('off')
  const [mode, setMode] = useState<MicMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<MicState>('off')
  const modeRef = useRef<MicMode | null>(null)
  const clientRef = useRef(client)
  clientRef.current = client
  const capture = useRef<MicCapture | null>(null)
  const stream = useRef<AudioStreamId | null>(null)
  const sequence = useRef(0)
  /** Bumped by every close, so an open that finishes late closes itself. */
  const session = useRef(0)

  const set = useCallback((next: MicState, nextMode: MicMode | null) => {
    stateRef.current = next
    modeRef.current = nextMode
    setState(next)
    setMode(nextMode)
  }, [])

  const onChunk = useCallback((pcm16: Int16Array) => {
    const c = clientRef.current
    const id = stream.current
    if (!c || !id) return
    let result = c.sendAudio(id, sequence.current, pcm16)
    if (!result.ok && result.reason === 'unknown-stream') {
      const started = c.startAudio()
      if (!started.ok) return
      stream.current = started.streamId
      sequence.current = 0
      result = c.sendAudio(started.streamId, 0, pcm16)
    }
    if (result.ok) sequence.current += 1
  }, [])

  const close = useCallback(() => {
    session.current += 1
    const id = stream.current
    stream.current = null
    if (id) clientRef.current?.endAudio(id)
    const open = capture.current
    capture.current = null
    void open?.close()
    set('off', null)
  }, [set])

  const open = useCallback(
    async (nextMode: MicMode) => {
      const c = clientRef.current
      if (stateRef.current !== 'off' || !c) return
      if (env.unavailable) {
        setError(env.unavailable)
        return
      }
      setError(null)
      set('opening', nextMode)
      playback.output.resume().catch(() => {})
      const token = ++session.current
      let mic: MicCapture
      try {
        mic = await env.openMic(onChunk)
      } catch (err) {
        if (token === session.current) {
          set('off', null)
          setError(micErrorMessage(err))
        }
        return
      }
      if (token !== session.current) {
        await mic.close()
        return
      }
      const started = c.startAudio()
      if (!started.ok) {
        await mic.close()
        set('off', null)
        setError(START_ERRORS[started.reason])
        return
      }
      capture.current = mic
      stream.current = started.streamId
      sequence.current = 0
      set('on', nextMode)
    },
    [env, onChunk, playback.output, set],
  )

  useEffect(() => close, [close])

  return {
    state,
    mode,
    error,
    toggle() {
      if (stateRef.current === 'off') void open('open')
      else close()
    },
    holdStart() {
      if (stateRef.current !== 'off') return
      playback.queue.stop()
      void open('hold')
    },
    holdEnd() {
      if (modeRef.current === 'hold') close()
    },
  }
}
