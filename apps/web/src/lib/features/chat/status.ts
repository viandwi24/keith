// The phase of the conversation as the composer and the message list show it. Pure: the controller feeds it the AI SDK chat status
// and the session's `busy`, and the time of the last visible progress.

export type ChatPhase = 'idle' | 'thinking' | 'streaming' | 'stalled'

/** A running turn with no visible progress for this long is `stalled` (the core is asked again by `checkStalled`). */
export const STALL_MS = 20_000

export interface PhaseInput {
  /** The AI SDK `Chat` status. */
  status: 'ready' | 'submitted' | 'streaming' | 'error'
  /** The session's `busy`: following, sending, running or stopping. */
  busy: boolean
  /** The newest message is an assistant message with visible text or a tool call. */
  answering: boolean
  /** When the conversation last changed (epoch ms), and now. */
  lastProgressAt: number
  now: number
}

export function phaseOf(input: PhaseInput): ChatPhase {
  const running = input.busy || input.status === 'submitted' || input.status === 'streaming'
  if (!running) return 'idle'
  if (input.now - input.lastProgressAt >= STALL_MS) return 'stalled'
  return input.answering && input.status === 'streaming' ? 'streaming' : 'thinking'
}

export const PHASE_TEXT: Readonly<Record<ChatPhase, string>> = {
  idle: '',
  thinking: 'thinking…',
  streaming: 'answering…',
  stalled: 'no progress for a while, checking with the core…',
}

/** A cheap signature of the conversation's tail: it changes whenever a chunk adds text or a part. */
export function progressKey(
  messages: readonly {
    id: string
    parts: readonly { type: string; text?: string; state?: string }[]
  }[],
): string {
  const last = messages.at(-1)
  if (last === undefined) return ''
  const tail = last.parts.at(-1)
  return `${messages.length}:${last.id}:${last.parts.length}:${tail?.type ?? ''}:${tail?.text?.length ?? 0}:${tail?.state ?? ''}`
}
