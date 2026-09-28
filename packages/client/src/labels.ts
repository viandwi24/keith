import type { PersonDto, PersonId, ThreadDto, TurnState } from '@keith/protocol'
import type { ConnectionStatus } from './state.ts'

/** Short English labels for status bars, shared by every client so they read the same everywhere. */

const TURN_LABELS: Record<TurnState, string> = {
  idle: '',
  listening: 'listening…',
  thinking: 'thinking…',
  speaking: 'speaking',
}

/** `thinking…`, `speaking`, … Empty when idle. */
export function turnLabel(state: TurnState): string {
  return TURN_LABELS[state]
}

export function connectionLabel(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'connecting':
      return 'connecting…'
    case 'online':
      return 'online'
    case 'reconnecting':
      return `offline, reconnecting in ${Math.ceil(status.inMs / 1000)}s (attempt ${status.attempt})`
    case 'auth-required':
      return 'signed out: the token was rejected'
    case 'closed':
      return `closed: ${status.reason}`
  }
}

/** The label of a direct thread: the person's own conversation with Keith. */
export const MAIN_THREAD_LABEL = 'Main'

/**
 * Phase 5: a thread's name in a thread list or a status bar. A direct thread is `Main`. A group is
 * its title and the other current participants, e.g. `Mission · Pepper, Rhodey` (`me` is left
 * out; a group with nobody else is just its title).
 */
export function threadLabel(thread: ThreadDto, me: PersonDto | PersonId | null): string {
  if (thread.kind === 'direct') return MAIN_THREAD_LABEL
  const myId = typeof me === 'string' ? me : me?.id
  const others = thread.participants.filter((p) => p.id !== myId).map((p) => p.name)
  return others.length > 0 ? `${thread.title} · ${others.join(', ')}` : thread.title
}
