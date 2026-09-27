// Built-in memory tools: memory.remember, memory.recall, memory.forget (reserved namespace
// `memory`). Registered by bootstrap through `tools.registerBuiltin()`. See
// docs/architecture/memory.md.

import { MemoryId } from '@keith/protocol'
import { defineTool, type Tool, type ToolRunContext } from '@keith/sdk'
import { z } from 'zod'
import type { MemoryStore } from '../memory/index.ts'
import type { Memory, PersonId, Viewer, Visibility } from '../shared/types.ts'
import type { PersonsRepository } from '../storage/types.ts'

export type MemoryToolsDeps = {
  memory: Pick<MemoryStore, 'write' | 'recall' | 'forget'>
  persons: Pick<PersonsRepository, 'list'>
}

const VISIBILITIES = ['subject', 'thread', 'household', 'owner'] as const satisfies readonly Visibility[]

/** The viewer of a tool call: everyone the context was built for (I-3). */
function viewerOf(t: ToolRunContext): Viewer {
  const ids = t.participants.map((p) => p.id)
  return { participants: ids.length > 0 ? ids : [t.person.id] }
}

function isGroup(t: ToolRunContext): boolean {
  return new Set(t.participants.map((p) => p.id)).size > 1
}

const fail = (content: string) => ({ content, error: true })

function describeVisibility(v: Visibility): string {
  switch (v) {
    case 'subject':
      return 'only the person it is about'
    case 'thread':
      return 'the participants of this thread'
    case 'household':
      return 'owners and members'
    case 'owner':
      return 'owners only'
  }
}

function formatMemory(m: Memory): string {
  return `- ${m.id}: ${m.content}`
}

export function createMemoryTools(deps: MemoryToolsDeps): Tool[] {
  const remember = defineTool({
    name: 'memory.remember',
    description:
      'Remember one fact for later conversations. Use one short sentence per fact. By default it is private ' +
      'to the person it is about (or to this thread in a group).',
    minTier: 'guest',
    input: z.object({
      content: z.string().trim().min(1).max(500).describe('The fact, one sentence.'),
      subject: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Name of the person the fact is about. Omit for the speaker. 'none' for household or world facts.",
        ),
      visibility: z
        .enum(VISIBILITIES)
        .optional()
        .describe(
          "Who may see it: 'subject' (the person it is about), 'thread' (this thread's participants), " +
            "'household' (owners and members), 'owner' (owners only).",
        ),
      pinned: z.boolean().optional().describe('Pinned facts are always in context. Default false.'),
    }),
    async run(input, t) {
      let subjectPersonId: PersonId | null
      const subject = input.subject?.toLowerCase()
      if (subject === undefined || subject === 'me' || subject === t.person.name.toLowerCase()) {
        subjectPersonId = t.person.id
      } else if (subject === 'none') {
        subjectPersonId = null
      } else {
        const match = (await deps.persons.list()).find(
          (p) => p.name.toLowerCase() === subject || p.username?.toLowerCase() === subject,
        )
        if (!match) return fail(`Unknown person '${input.subject}'. Use a known name, or 'none'.`)
        subjectPersonId = match.id
      }

      // Defaults (memory.md): group thread → 'thread'; about the speaker → 'subject'; a fact the
      // speaker states about someone else or the world stays in the speaker's thread.
      let visibility: Visibility
      if (input.visibility) visibility = input.visibility
      else if (isGroup(t)) visibility = 'thread'
      else if (subjectPersonId === t.person.id) visibility = 'subject'
      else if (t.threadId !== null) visibility = 'thread'
      else return fail('There is no thread here: set visibility explicitly.')

      if (visibility === 'subject' && subjectPersonId === null) {
        return fail("Visibility 'subject' needs a subject person.")
      }
      if (visibility === 'thread' && t.threadId === null) return fail("Visibility 'thread' needs a thread.")
      if (visibility === 'household' && t.person.tier === 'guest') {
        return fail("Guests can't write household memories.")
      }
      if (visibility === 'owner' && t.person.tier !== 'owner')
        return fail("Only owners can write 'owner' memories.")

      const inTask = t.taskId !== null
      const memory = await deps.memory.write({
        content: input.content,
        subjectPersonId,
        visibility,
        threadId: t.threadId,
        source: inTask ? 'inferred' : 'stated',
        authorPersonId: inTask ? null : t.person.id,
        pinned: input.pinned ?? false,
      })
      return { content: `Remembered ${memory.id} (visible to ${describeVisibility(visibility)}).` }
    },
  })

  const recall = defineTool({
    name: 'memory.recall',
    description: 'Search remembered facts. Returns the best matches this conversation may see.',
    minTier: 'guest',
    input: z.object({ query: z.string().trim().min(1).max(200).describe('Words to search for.') }),
    async run(input, t) {
      const found = await deps.memory.recall({ text: input.query, viewer: viewerOf(t) })
      if (found.length === 0) return { content: 'No matching memories.' }
      return { content: found.map(formatMemory).join('\n') }
    },
  })

  const forget = defineTool({
    name: 'memory.forget',
    description:
      'Permanently delete a remembered fact by id. Only the owner or the person it is about may do this.',
    minTier: 'guest',
    input: z.object({ id: MemoryId.describe('The memory id, e.g. from memory.recall.') }),
    async run(input, t) {
      const result = await deps.memory.forget({
        id: input.id,
        person: { id: t.person.id, tier: t.person.tier },
        viewer: viewerOf(t),
      })
      switch (result) {
        case 'forgotten':
          return { content: `Forgot ${input.id}.` }
        case 'not_found':
          return fail(`No memory ${input.id} is visible here.`)
        case 'forbidden':
          return fail('Only the owner or the person this memory is about can forget it.')
      }
    },
  })

  return [remember, recall, forget]
}
