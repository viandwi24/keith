// The entry-loss guard of a memory file (docs/specs/dreaming.md "Rule 4", ADR-0031 §4). A rewrite is refused when it drops more than
// 25 % of the file's prior entries, or when a dreaming entry keeps its text but loses its `Source:` pointer. A front-agent bullet
// (a `- ` line with no `Source:` line) is an entry for the 25 % count, but it is never reported as a dropped dreaming entry.
// A refused file gets `appendOnlyFallback`: new entries at the end, every prior line kept byte for byte. Pure: no file access.

import {
  assertEntry,
  type DreamEntry,
  type MemoryBlock,
  parseMemoryFile,
  renderEntry,
} from './entries.ts'

export type RewriteCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** The bullet text of a front line, without a superseded marker. */
const FRONT_TEXT = /^- (?:\[superseded [^\]]*\] )?(.*)$/

export const pointerKey = (entry: DreamEntry): string =>
  `${entry.source.sessionId} ${entry.source.messageId}`

/** The lost items of `before` as a multiset: each item of `after` keeps at most one prior item. */
function countLost<T>(before: readonly T[], after: readonly T[], keyOf: (item: T) => string): T[] {
  const left = new Map<string, number>()
  for (const item of after) left.set(keyOf(item), (left.get(keyOf(item)) ?? 0) + 1)
  const lost: T[] = []
  for (const item of before) {
    const key = keyOf(item)
    const kept = left.get(key) ?? 0
    if (kept > 0) left.set(key, kept - 1)
    else lost.push(item)
  }
  return lost
}

/** Refuses a rewrite of a memory file that drops a dreaming entry's `Source:` pointer or more than 25 % of its prior entries. */
export function checkRewrite(before: string, after: string): RewriteCheck {
  const prior: MemoryBlock[] = parseMemoryFile(before)
  const next: MemoryBlock[] = parseMemoryFile(after)
  const priorDream = prior.filter((b): b is DreamEntry => b.kind === 'dream')
  const nextDream = next.filter((b): b is DreamEntry => b.kind === 'dream')
  const priorFront = prior.flatMap((b) =>
    b.kind === 'front' && b.line.startsWith('- ') ? [b.line] : [],
  )
  const nextFront = next.flatMap((b) =>
    b.kind === 'front' && b.line.startsWith('- ') ? [b.line] : [],
  )

  // An entry is kept when its Source pointer is still in the file. A lost entry whose text is still there, as a bullet without a
  // pointer or under a new pointer, lost its Source line: that is refused whatever the count.
  const priorPointers = new Set(priorDream.map(pointerKey))
  const keptTexts = new Set<string>()
  for (const entry of nextDream)
    if (!priorPointers.has(pointerKey(entry))) keptTexts.add(entry.text)
  for (const line of nextFront) keptTexts.add(FRONT_TEXT.exec(line)?.[1] ?? line)

  const lostDream = countLost(priorDream, nextDream, pointerKey)
  const sourceDropped = lostDream.filter((entry) => keptTexts.has(entry.text))
  if (sourceDropped.length > 0) {
    const first = sourceDropped[0] as DreamEntry
    const word = sourceDropped.length === 1 ? 'entry' : 'entries'
    return {
      ok: false,
      reason: `drops the Source line of ${sourceDropped.length} dreaming ${word} (first: session ${first.source.sessionId} message ${first.source.messageId})`,
    }
  }

  const priorCount = priorDream.length + priorFront.length
  const lost = lostDream.length + countLost(priorFront, nextFront, (line) => line).length
  // lost / priorCount > 25 %, written without a division: lost * 4 > priorCount. Exactly 25 % is accepted.
  if (lost * 4 > priorCount) {
    return { ok: false, reason: `drops ${lost} of ${priorCount} prior entries, more than 25 %` }
  }

  return { ok: true }
}

/** The dream entries of `after` whose Source pointer `before` does not hold: the entries a rewrite adds (a superseded line keeps its pointer). */
export function addedEntries(before: string, after: readonly MemoryBlock[]): DreamEntry[] {
  const prior = new Set(
    parseMemoryFile(before).flatMap((block) => (block.kind === 'dream' ? [pointerKey(block)] : [])),
  )
  return after.flatMap((block) =>
    block.kind === 'dream' && !prior.has(pointerKey(block)) ? [block] : [],
  )
}

/** `before` with only the new entries appended. Every prior byte is kept: the result always starts with `before`. */
export function appendOnlyFallback(before: string, newEntries: readonly DreamEntry[]): string {
  if (newEntries.length === 0) return before
  const lines = newEntries.flatMap((entry) => renderEntry(assertEntry(entry)))
  const block = `${lines.join('\n')}\n`
  if (before === '') return block
  return before.endsWith('\n') ? `${before}${block}` : `${before}\n${block}`
}
