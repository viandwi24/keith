// A context change in progress (docs/specs/chat-context.md, "TUI"; P34.3.2): a `/new` or `/compact` runs a memory flush and maybe a
// summary before it takes effect. While it runs the chat shows a row, and a plain message is kept in the input, not sent: the core
// refuses a send while the session is busy (409), so sending would lose the text. The state has two sources: this TUI's own
// command (`local`, set before the RPC and cleared when it settles) and the person's feed (`feed`, the `chat.context.pending` records,
// so a second TUI of the person sees it too). A resync forgets the feed's state, since its end record may have been missed.

import { describeChatError } from '@keith/client/browser'
import type { ChatContextPendingRecord } from '@keith/contracts'

export type ContextKind = ChatContextPendingRecord['kind']

export interface ContextPendingState {
  /** This TUI's own command, from its start to its settle. */
  local: ContextKind | undefined
  /** The person's change in progress as the feed reports it. */
  feed: ContextKind | undefined
  /** A refetch trigger: a `/compact` ended (local or fed; one compaction may count twice, a re-read is harmless). The chat re-reads its messages for the marker. */
  compacted: number
}

export const INITIAL_CONTEXT_PENDING: ContextPendingState = {
  local: undefined,
  feed: undefined,
  compacted: 0,
}

export type ContextPendingEvent =
  | { type: 'local-start'; kind: ContextKind }
  | { type: 'local-end'; kind: ContextKind }
  | { type: 'feed'; record: ChatContextPendingRecord }
  | { type: 'resync' }

/** The change in progress, if any: this TUI's own command first, then the feed's. */
export function pendingKindOf(state: ContextPendingState): ContextKind | undefined {
  return state.local ?? state.feed
}

/** Folds one event into the state. Pure. */
export function reduceContextPending(
  state: ContextPendingState,
  event: ContextPendingEvent,
): ContextPendingState {
  switch (event.type) {
    case 'local-start':
      return { ...state, local: event.kind }
    case 'local-end':
      return {
        ...state,
        local: undefined,
        compacted: event.kind === 'compact' ? state.compacted + 1 : state.compacted,
      }
    case 'feed': {
      const { kind, state: phase } = event.record
      const compacted =
        phase === 'end' && kind === 'compact' ? state.compacted + 1 : state.compacted
      return { ...state, feed: phase === 'start' ? kind : undefined, compacted }
    }
    case 'resync':
      // a resync forgets the feed's state only: the feed sends no history, so it cannot tell whether this TUI's own call still
      // runs. That call ends when it settles or at the client deadline (chat-context.md), never at a resync.
      return { ...state, feed: undefined }
  }
}

/** The row the chat shows while a change runs (the same place and style as `thinking…`). */
export const CONTEXT_PENDING_TEXT: Readonly<Record<ContextKind, string>> = {
  new: 'starting a new context…',
  compact: 'compacting the conversation…',
}

/** The hint of a plain message typed while a change runs: the draft is kept, nothing is sent. */
export const CONTEXT_HOLD_TEXT =
  'A context change is running. Your message is kept; press Enter when it is done.'

/**
 * The text the eharness client shows when the core refuses a send with 409 (`EH_SESSION_BUSY`). The client's `notify` gives text
 * only, so the chat matches it exactly; it is read from the client's own `describeChatError`, never copied, so a reworded
 * message in eharness cannot silently break the match.
 */
export const SESSION_BUSY_TEXT: string =
  describeChatError({ code: 'EH_SESSION_BUSY' }, false)?.message ?? 'EH_SESSION_BUSY'

/** The warning after a refused send: the text is back in the input, and nothing was sent. */
export const SEND_REFUSED_TEXT = 'Not sent: the agent is busy. Your message is still in the input.'

/**
 * The draft after a refused send: the refused text goes back in front of whatever the person typed since, so nothing typed is
 * lost and nothing is sent twice.
 */
export function draftRestoredOf(current: string, refused: string): string {
  return current === '' ? refused : `${refused}\n${current}`
}
