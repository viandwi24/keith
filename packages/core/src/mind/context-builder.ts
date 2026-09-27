// Builds `{ system, messages, tools }` for one turn. See docs/architecture/core.md#context-builder.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { MemoryService } from '../memory/types.ts'
import type { CoreSkillRegistry, CoreToolRegistry } from '../plugins/types.ts'
import type { CommitmentService } from '../scheduler/types.ts'
import type { Clock, PersonDto, PersonId } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
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
} from './context-sections.ts'
import { lowestTier, toLlmMessages } from './messages.ts'
import type { ContextBuilder } from './types.ts'

export type ContextBuilderDeps = {
  config: Pick<KeithConfig, 'mind'>
  /** Reads the persona text (`persona.md`). Called once per turn so edits apply without a restart. */
  persona: () => Promise<string>
  clock: Clock
  repos: Pick<Repositories, 'persons' | 'relationships' | 'messages'>
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
      const [persona, core, index, digest, commitments, page] = await Promise.all([
        deps.persona(),
        deps.memory.core(a.viewer),
        deps.memory.index(a.viewer),
        deps.memory.digest({ threadId: a.threadId, viewer: a.viewer }),
        deps.commitments.openFor(a.threadId),
        deps.repos.messages.page({ threadId: a.threadId, limit: config.mind.context.recentMessages }),
      ])
      const sections = [
        personaSection(persona, config.mind.name),
        nowSection({
          now: deps.clock.now(),
          timezone: config.mind.timezone,
          capabilities: a.focusCapabilities,
        }),
        participantsSection(cards),
        coreMemoriesSection(core),
        memoryIndexSection(index),
        digestSection(digest),
        commitmentsSection(commitments),
        deliveriesSection(a.deliveries, a.kind),
        skillsSection(deps.skills.list().map((s) => s.skill)),
      ]
      const tools = deps.tools
        .list({ tier: lowestTier(cards.map((c) => c.person.tier)), capabilities: a.focusCapabilities })
        .map((t) => t.tool.name)
      return {
        system: sections.filter((s): s is string => s !== null).join('\n\n'),
        messages: toLlmMessages(page.messages),
        tools,
      }
    },
  }
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

/** A `persona` reader for `persona.md`. A missing file reads as empty (the section falls back to a default line). */
export function personaFromFile(path: string): () => Promise<string> {
  return async () => {
    const file = Bun.file(path)
    return (await file.exists()) ? await file.text() : ''
  }
}
