import { MAIN_THREAD_LABEL } from '@keith/client'
import type { PersonDto, ThreadDto, ThreadId } from '@keith/protocol'
import { cn } from 'cn'

/**
 * Phase 5: the person's threads, "Main" (the direct thread) first, then the groups by recent
 * update. `ChatState.threads` is sorted by recency only, so the direct thread is moved up here.
 */
export function orderThreads(threads: readonly ThreadDto[]): ThreadDto[] {
  return [...threads.filter((t) => t.kind === 'direct'), ...threads.filter((t) => t.kind !== 'direct')]
}

/** The other current participants' names, e.g. `Pepper, Rhodey`. Empty for a direct thread. */
export function otherParticipants(thread: ThreadDto, me: PersonDto | null): string {
  if (thread.kind === 'direct') return ''
  return thread.participants
    .filter((p) => p.id !== me?.id)
    .map((p) => p.name)
    .join(', ')
}

/** The thread list of the sidebar (and of the sheet on narrow screens). */
export function ThreadList({
  threads,
  currentId,
  me,
  disabled,
  onSelect,
}: {
  threads: readonly ThreadDto[]
  currentId: ThreadId | null
  me: PersonDto | null
  disabled: boolean
  onSelect: (threadId: ThreadId) => void
}) {
  const ordered = orderThreads(threads)
  return (
    <nav aria-label="Threads" data-slot="thread-list" className="flex flex-col gap-1 p-2">
      {ordered.map((thread) => {
        const current = thread.id === currentId
        const others = otherParticipants(thread, me)
        return (
          <button
            key={thread.id}
            type="button"
            data-slot="thread-item"
            data-thread-id={thread.id}
            data-kind={thread.kind}
            aria-current={current ? 'page' : undefined}
            disabled={disabled && !current}
            onClick={() => onSelect(thread.id)}
            className={cn(
              'flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-none',
              'hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
              current && 'bg-muted font-medium',
            )}
          >
            <span className="w-full truncate">
              {thread.kind === 'direct' ? MAIN_THREAD_LABEL : thread.title}
            </span>
            {others ? (
              <span data-slot="thread-participants" className="w-full truncate text-xs text-muted-foreground">
                {others}
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}
