// The utility-model prompt that folds older rows of a thread into its rolling summary.
// See docs/architecture/memory.md#thread-summary.

/** One transcript line: who spoke and what they said. */
export type SummaryLine = { speaker: string; text: string }

/** The system prompt. `maxChars` is `memory.summary.maxChars`. */
export function summarySystemPrompt(maxChars: number): string {
  return [
    'You keep the rolling summary of one conversation up to date.',
    'You get the current summary (it may be empty) and the messages that came after it.',
    'Write the new summary: the old one with the new messages folded in, as plain prose in English.',
    'Keep names, decisions, promises, plans with their dates, facts people stated and open questions.',
    'Drop small talk, greetings, thanks and anything that no longer matters.',
    'Write in the third person and the past tense. Call the assistant "you".',
    `Stay under ${maxChars} characters. Output only the summary, with no heading or preamble.`,
  ].join('\n')
}

/** The user message: the previous summary and the new transcript. */
export function summaryUserPrompt(a: { previous: string | null; lines: SummaryLine[] }): string {
  const previous = a.previous?.trim() ? a.previous.trim() : '(none yet)'
  return [
    '# Current summary',
    previous,
    '',
    '# New messages, oldest first',
    ...a.lines.map((l) => `${l.speaker}: ${l.text}`),
  ].join('\n')
}

/**
 * Cuts `text` to at most `maxChars`: at the last sentence end that fits, else at the last space,
 * else hard.
 */
export function cutAtSentence(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const head = trimmed.slice(0, maxChars)
  let end = -1
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) end = m.index + 1
  if (end > 0) return head.slice(0, end).trim()
  const space = head.lastIndexOf(' ')
  return (space > 0 ? head.slice(0, space) : head).trim()
}
