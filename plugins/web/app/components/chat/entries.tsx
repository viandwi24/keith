import type { Entry, MessageEntry, NoticeEntry, ToolEntry } from '@keith/client'
import { cn } from 'cn'
import { UiBlockView } from '../blocks/ui-block.tsx'
import { Markdown } from '../markdown.tsx'
import { Badge } from '../ui/badge.tsx'

/**
 * An assistant row with no text and no blocks that is not streaming: an intermediate tool step
 * from `GET /v1/threads/:id/messages` (P2-D1). It carries nothing to show.
 */
export function isHiddenEntry(entry: Entry): boolean {
  return (
    entry.kind === 'message' &&
    entry.role === 'assistant' &&
    !entry.streaming &&
    !entry.cancelled &&
    entry.text.trim() === '' &&
    entry.ui.length === 0
  )
}

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'message':
      return <MessageView entry={entry} />
    case 'tool':
      return <ToolView entry={entry} />
    case 'notice':
      return <NoticeView entry={entry} />
    case 'ui':
      return (
        <div data-slot="floating-ui" className="max-w-[85%]">
          <UiBlockView entry={entry} messageId={undefined} />
        </div>
      )
  }
}

function MessageView({ entry }: { entry: MessageEntry }) {
  const mine = entry.role === 'user'
  return (
    <div
      data-slot="message"
      data-role={entry.role}
      data-message-id={entry.id}
      data-proactive={entry.proactive || undefined}
      className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}
    >
      {entry.proactive || entry.cancelled ? (
        <div className="flex gap-1">
          {entry.proactive ? <Badge variant="secondary">Keith, on its own</Badge> : null}
          {entry.cancelled ? <Badge variant="outline">cancelled</Badge> : null}
        </div>
      ) : null}
      {entry.text !== '' || entry.streaming ? (
        <div
          className={cn(
            'max-w-[85%] rounded-2xl px-3.5 py-2',
            mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
            entry.proactive && 'ring-1 ring-ring/40',
            entry.local && 'opacity-80',
          )}
        >
          {mine ? (
            <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
          ) : (
            <Markdown text={entry.text} />
          )}
          {entry.streaming ? (
            <span
              data-slot="streaming"
              className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-current align-middle"
            />
          ) : null}
        </div>
      ) : null}
      {entry.ui.map((ui) => (
        <div key={ui.block.id} className="w-full max-w-[85%]">
          <UiBlockView entry={ui} messageId={entry.id} />
        </div>
      ))}
    </div>
  )
}

const TOOL_MARK = { started: '…', completed: '✓', failed: '✗' } as const

function ToolView({ entry }: { entry: ToolEntry }) {
  return (
    <div
      data-slot="tool-activity"
      data-status={entry.status}
      className={cn(
        'flex items-center gap-2 px-1 text-xs text-muted-foreground',
        entry.status === 'failed' && 'text-destructive',
      )}
    >
      <span aria-hidden>{TOOL_MARK[entry.status]}</span>
      <span className="font-mono">{entry.name}</span>
      {entry.summary ? <span>{entry.summary}</span> : null}
    </div>
  )
}

function NoticeView({ entry }: { entry: NoticeEntry }) {
  return (
    <p
      data-slot="notice"
      data-level={entry.level}
      className={cn(
        'px-1 text-xs',
        entry.level === 'info' && 'text-muted-foreground',
        entry.level === 'warn' && 'text-amber-600 dark:text-amber-400',
        entry.level === 'error' && 'text-destructive',
      )}
    >
      {entry.text}
    </p>
  )
}
