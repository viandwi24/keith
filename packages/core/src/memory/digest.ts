// The awareness digest: what else the Mind is doing, told only as far as visibility allows.
// See docs/architecture/memory.md#awareness-digest. Built from events plus repositories; it never
// calls the mind (docs/architecture/core.md#construction-order-bootstrap).

import type { CoreEventBus } from '../events/types.ts'
import type { PersonId, Task, TaskId, ThreadId, TurnState, Viewer } from '../shared/types.ts'
import type { PersonsRepository, TasksRepository, ThreadsRepository } from '../storage/types.ts'
import { isVisible, taskTarget, type VisibilityFacts, viewerPersonIds } from './visibility.ts'

export const DIGEST_MAX_LINES = 5
const GOAL_MAX_CHARS = 120

/**
 * Tracks what the repositories don't hold: thread turn states (`thread.state_changed`) and tasks
 * that ended but may still read as active (`task.*`).
 */
export class ActivityTracker {
  private readonly busyThreads = new Map<ThreadId, TurnState>()
  private readonly endedTasks = new Set<TaskId>()
  private readonly unsubscribe: (() => void)[]

  constructor(events: Pick<CoreEventBus, 'on'>) {
    const ended = (e: { data: { taskId: TaskId } }) => {
      this.endedTasks.add(e.data.taskId)
    }
    this.unsubscribe = [
      events.on('thread.state_changed', (e) => {
        if (e.data.to === 'idle') this.busyThreads.delete(e.data.threadId)
        else this.busyThreads.set(e.data.threadId, e.data.to)
      }),
      events.on('task.started', (e) => {
        this.endedTasks.delete(e.data.taskId)
      }),
      events.on('task.completed', ended),
      events.on('task.failed', ended),
      events.on('task.cancelled', ended),
    ]
  }

  /** Threads whose turn state is not `idle`, in the order they became busy. */
  busy(): [ThreadId, TurnState][] {
    return [...this.busyThreads]
  }

  /** Drops tasks already reported as ended, and forgets ended ids the repository no longer lists. */
  active(rows: Task[]): Task[] {
    const listed = new Set(rows.map((t) => t.id))
    for (const id of this.endedTasks) if (!listed.has(id)) this.endedTasks.delete(id)
    return rows.filter((t) => !this.endedTasks.has(t.id))
  }

  stop(): void {
    for (const u of this.unsubscribe) u()
  }
}

export type DigestDeps = {
  tracker: ActivityTracker
  persons: Pick<PersonsRepository, 'get'>
  threads: Pick<ThreadsRepository, 'get'>
  tasks: Pick<TasksRepository, 'listByStatus'>
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Up to `DIGEST_MAX_LINES` lines, or '' when nothing else is going on.
 * - Items whose visibility admits the viewer (I-4) are described in detail.
 * - Everything else is collapsed into generic counts with no names and no goals.
 * - If any viewer participant is a guest, the whole digest is counts only.
 */
export async function buildDigest(
  a: { threadId: ThreadId; viewer: Viewer; facts: VisibilityFacts },
  deps: DigestDeps,
): Promise<string> {
  const { threadId, viewer, facts } = a
  const viewerIds = viewerPersonIds(viewer)
  const tasks = deps.tracker.active(await deps.tasks.listByStatus(['queued', 'running']))
  const threads = deps.tracker.busy().filter(([id]) => id !== threadId)

  const guestView =
    viewerIds.length === 0 ||
    viewerIds.some((id) => facts.get(id)?.tier !== 'owner' && facts.get(id)?.tier !== 'member')
  if (guestView) {
    if (tasks.length === 0 && threads.length === 0) return ''
    return `- Also busy with ${plural(threads.length, 'other conversation', 'other conversations')} and ${plural(tasks.length, 'background task', 'background tasks')}.`
  }

  const detail: string[] = []
  let hiddenTasks = 0
  let hiddenThreads = 0
  const nameOf = async (id: PersonId): Promise<string> => {
    if (viewerIds.length === 1 && viewerIds[0] === id) return 'you'
    return (await deps.persons.get(id))?.name ?? 'someone'
  }

  for (const t of tasks) {
    if (!isVisible(taskTarget(t), viewer, facts)) {
      hiddenTasks++
      continue
    }
    const verb = t.status === 'running' ? 'Working on' : 'Queued'
    // A group task works for the group, not only for the person who started it.
    const group = t.visibility === 'thread' && t.threadId !== null ? await deps.threads.get(t.threadId) : null
    const forWhom = group ? `the group "${truncate(group.title, 60)}"` : await nameOf(t.personId)
    detail.push(`- ${verb} a background task for ${forWhom}: ${truncate(t.goal, GOAL_MAX_CHARS)}`)
  }

  for (const [id, state] of threads) {
    const thread = await deps.threads.get(id)
    if (!thread) continue
    // A thread admits the viewer when every viewer participant is a participant of it.
    if (!isVisible({ visibility: 'thread', subjectPersonId: null, threadId: id }, viewer, facts)) {
      hiddenThreads++
      continue
    }
    const doing = state === 'listening' ? 'Listening' : 'Replying'
    detail.push(`- ${doing} in your other thread "${truncate(thread.title, 60)}".`)
  }

  const generic: string[] = []
  if (hiddenTasks > 0) {
    generic.push(
      `- Busy with ${plural(hiddenTasks, 'private background task', 'private background tasks')} for someone else.`,
    )
  }
  if (hiddenThreads > 0) {
    generic.push(`- In ${plural(hiddenThreads, 'conversation', 'conversations')} with someone else.`)
  }

  const room = DIGEST_MAX_LINES - generic.length
  if (detail.length <= room) return [...detail, ...generic].join('\n')
  const shown = detail.slice(0, room - 1)
  const more = detail.length - shown.length
  return [...shown, `- And ${plural(more, 'more thing', 'more things')} going on.`, ...generic].join('\n')
}
