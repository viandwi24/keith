// Thread DTOs for the thread list, and the live thread-list frames (phase 5). A membership change
// (`thread.participant_joined` / `thread.participant_left`) becomes `thread.updated` for every node
// of every current participant and `thread.removed` for the leaver's nodes.
// See docs/architecture/nodes.md#thread-list-phase-5 and docs/contracts/protocol.md#delivery-rules.

import {
  type CoreFrame,
  type CoreFrameType,
  type FrameData,
  makeFrame,
  type ThreadDto,
} from '@keith/protocol'
import type { CoreEventBus } from '../events/types.ts'
import type { ThreadManager } from '../mind/types.ts'
import type { Clock, Logger, PersonDto, PersonId, ThreadId } from '../shared/types.ts'
import type { Repositories, ThreadRecord } from '../storage/types.ts'
import type { ServerAttachmentRegistry } from './attachments.ts'
import { toPersonDto, toThreadDto } from './dto.ts'
import type { ServerPresence } from './presence.ts'

export type ThreadDescriberDeps = {
  repos: Pick<Repositories, 'persons' | 'threads'>
  threads: Pick<ThreadManager, 'state'>
}

/**
 * Builds a thread's `ThreadDto`, or null when no current participant exists any more. One
 * describer caches persons, so use a fresh one per request or per event.
 */
export type ThreadDescriber = (t: ThreadRecord) => Promise<ThreadDto | null>

export function createThreadDescriber(deps: ThreadDescriberDeps): ThreadDescriber {
  const cache = new Map<PersonId, PersonDto | null>()
  const people = async (ids: PersonId[]): Promise<PersonDto[]> => {
    const out: PersonDto[] = []
    for (const id of ids) {
      if (!cache.has(id)) {
        const p = await deps.repos.persons.get(id)
        cache.set(id, p ? toPersonDto(p) : null)
      }
      const dto = cache.get(id)
      if (dto) out.push(dto)
    }
    return out
  }
  return async (t) => {
    const current = await people((await deps.repos.threads.participants(t.id)).map((p) => p.personId))
    if (current.length === 0) return null
    const former =
      t.kind === 'group'
        ? await people((await deps.repos.threads.formerParticipants(t.id)).map((p) => p.personId))
        : []
    return toThreadDto(t, current, deps.threads.state(t.id), former)
  }
}

export type ThreadListFramesDeps = {
  log: Logger
  clock: Clock
  events: CoreEventBus
  repos: Pick<Repositories, 'persons' | 'threads'>
  threads: Pick<ThreadManager, 'state' | 'detach'>
  attachments: ServerAttachmentRegistry
  presence: Pick<ServerPresence, 'nodeDetached'>
  nextFrameId: () => string
}

/** Subscribes to the participant events. Returns the unsubscribe function. */
export function subscribeThreadListFrames(deps: ThreadListFramesDeps): () => void {
  const log = deps.log.child({ component: 'thread-list' })

  const frame = <T extends CoreFrameType>(type: T, data: FrameData<T>): CoreFrame =>
    makeFrame(type, data, { id: deps.nextFrameId(), ts: deps.clock.now() }) as CoreFrame

  /** `thread.updated` to every ready node of every current participant. */
  const sendUpdated = async (threadId: ThreadId) => {
    const record = await deps.repos.threads.get(threadId)
    if (!record) {
      log.warn('participant event for an unknown thread', { threadId })
      return
    }
    const thread = await createThreadDescriber(deps)(record)
    if (!thread) return
    for (const person of thread.participants) {
      for (const nodeId of deps.attachments.nodesOfPerson(person.id)) {
        deps.attachments.send(nodeId, frame('thread.updated', { thread }))
      }
    }
  }

  /** The leaver's nodes lose the thread: detached (no more frames of it), then `thread.removed`. */
  const removeFor = async (threadId: ThreadId, personId: PersonId) => {
    for (const nodeId of deps.attachments.nodesOfPerson(personId)) {
      const wasOpen = deps.attachments.threadsOf(nodeId).includes(threadId)
      if (wasOpen) {
        deps.attachments.detach(nodeId, threadId)
        deps.threads.detach({ nodeId, threadId })
        if (deps.attachments.threadsOf(nodeId).length === 0)
          await deps.presence.nodeDetached(personId, nodeId)
      }
      deps.attachments.send(nodeId, frame('thread.removed', { threadId }))
    }
  }

  const guarded = async (what: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      log.error('thread list update failed', { event: what, error: String(error) })
    }
  }

  const offJoined = deps.events.on('thread.participant_joined', (e) =>
    guarded(e.name, () => sendUpdated(e.data.threadId)),
  )
  const offLeft = deps.events.on('thread.participant_left', (e) =>
    guarded(e.name, async () => {
      await removeFor(e.data.threadId, e.data.personId)
      await sendUpdated(e.data.threadId)
    }),
  )
  return () => {
    offJoined()
    offLeft()
  }
}
