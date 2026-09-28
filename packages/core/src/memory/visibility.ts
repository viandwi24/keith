// The visibility rule (I-4). Every memory read path goes through this file: recall, core, index,
// digest and the context builder. See docs/architecture/memory.md#visibility-rule-i-4.

import type { Memory, PersonId, Task, ThreadId, Tier, Viewer } from '../shared/types.ts'
import type { MemoryFilter, PersonsRepository, ThreadsRepository } from '../storage/types.ts'

/** What the rule needs to know about one person. */
export type PersonFacts = {
  tier: Tier
  /** Threads the person is a current participant of. */
  threadIds: ReadonlySet<ThreadId>
}

/** Facts about (at least) every viewer participant. A person missing here is admitted to nothing. */
export type VisibilityFacts = ReadonlyMap<PersonId, PersonFacts>

/** The part of a memory (or task) the rule looks at. */
export type VisibilityTarget = Pick<Memory, 'visibility' | 'subjectPersonId' | 'threadId'>

/**
 * A task as a visibility target: its `visibility`, its person as the subject and the thread it was
 * started in (docs/architecture/memory.md#visibility-rule-i-4).
 */
export function taskTarget(task: Pick<Task, 'visibility' | 'personId' | 'threadId'>): VisibilityTarget {
  return { visibility: task.visibility, subjectPersonId: task.personId, threadId: task.threadId }
}

/** The viewer's distinct participants, in their original order. */
export function viewerPersonIds(viewer: Viewer): PersonId[] {
  return [...new Set(viewer.participants)]
}

/** True when the target's visibility admits one person (one row of the table in memory.md). */
export function admits(target: VisibilityTarget, personId: PersonId, persons: VisibilityFacts): boolean {
  const facts = persons.get(personId)
  if (!facts) return false
  switch (target.visibility) {
    case 'subject':
      return target.subjectPersonId === personId
    case 'thread':
      return target.threadId !== null && facts.threadIds.has(target.threadId)
    case 'household':
      return facts.tier === 'owner' || facts.tier === 'member'
    case 'owner':
      return facts.tier === 'owner'
  }
}

/**
 * I-4: visible only if the rule admits **every** participant of the viewer. A viewer with no
 * participants sees nothing (an empty "every" is never taken as a yes).
 */
export function isVisible(target: VisibilityTarget, viewer: Viewer, persons: VisibilityFacts): boolean {
  const ids = viewerPersonIds(viewer)
  if (ids.length === 0) return false
  return ids.every((id) => admits(target, id, persons))
}

const DENY_ALL: MemoryFilter = {
  allowHousehold: false,
  allowOwner: false,
  subjectPersonId: null,
  threadIds: [],
}

/**
 * The same rule as a storage filter (docs/architecture/storage.md#memory-search-filter). For every
 * memory, `isVisible` and the filter agree; the tests check this over the whole matrix.
 */
export function toStorageFilter(viewer: Viewer, persons: VisibilityFacts): MemoryFilter {
  const ids = viewerPersonIds(viewer)
  const facts: PersonFacts[] = []
  for (const id of ids) {
    const f = persons.get(id)
    if (!f) return { ...DENY_ALL }
    facts.push(f)
  }
  const [first, ...rest] = facts
  if (!first) return { ...DENY_ALL }
  const threadIds = [...first.threadIds].filter((t) => rest.every((f) => f.threadIds.has(t))).sort()
  return {
    allowHousehold: facts.every((f) => f.tier === 'owner' || f.tier === 'member'),
    allowOwner: facts.every((f) => f.tier === 'owner'),
    subjectPersonId: ids.length === 1 ? (ids[0] ?? null) : null,
    threadIds,
  }
}

/** Loads the facts for the viewer's participants from the repositories. Unknown persons are left out. */
export async function loadVisibilityFacts(
  viewer: Viewer,
  repos: { persons: Pick<PersonsRepository, 'get'>; threads: Pick<ThreadsRepository, 'listForPerson'> },
): Promise<VisibilityFacts> {
  const entries = await Promise.all(
    viewerPersonIds(viewer).map(async (id): Promise<[PersonId, PersonFacts] | null> => {
      const person = await repos.persons.get(id)
      if (!person) return null
      const threads = await repos.threads.listForPerson(id)
      return [id, { tier: person.tier, threadIds: new Set(threads.map((t) => t.id)) }]
    }),
  )
  return new Map(entries.filter((e): e is [PersonId, PersonFacts] => e !== null))
}
