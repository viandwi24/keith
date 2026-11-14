import type { BrainEventType } from '@keith/contracts'
import type { ActivityStore } from 'eharness/activity'
import { personOfSession } from '../../platform/sessions.ts'

/**
 * Append one event to the activity feed without ever blocking or failing the caller: hooks are
 * bounded (30 s) and a slow store must not stall a turn, so the write is fire and forget and a
 * failure is only reported to `warn`. The payload gains `personId` (of the session) when it has none.
 */
export function emit(
  store: ActivityStore,
  type: BrainEventType | (string & {}),
  sessionId: string | null,
  agentId: string | null,
  payload: Record<string, unknown>,
  warn?: (message: string) => void,
): void {
  // the person is derived from the session id once, here, so a feed filter never parses ids
  const personId = personOfSession(sessionId)
  const body = personId === undefined || 'personId' in payload ? payload : { ...payload, personId }
  store.append({ type, sessionId, agentId, payload: body }).catch((error: unknown) => {
    warn?.(`activity: could not append ${type}: ${error instanceof Error ? error.message : error}`)
  })
}
