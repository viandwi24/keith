import type { ChatItem } from './message-text.ts'

export type QuestionItem = Extract<ChatItem, { kind: 'question' }>

/** How a question card was settled here: answered with an option, or closed by the core (`CONFLICT`). */
export type Settled = { kind: 'answered'; option: string } | { kind: 'closed' }

/**
 * The question that takes keys: the newest question of the conversation, when it has options and was not
 * settled here. An older question keeps its text and does not take keys.
 */
export function answerableOf(
  items: readonly ChatItem[],
  settled: Readonly<Record<string, Settled>>,
): QuestionItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind !== 'question') continue
    return item.options.length > 0 && settled[item.id] === undefined ? item : undefined
  }
  return undefined
}

/** The RPC code of a rejected call (`CONFLICT`, `NOT_FOUND`, ...), or undefined for any other error. */
export function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The text of a rejected call for a toast. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
