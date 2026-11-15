// Clean or tainted (ADR-0036 §2), computed by code from the restricted transcript (eharness spec 11 §3.4): the person's messages and
// the agent's own tool calls, never a tool output, so an injection in a page cannot reach it. Pure.
import type { ConsentContext, ToolSource } from '@keith/contracts'
import type { GuardTranscriptEntry } from 'eharness'

/**
 * Where the turn that makes the call started:
 * - `person`: a front turn started by the person's own message (`send`, `edit`);
 * - `delegated-clean`: a worker whose delegating front call was clean (the task text is the front agent's, not the person's);
 * - `tainted`: a turn with no message of the person (a wake from a protocol, a plugin, a reminder, a worker report, a room or a
 *   delivery digest), a worker whose delegating call was tainted or is unknown, or a continuation whose start is unknown.
 */
export type ConsentOrigin = 'person' | 'delegated-clean' | 'tainted'

export interface ConsentContextInput {
  transcript: readonly GuardTranscriptEntry[]
  /** The source of a tool by name (`outside` for a tool nobody declared). */
  sourceOf: (toolName: string) => ToolSource
  origin: ConsentOrigin
}

/**
 * `clean` when, after the newest message of the person, every tool call that ran is `trusted` (so the newest entry before the call
 * under review is the person's message, or only trusted calls follow it); `tainted` otherwise. A `person` turn whose transcript has no
 * message of the person at all is tainted (nothing shows the person asked). For `delegated-clean` the whole transcript counts when
 * it has no message (the task prompt may be hidden from the transcript): every call in it must be trusted.
 */
export function consentContext(input: ConsentContextInput): ConsentContext {
  if (input.origin === 'tainted') return 'tainted'
  let newestUser = -1
  input.transcript.forEach((entry, at) => {
    if (entry.role === 'user') newestUser = at
  })
  if (newestUser < 0 && input.origin === 'person') return 'tainted'
  for (const entry of input.transcript.slice(newestUser + 1)) {
    if (entry.role === 'tool-call' && input.sourceOf(entry.toolName) !== 'trusted') return 'tainted'
  }
  return 'clean'
}
