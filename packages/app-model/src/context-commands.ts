// The `/new` and `/compact` forms (docs/specs/chat-context.md, "TUI"; ADR-0030). `/new` starts the next context of the person (the memory
// flush runs first unless `--no-flush`); `/compact` shortens the current one. A refusal (a turn, an approval or a task is running, or the
// flush failed) is a warning toast with its reason in plain words, never an error screen. The chat switches by itself: the core writes
// `chat.context.changed` and `watchChatContext` refetches (use-front-generation.ts).
import {
  type ChatContextApi,
  ChatContextDeadlineError,
  chatContextRefusalOf,
} from '@keith/client/browser'
import type { ChatContextRefusalReason } from '@keith/contracts'
import type { ContextKind } from './context-pending.ts'
import type { ToastLevel } from './ui-types.ts'

export type ContextCommand =
  | { kind: 'new'; flush: boolean }
  | { kind: 'compact' }
  | { kind: 'usage'; text: string }

export const NEW_USAGE = 'Usage: /new · /new --no-flush'
export const COMPACT_USAGE = 'Usage: /compact'

/** The words after `/new` or `/compact`: `/new` (flush first), `/new --no-flush`, `/compact`; anything else is the usage line. */
export function parseContextCommand(name: 'new' | 'compact', args: string): ContextCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (name === 'compact')
    return words.length === 0 ? { kind: 'compact' } : { kind: 'usage', text: COMPACT_USAGE }
  if (words.length === 0) return { kind: 'new', flush: true }
  if (words.length === 1 && words[0] === '--no-flush') return { kind: 'new', flush: false }
  return { kind: 'usage', text: NEW_USAGE }
}

/** The words of a refusal, as the person reads them in a toast. */
export const CONTEXT_REFUSAL_TEXT: Readonly<Record<ChatContextRefusalReason, string>> = {
  'turn-running': 'a turn is still running',
  'approval-pending': 'an approval is waiting',
  'task-running': 'a task is still running',
  'flush-failed':
    'Could not save to memory, so nothing was changed. Try /new again later, or /new --no-flush to start fresh without saving.',
}

/** The words of a `/compact` refused because its flush did not save: nothing was compacted (chat-context.md "TUI"). */
export const COMPACT_FLUSH_FAILED_TEXT =
  'Could not save to memory, so nothing was compacted. Try again later.'

/** The refusals of `/compact`: the same reasons, with the flush words of a compaction (nothing was compacted). */
const COMPACT_REFUSAL_TEXT: Readonly<Record<ChatContextRefusalReason, string>> = {
  ...CONTEXT_REFUSAL_TEXT,
  'flush-failed': COMPACT_FLUSH_FAILED_TEXT,
}

/** The warning when the client's deadline passed: the core may still finish; the held sends are released (chat-context.md). */
export const CONTEXT_DEADLINE_TEXT =
  'Still working in the core. Check again in a moment; your messages are not held any more.'

/** The success toast of a reset: what is kept and what is cleared (ADR-0030 §5). */
export function newContextDoneText(flushed: boolean): string {
  const saved = flushed ? '' : ' Nothing was saved to memory first.'
  return `New context started. Memory, persona and style are kept; this conversation's context is cleared.${saved}`
}

const COMPACT_DONE_BASE =
  'Context compacted. Memory, persona and style are kept; older messages are summarised.'

/** The success toast of a compaction; a flush that did not save says so (ADR-0030 §4, chat-context.md "TUI"). */
export function compactDoneText(flushed: boolean): string {
  return flushed ? COMPACT_DONE_BASE : `${COMPACT_DONE_BASE} Nothing was saved to memory first.`
}

/** The divider "new context" shows at the top of the chat of every generation after the first. */
export function showsDivider(generation: number): boolean {
  return generation > 0
}

export interface ContextCommandEnv {
  chatContext: Pick<ChatContextApi, 'newContext' | 'compact'>
  toast(text: string, level: ToastLevel): void
  say(level: 'info' | 'warning', rows: readonly string[]): void
  /** Marks this TUI's own change in progress (the chat holds plain sends and shows a row); `end` runs once the call settles. */
  pending?: { begin(kind: ContextKind): void; end(kind: ContextKind): void }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Runs a parsed `/new` or `/compact`: the result is a toast; a refusal is a warning with its reason. */
export function runContextCommand(command: ContextCommand, env: ContextCommandEnv): void {
  if (command.kind === 'usage') {
    env.say('info', [command.text])
    return
  }
  const failed = (
    error: unknown,
    text: Readonly<Record<ChatContextRefusalReason, string>>,
  ): void => {
    if (error instanceof ChatContextDeadlineError) {
      env.toast(CONTEXT_DEADLINE_TEXT, 'warning')
      return
    }
    const reason = chatContextRefusalOf(error)
    if (reason === undefined) env.toast(messageOf(error), 'error')
    else env.toast(text[reason], 'warning')
  }
  const kind: ContextKind = command.kind
  env.pending?.begin(kind)
  const settle = (): void => env.pending?.end(kind)
  if (command.kind === 'compact') {
    void env.chatContext.compact().then(
      (done) => {
        settle()
        env.toast(compactDoneText(done.flushed), 'success')
      },
      (error: unknown) => {
        settle()
        failed(error, COMPACT_REFUSAL_TEXT)
      },
    )
    return
  }
  void env.chatContext.newContext({ flush: command.flush }).then(
    (done) => {
      settle()
      env.toast(newContextDoneText(done.flushed), 'success')
    },
    (error: unknown) => {
      settle()
      failed(error, CONTEXT_REFUSAL_TEXT)
    },
  )
}
