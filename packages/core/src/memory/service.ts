// MemoryService v1 (task P1-M1). See docs/architecture/memory.md.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type {
  Clock,
  Ids,
  Logger,
  Memory,
  MemoryId,
  NewMemory,
  PersonId,
  ThreadId,
  Tier,
  Viewer,
} from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import { ActivityTracker, buildDigest } from './digest.ts'
import type { MemoryService } from './types.ts'
import { isVisible, loadVisibilityFacts, toStorageFilter, type VisibilityFacts } from './visibility.ts'

export const RECALL_DEFAULT_LIMIT = 8
const RECALL_MAX_LIMIT = 50
/** How many visible memories `index` looks at. */
const INDEX_SCAN_LIMIT = 200
const INDEX_MAX_NAMES = 6
const INDEX_MAX_ENTRIES = 12
const TOPIC_MIN_LENGTH = 4

// Common English words that make poor topics.
const STOPWORDS = new Set(
  (
    'about above after again against also always because been before being below between both could ' +
    'does doing down during each even ever every from further have having here hers herself himself ' +
    'into itself just like likes loves more most much must never only other ours ourselves over prefers ' +
    'same should some such than that their theirs them themselves then there these they this those ' +
    'through under until very wants was were what when where which while whom with would your yours ' +
    'yourself yourselves'
  ).split(' '),
)

export type MemoryServiceDeps = {
  repos: Pick<Repositories, 'memories' | 'persons' | 'threads' | 'tasks'>
  events: Pick<CoreEventBus, 'on' | 'emit'>
  config: Pick<KeithConfig, 'memory'>
  clock: Clock
  ids: Ids
  log: Logger
}

export type ForgetResult = 'forgotten' | 'not_found' | 'forbidden'

/** The MemoryService, plus `forget` for the `memory.forget` built-in. */
export class MemoryStore implements MemoryService {
  private readonly tracker: ActivityTracker

  constructor(private readonly deps: MemoryServiceDeps) {
    this.tracker = new ActivityTracker(deps.events)
  }

  /** Unsubscribes from the event bus. */
  stop(): void {
    this.tracker.stop()
  }

  async write(m: NewMemory): Promise<Memory> {
    const content = m.content.trim()
    const threadId = m.threadId ?? null
    if (content.length === 0) {
      throw new KeithError('INTERNAL', 'memory content is empty')
    }
    if (m.visibility === 'subject' && m.subjectPersonId === null) {
      throw new KeithError('INTERNAL', "a 'subject' memory needs a subject person")
    }
    if (m.visibility === 'thread' && threadId === null) {
      throw new KeithError('INTERNAL', "a 'thread' memory needs a thread")
    }
    const now = this.deps.clock.now()
    const memory: Memory = {
      id: this.deps.ids.next('mem'),
      content,
      subjectPersonId: m.subjectPersonId,
      visibility: m.visibility,
      threadId,
      source: m.source,
      authorPersonId: m.authorPersonId ?? null,
      pinned: m.pinned ?? false,
      createdAt: now,
      updatedAt: now,
      lastRecalledAt: null,
    }
    await this.deps.repos.memories.create(memory)
    this.deps.events.emit('memory.written', {
      memoryId: memory.id,
      visibility: memory.visibility,
      subjectPersonId: memory.subjectPersonId,
    })
    this.deps.log.debug('memory written', { memoryId: memory.id, visibility: memory.visibility })
    return memory
  }

  async recall(q: { text: string; viewer: Viewer; limit?: number | undefined }): Promise<Memory[]> {
    if (q.text.trim().length === 0) return []
    const limit = Math.min(Math.max(Math.floor(q.limit ?? RECALL_DEFAULT_LIMIT), 1), RECALL_MAX_LIMIT)
    const facts = await this.facts(q.viewer)
    const found = await this.deps.repos.memories.search(q.text, toStorageFilter(q.viewer, facts), { limit })
    const visible = this.visibleOnly(found, q.viewer, facts)
    if (visible.length > 0) {
      await this.deps.repos.memories.touchRecalled(
        visible.map((m) => m.id),
        this.deps.clock.now(),
      )
    }
    return visible
  }

  async core(viewer: Viewer): Promise<Memory[]> {
    return this.coreWith(viewer, await this.facts(viewer))
  }

  async index(viewer: Viewer): Promise<string[]> {
    const facts = await this.facts(viewer)
    const inCore = new Set((await this.coreWith(viewer, facts)).map((m) => m.id))
    const listed = await this.deps.repos.memories.list(toStorageFilter(viewer, facts), {
      limit: INDEX_SCAN_LIMIT,
    })
    const rest = this.visibleOnly(listed, viewer, facts).filter((m) => !inCore.has(m.id))

    const subjectCounts = new Map<PersonId, number>()
    for (const m of rest) {
      if (m.subjectPersonId)
        subjectCounts.set(m.subjectPersonId, (subjectCounts.get(m.subjectPersonId) ?? 0) + 1)
    }
    const names: string[] = []
    for (const [id] of [...subjectCounts].sort((a, b) => b[1] - a[1]).slice(0, INDEX_MAX_NAMES)) {
      const person = await this.deps.repos.persons.get(id)
      if (person) names.push(person.name)
    }

    const skip = new Set(names.map((n) => n.toLowerCase()))
    const topicCounts = new Map<string, number>()
    for (const m of rest) {
      for (const word of new Set(m.content.toLowerCase().match(/[a-z][a-z-]*[a-z]/g) ?? [])) {
        if (word.length < TOPIC_MIN_LENGTH || STOPWORDS.has(word) || skip.has(word)) continue
        topicCounts.set(word, (topicCounts.get(word) ?? 0) + 1)
      }
    }
    // Map iteration keeps first-seen (newest memory) order, and the sort is stable.
    const topics = [...topicCounts].sort((a, b) => b[1] - a[1]).map(([w]) => w)
    return [...names, ...topics].slice(0, INDEX_MAX_ENTRIES)
  }

  async digest(a: { threadId: ThreadId; viewer: Viewer }): Promise<string> {
    const { persons, threads, tasks } = this.deps.repos
    return buildDigest(
      { threadId: a.threadId, viewer: a.viewer, facts: await this.facts(a.viewer) },
      { tracker: this.tracker, persons, threads, tasks },
    )
  }

  /**
   * Hard-deletes a memory (`memory.forget`). Only the owner or the memory's subject may forget it,
   * and only a memory visible to the viewer: anything else reads as not found, so existence never
   * leaks.
   */
  async forget(a: {
    id: MemoryId
    person: { id: PersonId; tier: Tier }
    viewer: Viewer
  }): Promise<ForgetResult> {
    const memory = await this.deps.repos.memories.get(a.id)
    if (!memory || !isVisible(memory, a.viewer, await this.facts(a.viewer))) return 'not_found'
    if (a.person.tier !== 'owner' && memory.subjectPersonId !== a.person.id) return 'forbidden'
    await this.deps.repos.memories.delete(a.id)
    this.deps.log.info('memory forgotten', { memoryId: a.id, by: a.person.id })
    return 'forgotten'
  }

  private facts(viewer: Viewer): Promise<VisibilityFacts> {
    return loadVisibilityFacts(viewer, this.deps.repos)
  }

  /** Defense in depth: storage already filtered, but every read path re-checks I-4. */
  private visibleOnly(memories: Memory[], viewer: Viewer, facts: VisibilityFacts): Memory[] {
    const visible = memories.filter((m) => isVisible(m, viewer, facts))
    if (visible.length !== memories.length) {
      this.deps.log.warn('storage returned invisible memories', { dropped: memories.length - visible.length })
    }
    return visible
  }

  /** Pinned and visible, newest first, skipping any memory that would push the total past the cap. */
  private async coreWith(viewer: Viewer, facts: VisibilityFacts): Promise<Memory[]> {
    const pinned = await this.deps.repos.memories.list(toStorageFilter(viewer, facts), { pinned: true })
    const cap = this.deps.config.memory.coreMaxChars
    const out: Memory[] = []
    let used = 0
    for (const m of this.visibleOnly(pinned, viewer, facts)) {
      if (!m.pinned || used + m.content.length > cap) continue
      out.push(m)
      used += m.content.length
    }
    return out
  }
}
