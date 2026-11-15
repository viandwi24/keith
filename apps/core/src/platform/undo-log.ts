// The undo log (ADR-0036 §4, docs/specs/amygdala.md "Undo"): plumbing the reversible tools record into, so no region imports another for it: a reversible tool (persona, style, model role,
// presence status) records how to take its change back; `undo_last` runs the newest one of the person in this chat. In memory
// and bounded: a restart forgets it (the persona keeps its versions, so "restore" still works by hand).
import type { HarnessContext } from 'eharness'

/** What an undo answers (the tool relays it): done, or why it could not be. A refusal is an answer, never a throw. */
export type UndoResult =
  | { ok: true; summary: string }
  | { ok: false; reason: string; message: string }

/** One reversible change: what it was (a few words for the answer) and how to take it back. */
export interface UndoEntry {
  tool: string
  /** What the undo restores, in a few words (never the content of a note or a persona line). */
  summary: string
  undo: () => UndoResult | Promise<UndoResult>
}

export interface UndoLog {
  /** Remember the undo of the person's change in this session (newest last). */
  record(sessionId: string, personId: string, entry: UndoEntry): void
  /** Take the newest undo of this person in this session off the log, or undefined when there is none. */
  take(sessionId: string, personId: string): UndoEntry | undefined
  /** How many undos wait for this person in this session. */
  size(sessionId: string, personId: string): number
}

const PER_SESSION = 10
const MAX_SESSIONS = 500

export function createUndoLog(): UndoLog {
  const stacks = new Map<string, UndoEntry[]>()
  const keyOf = (sessionId: string, personId: string) => `${sessionId}|${personId}`
  return {
    record(sessionId, personId, entry) {
      const key = keyOf(sessionId, personId)
      const stack = stacks.get(key) ?? []
      stacks.delete(key)
      stack.push(entry)
      if (stack.length > PER_SESSION) stack.shift()
      stacks.set(key, stack)
      if (stacks.size > MAX_SESSIONS) stacks.delete(stacks.keys().next().value as string)
    },
    take(sessionId, personId) {
      const stack = stacks.get(keyOf(sessionId, personId))
      return stack?.pop()
    },
    size: (sessionId, personId) => stacks.get(keyOf(sessionId, personId))?.length ?? 0,
  }
}

/** Records the undo of a change made in a tool call: a no-op when the tool has no log or the call has no person. */
export function recordUndo(
  log: UndoLog | undefined,
  ctx: Pick<HarnessContext, 'session' | 'principal'>,
  entry: UndoEntry,
): void {
  const person = ctx.principal?.id
  if (log === undefined || person === undefined) return
  log.record(ctx.session.id, person, entry)
}
