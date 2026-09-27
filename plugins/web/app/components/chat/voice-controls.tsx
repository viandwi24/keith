import { cn } from 'cn'
import { Mic, MicOff, Volume2 } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { Mic as MicControl } from '../../hooks/use-voice.ts'
import { Button } from '../ui/button.tsx'

/**
 * Voice input and output state: an open-mic toggle (the core's VAD decides turns), a hold-to-talk
 * button, "listening" while the core hears speech (`thread.state`), "speaking" while Keith's audio
 * plays, and an inline message when the mic cannot be used. Text chat works either way.
 */
export function VoiceControls({
  mic,
  unavailable,
  online,
  listening,
  playing,
}: {
  mic: MicControl
  /** Why voice cannot work in this page (the controls are disabled), or null. */
  unavailable: string | null
  online: boolean
  /** The thread is `listening` (the core's VAD heard speech). */
  listening: boolean
  playing: boolean
}) {
  const disabled = unavailable !== null || !online
  const openMic = mic.state !== 'off' && mic.mode === 'open'
  const holding = mic.state !== 'off' && mic.mode === 'hold'
  const holdKey = (event: KeyboardEvent, down: boolean) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (event.repeat) return
    if (down) mic.holdStart()
    else mic.holdEnd()
  }

  return (
    <div className="flex flex-col gap-1" data-slot="voice">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={openMic ? 'default' : 'outline'}
          size="sm"
          data-slot="mic-toggle"
          data-state={openMic ? mic.state : 'off'}
          aria-pressed={openMic}
          disabled={disabled || holding}
          onClick={mic.toggle}
        >
          {openMic ? <Mic /> : <MicOff />}
          {openMic ? (mic.state === 'opening' ? 'Opening mic…' : 'Mic on') : 'Mic off'}
        </Button>
        <Button
          type="button"
          variant={holding ? 'default' : 'outline'}
          size="sm"
          data-slot="push-to-talk"
          data-state={holding ? mic.state : 'off'}
          aria-pressed={holding}
          disabled={disabled || openMic}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId)
            mic.holdStart()
          }}
          onPointerUp={mic.holdEnd}
          onPointerCancel={mic.holdEnd}
          onKeyDown={(event) => holdKey(event, true)}
          onKeyUp={(event) => holdKey(event, false)}
        >
          <Mic />
          {holding ? 'Release to send' : 'Hold to talk'}
        </Button>
        <span data-slot="voice-status" className="flex items-center gap-3 text-xs text-muted-foreground">
          {mic.state === 'on' && listening ? (
            <span data-slot="listening" className="inline-flex items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
              Listening…
            </span>
          ) : null}
          <span
            data-slot="speaking"
            data-playing={playing ? 'true' : 'false'}
            className={cn('inline-flex items-center gap-1.5', playing ? '' : 'hidden')}
          >
            <Volume2 className="size-3.5 animate-pulse" />
            Speaking
          </span>
        </span>
      </div>
      {mic.error ? (
        <p data-slot="voice-error" role="status" className="text-xs text-destructive">
          {mic.error}
        </p>
      ) : unavailable ? (
        <p data-slot="voice-unavailable" className="text-xs text-muted-foreground">
          {unavailable}
        </p>
      ) : null}
    </div>
  )
}
