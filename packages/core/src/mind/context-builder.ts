// Builds `{ system, messages, tools }` for one turn. See docs/architecture/core.md#context-builder.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { MemoryService } from '../memory/types.ts'
import type { CoreSkillRegistry, CoreToolRegistry } from '../plugins/types.ts'
import type { CommitmentService } from '../scheduler/types.ts'
import type { Clock, PersonDto, PersonId, ThreadId } from '../shared/types.ts'
import type { MessageRecord, Repositories, ThreadRecord } from '../storage/types.ts'
import {
  commitmentsSection,
  coreMemoriesSection,
  deliveriesSection,
  digestSection,
  memoryIndexSection,
  nowSection,
  type ParticipantCard,
  participantsSection,
  personaSection,
  skillsSection,
  summarySection,
} from './context-sections.ts'
import { authorName, lowestTier, toLlmMessages } from './messages.ts'
import type { ContextBuilder } from './types.ts'

export type ContextBuilderDeps = {
  /** `mind.context.recentMessages`, and `memory.summary.minMessages` for the window rule. */
  config: Pick<KeithConfig, 'mind' | 'memory'>
  /** Reads the persona text (`persona.md`). Called once per turn so edits apply without a restart. */
  persona: () => Promise<string>
  clock: Clock
  /**
   * `threads` gives the summary, its cursor, and the kind, title and purpose of a group.
   * `persons` gives the cards and the names of message and relay/invitation authors.
   */
  repos: Pick<Repositories, 'persons' | 'relationships' | 'messages' | 'threads'>
  memory: MemoryService
  commitments: Pick<CommitmentService, 'openFor'>
  skills: Pick<CoreSkillRegistry, 'list'>
  tools: Pick<CoreToolRegistry, 'list'>
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const { config } = deps
  return {
    async build(a) {
      const cards = await loadCards(deps, a.viewer.participants)
      const [persona, core, index, digest, commitments, thread] = await Promise.all([
        deps.persona(),
        deps.memory.core(a.viewer),
        deps.memory.index(a.viewer),
        deps.memory.digest({ threadId: a.threadId, viewer: a.viewer }),
        deps.commitments.openFor(a.threadId),
        deps.repos.threads.get(a.threadId),
      ])
      const window = await messagesWindow(deps, a.threadId, thread)
      const group = thread?.kind === 'group' ? thread : null
      const names = await loadNames(deps, cards, [
        ...(group ? window.filter((r) => r.role === 'user').map((r) => r.authorPersonId) : []),
        ...a.deliveries
          .filter((d) => d.kind === 'relay' || d.kind === 'invitation')
          .map((d) => d.authorPersonId),
      ])
      const skills = deps.skills.list().map((s) => s.skill)
      const sections = [
        personaSection(persona, config.mind.name),
        nowSection({
          now: deps.clock.now(),
          timezone: config.mind.timezone,
          capabilities: a.focusCapabilities,
        }),
        participantsSection(
          cards,
          group
            ? {
                title: group.title,
                purpose: group.purpose ?? null,
                answering: a.kind === 'user' ? answering(window, names) : null,
              }
            : null,
        ),
        coreMemoriesSection(core),
        memoryIndexSection(index),
        digestSection(digest),
        commitmentsSection(commitments),
        summarySection(thread?.summary),
        deliveriesSection(
          a.deliveries,
          a.kind,
          skills.map((s) => s.name),
          names,
        ),
        skillsSection(skills),
      ]
      const tools = deps.tools
        .list({ tier: lowestTier(cards.map((c) => c.person.tier)), capabilities: a.focusCapabilities })
        .map((t) => t.tool.name)
      return {
        system: sections.filter((s): s is string => s !== null).join('\n\n'),
        messages: toLlmMessages(window, { group: group !== null, names }),
        tools,
      }
    },
  }
}

/**
 * The recent-messages window. Without a summary cursor: the last `recentMessages` rows. With one:
 * the rows after the cursor, but at least `recentMessages` and at most `recentMessages +
 * memory.summary.minMessages`, so no row falls between the summary and the window while the
 * summary job keeps up.
 */
async function messagesWindow(
  deps: ContextBuilderDeps,
  threadId: ThreadId,
  thread: ThreadRecord | null,
): Promise<MessageRecord[]> {
  const recent = deps.config.mind.context.recentMessages
  const through = thread?.summaryThroughSeq
  if (through === null || through === undefined) {
    return (await deps.repos.messages.page({ threadId, limit: recent })).messages
  }
  const rows = (
    await deps.repos.messages.page({ threadId, limit: recent + deps.config.memory.summary.minMessages })
  ).messages
  const after = rows.filter((r) => (r.seq ?? 0) > through)
  return after.length >= recent ? after : rows.slice(Math.max(0, rows.length - recent))
}

async function loadCards(deps: ContextBuilderDeps, ids: PersonId[]): Promise<ParticipantCard[]> {
  return Promise.all(
    ids.map(async (id) => {
      const [record, relationship] = await Promise.all([
        deps.repos.persons.get(id),
        deps.repos.relationships.get(id),
      ])
      if (!record) throw new KeithError('NOT_FOUND', 'participant not found', { details: { personId: id } })
      const person: PersonDto = { id: record.id, name: record.name, tier: record.tier }
      return { person, relationship }
    }),
  )
}

/**
 * Names by person id: the participants' names from their cards, plus the `extra` ids (authors of
 * group messages in the window, and of relay and invitation deliveries) read with `persons.get`.
 * An id that no longer exists is left out, so it reads as `Someone`.
 */
async function loadNames(
  deps: ContextBuilderDeps,
  cards: ParticipantCard[],
  extra: (PersonId | null)[],
): Promise<Map<PersonId, string>> {
  const names = new Map<PersonId, string>(cards.map((c) => [c.person.id, c.person.name]))
  const missing = [...new Set(extra)].filter((id): id is PersonId => id !== null && !names.has(id))
  const records = await Promise.all(missing.map((id) => deps.repos.persons.get(id)))
  for (const r of records) if (r) names.set(r.id, r.name)
  return names
}

/** The author of the latest user message in the window: whose input the turn answers. */
function answering(window: MessageRecord[], names: ReadonlyMap<PersonId, string>): string | null {
  for (let i = window.length - 1; i >= 0; i--) {
    const r = window[i]
    if (r?.role === 'user') return authorName(r.authorPersonId, names)
  }
  return null
}

/** A `persona` reader for `persona.md`. A missing file reads as empty (the section falls back to a default line). */
export function personaFromFile(path: string): () => Promise<string> {
  return async () => {
    const file = Bun.file(path)
    return (await file.exists()) ? await file.text() : ''
  }
}
