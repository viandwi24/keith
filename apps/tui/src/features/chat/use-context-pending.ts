// The context change in progress of the signed-in person (context-pending.ts). `begin`/`end` mark this TUI's own `/new` or `/compact`;
// the person's feed (`chat.context.pending`) fills in the change another TUI of the person runs.
import { type KeithClient, watchChatContextPending } from '@keith/client'
import { useEffect, useReducer } from 'react'
import {
  type ContextKind,
  type ContextPendingState,
  INITIAL_CONTEXT_PENDING,
  reduceContextPending,
} from './context-pending.ts'

export interface ContextPendingHandle extends ContextPendingState {
  begin(kind: ContextKind): void
  end(kind: ContextKind): void
}

export function useContextPending(
  client: KeithClient,
  personId: string | undefined,
): ContextPendingHandle {
  const [state, dispatch] = useReducer(reduceContextPending, INITIAL_CONTEXT_PENDING)
  useEffect(() => {
    if (personId === undefined) return undefined
    return watchChatContextPending({
      feed: client.feed(),
      onRecord: (record) => dispatch({ type: 'feed', record }),
      onResync: () => dispatch({ type: 'resync' }),
    })
  }, [client, personId])
  return {
    ...state,
    begin: (kind) => dispatch({ type: 'local-start', kind }),
    end: (kind) => dispatch({ type: 'local-end', kind }),
  }
}
