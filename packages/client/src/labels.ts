import type { TurnState } from '@keith/protocol'
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
