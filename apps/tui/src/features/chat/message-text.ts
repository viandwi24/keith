import { type KnownStopReason, NOTICE_CODES, type NoticeCode, STOP_REASONS } from '@keith/client'
import type { NoticeLevel } from '@keith/ui'
import type { UIMessage } from 'ai'
import { type ToolCall, toolCallOf } from './tool-view.ts'

export type ChatBlock = { kind: 'text'; text: string } | { kind: 'tool'; call: ToolCall }

/** What the conversation shows, in order: a user message, an assistant message, a notice. */
export type ChatItem =
  | { id: string; kind: 'user'; text: string }
  | {
      id: string
      kind: 'assistant'
      /** A worker report that woke the front agent: the dot is `◆`. */
      proactive: boolean
      /** The turn was stopped by the user (`Esc`): the message ends with `■ stopped`. */
      stopped: boolean
      /** Text and tool calls, in the order they happened. */
      blocks: ChatBlock[]
    }
  | { id: string; kind: 'notice'; level: NoticeLevel; text: string; code?: string }
  /** An open question of a protocol run (`protocol.ask`): the answer is given in the chat (`protocol_answer`). */
  | { id: string; kind: 'question'; runId: string; text: string; options: string[] }
  /** A rule across the conversation: a `/compact` marker (the stored `eh.compaction`). */
  | { id: string; kind: 'divider'; text: string }

/** The `eh.event` name of a dreaming notice: a staged review, a budget stop, a failed run or an applied auto run (dreaming.md, "Notify"). */
export const DREAM_NOTICE_EVENT = 'dreaming.notice'

/** The text of a dreaming notice part, or undefined for any other part. The text carries counts and commands, never memory text. */
export function dreamNoticeOf(part: { type: string; data?: unknown }): string | undefined {
  if (part.type !== 'data-eh.event') return undefined
  const event = part.data as { name?: unknown; text?: unknown } | undefined
  if (event?.name !== DREAM_NOTICE_EVENT || typeof event.text !== 'string') return undefined
  return event.text
}

/** The data part of a stored `eh.compaction` kind message (the marker of a `/compact`, docs/specs/chat-context.md, "TUI"). */
export const COMPACTION_PART = 'data-eh.compaction'

/** The divider a `/compact` leaves in the conversation. */
export const COMPACTED_TEXT = 'conversation compacted'

/** Data part the core's `proactive()` plugin puts on a message it delivers on its own. */
export const PROACTIVE_PART = 'data-keith.proactive'

/** The `eh.event` name of a protocol's question (hypothalamus.md "Engine": the `ask` step). */
export const QUESTION_EVENT = 'protocol.ask'

/** The question of a `data-eh.event` part of a protocol run, or undefined for any other part. */
export function questionOf(part: { type: string; data?: unknown }):
  | {
      runId: string
      text: string
      options: string[]
    }
  | undefined {
  if (part.type !== 'data-eh.event') return undefined
  const event = part.data as { name?: unknown; text?: unknown; data?: unknown } | undefined
  if (event?.name !== QUESTION_EVENT || typeof event.text !== 'string') return undefined
  const detail = event.data as { runId?: unknown; options?: unknown } | undefined
  if (typeof detail?.runId !== 'string') return undefined
  const options = Array.isArray(detail.options)
    ? detail.options.filter((o): o is string => typeof o === 'string')
    : []
  return { runId: detail.runId, text: event.text, options }
}

interface NoticePart {
  type: 'data-eh.notice'
  data?: { level?: string; code?: string; message?: string }
}

/** English texts of the eharness notices Keith knows, by stable `code`. */
export const NOTICE_BY_CODE: Partial<Record<NoticeCode, string>> = {
  [NOTICE_CODES.EH_TURN_INTERRUPTED]:
    'The previous turn was interrupted: its process stopped before it finished.',
  [NOTICE_CODES.EH_TURN_TIMEOUT]: 'This turn stopped because it ran past its time limit.',
  [NOTICE_CODES.EH_CONTEXT_THRASH]:
    'This turn was stopped: the conversation grew too long and kept being compacted without progress.',
  [NOTICE_CODES.EH_RUN_FAILED]: 'Unexpected error (see server logs).',
}

/**
 * Codes a user can see that deliberately have no entry above: the row shows the stored message
 * unchanged (generic fallback). Any other code is thrown to the app and never stored as a notice.
 */
export const GENERIC_NOTICE_CODES: readonly NoticeCode[] = [
  NOTICE_CODES.EH_INPUT_BLOCKED,
  NOTICE_CODES.EH_COST_CAP,
  NOTICE_CODES.EH_PROVIDER_AUTH,
  NOTICE_CODES.EH_PROVIDER,
  NOTICE_CODES.EH_STORAGE,
  NOTICE_CODES.EH_CONTEXT_OVERFLOW,
  NOTICE_CODES.EH_COMPACTION_FAILED,
  NOTICE_CODES.EH_LOCK_UNAVAILABLE,
]

/** Notices stored without a `code` (older data), matched by their exact English text. */
const NOTICE_BY_TEXT: Record<string, string> = {
  'The previous turn was interrupted: its process stopped before it finished.':
    NOTICE_BY_CODE.EH_TURN_INTERRUPTED as string,
  'Unexpected error (see server logs)': NOTICE_BY_CODE.EH_RUN_FAILED as string,
}

/** The text a notice shows: English for the known ones, the original message otherwise. */
export function noticeText(notice: { code?: string; message: string }): string {
  return (
    (notice.code === undefined ? undefined : NOTICE_BY_CODE[notice.code as NoticeCode]) ??
    NOTICE_BY_TEXT[notice.message] ??
    notice.message
  )
}

const LEVELS: readonly NoticeLevel[] = ['info', 'warning', 'error']

const stopOf = (m: UIMessage): KnownStopReason | (string & {}) | undefined => {
  const meta = m.metadata as { eharness?: { stop?: string } } | undefined
  return meta?.eharness?.stop
}

/**
 * Messages → what the conversation shows. Text and tool calls of an assistant message keep their
 * order; an `eh.notice` part becomes a notice row after its message; a message with nothing to
 * show (an empty reply) is dropped.
 */
export function toItems(messages: readonly UIMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of messages) {
    for (const [i, part] of m.parts.entries()) {
      const question = questionOf(part)
      if (question !== undefined)
        items.push({ id: `${m.id}:question:${i}`, kind: 'question', ...question })
      if (part.type === COMPACTION_PART)
        items.push({ id: `${m.id}:compacted:${i}`, kind: 'divider', text: COMPACTED_TEXT })
      const dream = dreamNoticeOf(part)
      if (dream !== undefined)
        items.push({ id: `${m.id}:dream:${i}`, kind: 'notice', level: 'info', text: dream })
    }
    if (m.role === 'user') {
      const text = m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
        .trim()
      if (text !== '') items.push({ id: m.id, kind: 'user', text })
      continue
    }
    const blocks: ChatBlock[] = []
    for (const part of m.parts) {
      if (part.type === 'text') {
        const last = blocks.at(-1)
        if (last?.kind === 'text') last.text += part.text
        else blocks.push({ kind: 'text', text: part.text })
        continue
      }
      const call = toolCallOf(part)
      if (call !== undefined) blocks.push({ kind: 'tool', call })
    }
    const visible = blocks
      .map((b) => (b.kind === 'text' ? { ...b, text: b.text.trim() } : b))
      .filter((b) => b.kind === 'tool' || b.text !== '')
    if (visible.length > 0) {
      items.push({
        id: m.id,
        kind: 'assistant',
        proactive: m.parts.some((p) => p.type === PROACTIVE_PART),
        stopped: stopOf(m) === STOP_REASONS.ABORTED,
        blocks: visible,
      })
    }
    for (const part of m.parts) {
      if (part.type === 'data-eh.notice') {
        const notice = (part as unknown as NoticePart).data
        if (notice?.message !== undefined) {
          const level = LEVELS.find((l) => l === notice.level) ?? 'warning'
          items.push({
            id: `${m.id}:notice`,
            kind: 'notice',
            level,
            text: noticeText(notice as { code?: string; message: string }),
            ...(notice.code === undefined ? {} : { code: notice.code }),
          })
        }
      }
    }
  }
  return items
}
