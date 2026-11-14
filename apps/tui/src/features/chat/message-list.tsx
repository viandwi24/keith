import type { Task } from '@keith/contracts'
import { G, GUTTER, Markdown, Message, Notice, Rich, ToolLine, Txt, useNow } from '@keith/ui'
import { Box } from 'ink'
import type { ReactNode } from 'react'
import { isActive } from '../tasks/index.ts'
import { ContextDivider } from './context-divider.tsx'
import { CONTEXT_PENDING_TEXT, type ContextKind } from './context-pending.ts'
import type { ChatItem } from './message-text.ts'
import { QuestionCard } from './question-card.tsx'
import type { Settled } from './question-state.ts'
import { toolLineOf } from './tool-view.ts'

/** A pasted message longer than this shows its first `PASTE_SHOWN` lines and `… +n lines`. */
const PASTE_LIMIT = 12
const PASTE_SHOWN = 10

export function pasteView(text: string): { lines: string[]; more: number } {
  const lines = text.split('\n')
  return lines.length > PASTE_LIMIT
    ? { lines: lines.slice(0, PASTE_SHOWN), more: lines.length - PASTE_SHOWN }
    : { lines, more: 0 }
}

/** Three muted lines at the top of an empty conversation: no banner, no logo. */
export function EmptyConversation() {
  return (
    <Box flexDirection="column" paddingLeft={GUTTER}>
      <Txt tone="muted">Talk to keith.</Txt>
      <Txt tone="muted">It can run tasks in the background and act on your nodes.</Txt>
      <Rich tone="muted" text="/tasks shows what runs, /help lists the commands." />
    </Box>
  )
}

export interface MessageListProps {
  items: readonly ChatItem[]
  /** Width of the painted rows. */
  width: number
  /** Width of wrapped text inside a message. */
  prose: number
  tasks: readonly Task[]
  /** A turn is running: the last assistant message streams, or `thinking…` shows. */
  busy: boolean
  /** The turn was sent and nothing visible came back yet. */
  thinking: boolean
  /** No model is set: a warning notice tops the conversation. */
  noModel: boolean
  /** What an empty conversation shows (default: the chat's three lines; the guest screen has its own). */
  empty?: ReactNode
  /** The question that takes keys (see `answerableOf`), with its cursor and whether the keys are on it. */
  question?: { id: string; cursor: number; focused: boolean } | undefined
  /** The questions settled here, by item id. */
  settled?: Readonly<Record<string, Settled>>
  /** A `/new` or `/compact` runs: its row shows where `thinking…` does. */
  contextPending?: ContextKind | undefined
  /** A memory dream runs: its animated line (`dreaming · 12 s`) shows where `thinking…` does. */
  dreaming?: string | undefined
}

/** The conversation: messages, tool lines, notices, with one blank row between them. */
export function MessageList({
  items,
  width,
  prose,
  tasks,
  busy,
  thinking,
  noModel,
  empty,
  question,
  settled = {},
  contextPending,
  dreaming,
}: MessageListProps) {
  const now = useNow(tasks.some(isActive))
  // the dividers are not messages: the streaming one is the last item that is not a divider
  const last = items.filter((item) => item.kind !== 'divider').at(-1)
  return (
    <Box flexDirection="column" gap={1}>
      {noModel && (
        <Box paddingLeft={GUTTER}>
          <Notice
            level="warning"
            rows={[
              'No model is set yet. On the core machine run:',
              'keith-core model set front <provider/model>',
            ]}
          />
        </Box>
      )}
      {items.length === 0 && !busy && empty !== undefined && (
        <Box flexDirection="column" paddingLeft={GUTTER}>
          {empty}
        </Box>
      )}
      {items.length === 0 && !busy && empty === undefined && (
        <Box flexDirection="column" paddingLeft={GUTTER}>
          <Txt tone="muted">
            Talk to keith. It can run tasks in the background and act on your nodes.
          </Txt>
          <Rich tone="muted" text="/tasks shows what runs, /help lists the commands." />
        </Box>
      )}
      {items.map((item) => {
        if (item.kind === 'notice') {
          return (
            <Box key={item.id} paddingLeft={GUTTER}>
              <Notice level={item.level} rows={[item.text]} />
            </Box>
          )
        }
        if (item.kind === 'question') {
          const open = question?.id === item.id ? question : undefined
          return (
            <QuestionCard
              key={item.id}
              item={item}
              width={width}
              {...(open === undefined
                ? {}
                : { open: { cursor: open.cursor, focused: open.focused } })}
              {...(settled[item.id] === undefined ? {} : { settled: settled[item.id] })}
            />
          )
        }
        if (item.kind === 'divider') {
          return <ContextDivider key={item.id} width={width} label={item.text} />
        }
        if (item.kind === 'user') {
          const { lines, more } = pasteView(item.text)
          return (
            <Message key={item.id} kind="user" width={width}>
              <Txt>{lines.join('\n')}</Txt>
              {more > 0 && <Txt tone="muted">{`${G.ellipsis} +${more} lines`}</Txt>}
            </Message>
          )
        }
        const streaming = busy && item === last
        return (
          <Message
            key={item.id}
            kind={item.proactive ? 'proactive' : 'assistant'}
            streaming={streaming}
            width={width}
          >
            {item.blocks.map((block, i) => {
              const before = item.blocks[i - 1]
              // the text after a tool line starts a new paragraph; tool lines hug the text above them
              const margin = block.kind === 'text' && before?.kind === 'tool' ? 1 : 0
              return block.kind === 'text' ? (
                <Box key={i} marginTop={margin}>
                  <Markdown text={block.text} width={prose} />
                </Box>
              ) : (
                <Box key={i}>
                  <Box flexGrow={1} flexDirection="column">
                    <ToolLine {...toolLineOf(block.call, tasks, now)} />
                  </Box>
                </Box>
              )
            })}
            {item.stopped && <Txt tone="muted">{`${G.stopped} stopped`}</Txt>}
          </Message>
        )
      })}
      {thinking && (
        <Message kind="assistant" streaming width={width}>
          <Txt tone="muted">{`thinking${G.ellipsis}`}</Txt>
        </Message>
      )}
      {contextPending !== undefined && (
        <Message kind="assistant" streaming width={width}>
          <Txt tone="muted">{CONTEXT_PENDING_TEXT[contextPending]}</Txt>
        </Message>
      )}
      {dreaming !== undefined && (
        <Message kind="assistant" streaming width={width}>
          <Txt tone="muted">{dreaming}</Txt>
        </Message>
      )}
    </Box>
  )
}
