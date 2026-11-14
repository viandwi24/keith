// The dreams' dividers in the chat (dream-pending.ts; docs/specs/tui.md "Dreaming"). A divider is a chat item of kind `divider`, placed
// after the item that was the last one when its run ended, so it reads in time order. Only the dividers that finished after the chat
// was mounted are shown: a new generation starts without the older ones. Pure.
import type { ChatItem } from './message-text.ts'

/** One divider of a dream run in the chat. `after` is the id of the item it follows (undefined: none was there). */
export interface DreamMark {
  id: string
  text: string
  after: string | undefined
}

/** The finished runs of the memory activity, the way the chat reads them (`DreamFinish` in the memory feature). */
export interface FinishedDream {
  seq: number
  id: string
  text: string
}

/** The marks after the finished runs: each run not yet marked and finished after `mountSeq` gets one after `after`. Same list when nothing is new. */
export function marksWith(
  marks: readonly DreamMark[],
  finishes: readonly FinishedDream[],
  mountSeq: number,
  after: string | undefined,
): readonly DreamMark[] {
  const known = new Set(marks.map((m) => m.id))
  const fresh = finishes
    .filter((f) => f.seq > mountSeq && !known.has(f.id))
    .map((f) => ({ id: f.id, text: f.text, after }))
  return fresh.length === 0 ? marks : [...marks, ...fresh]
}

/**
 * The chat items with the dividers placed in: after the item they follow. A mark whose item is gone (the stored messages were
 * read again) goes to the end; a mark with no item before it goes to the top.
 */
export function withDreamMarks(
  items: readonly ChatItem[],
  marks: readonly DreamMark[],
): ChatItem[] {
  if (marks.length === 0) return [...items]
  const byAfter = new Map<string | undefined, DreamMark[]>()
  for (const mark of marks) byAfter.set(mark.after, [...(byAfter.get(mark.after) ?? []), mark])
  const divider = (mark: DreamMark): ChatItem => ({
    id: `dream:${mark.id}`,
    kind: 'divider',
    text: mark.text,
  })
  const ids = new Set(items.map((item) => item.id))
  const out: ChatItem[] = (byAfter.get(undefined) ?? []).map(divider)
  for (const item of items) {
    out.push(item)
    for (const mark of byAfter.get(item.id) ?? []) out.push(divider(mark))
  }
  for (const [after, list] of byAfter) {
    if (after !== undefined && !ids.has(after)) for (const mark of list) out.push(divider(mark))
  }
  return out
}
