// Built-in tools `thread.start_group`, `thread.invite`, `thread.join` and `thread.leave`
// (reserved namespace `thread`, phase 5). Registered through `tools.registerBuiltin()` when
// `BuiltinDeps.groups` is given. Rules: ADR-0017; see docs/architecture/core.md#group-threads.

import { ThreadId } from '@keith/protocol'
import { defineTool, isKeithError, type Tool, type ToolResult } from '@keith/sdk'
import { z } from 'zod'
import type { KeithConfig } from '../config/types.ts'
import type { GroupRefusalReason, GroupThreads } from '../mind/types.ts'
import type { PersonId } from '../shared/types.ts'
import type { PersonRecord, PersonsRepository, ThreadsRepository } from '../storage/types.ts'

/** Longest person name the tools accept (the `keith person add` limit). */
const PERSON_NAME_MAX_CHARS = 80

export type ThreadToolsDeps = {
  service: GroupThreads
  /** Resolves participant names (a name or a username, case-insensitive). */
  persons: Pick<PersonsRepository, 'findByName'>
  /** The thread's title for the `thread.join` / `thread.leave` answers, and whether the caller is in it. */
  threads: Pick<ThreadsRepository, 'get' | 'participants'>
  /** `mind.group.maxParticipants`, for the limit answer. */
  config: Pick<KeithConfig, 'mind'>
}

export const THREAD_TOOL_NAMES = [
  'thread.start_group',
  'thread.invite',
  'thread.join',
  'thread.leave',
] as const

/** Most people one `thread.start_group` / `thread.invite` call names (the default group size, 8, minus the caller). */
export const GROUP_INVITEES_MAX = 7

/** Longest group title. */
export const GROUP_TITLE_MAX_CHARS = 80

/** Longest group purpose. */
export const GROUP_PURPOSE_MAX_CHARS = 500

/**
 * What the tools answer. Fixed here so every lane's tests see the same wording. `refused` has one
 * answer per `GroupRefusalReason`.
 */
export const THREAD_MESSAGES = {
  started: (a: { title: string; threadId: string; invited: string[]; joined: string[] }) =>
    `Started the group thread "${a.title}" (${a.threadId}).` +
    (a.invited.length > 0 ? ` Invited: ${a.invited.join(', ')}.` : '') +
    (a.joined.length > 0 ? ` Added: ${a.joined.join(', ')}.` : ''),
  invited: (a: { invited: string[]; joined: string[]; skipped: string[] }) =>
    [
      a.invited.length > 0 ? `Invited: ${a.invited.join(', ')}.` : '',
      a.joined.length > 0 ? `Added: ${a.joined.join(', ')}.` : '',
      a.skipped.length > 0 ? `Already in the group or invited: ${a.skipped.join(', ')}.` : '',
    ]
      .filter((part) => part !== '')
      .join(' '),
  joined: (title: string) => `Joined the group thread "${title}". It is now in the person's thread list.`,
  left: (title: string) => `Left the group thread "${title}".`,
  declined: (title: string) => `Declined the invitation to "${title}".`,
  unknown: (name: string) => `I don't know anyone called ${name}.`,
  noSuchThread: 'There is no such thread.',
  noInvitation: 'There is no pending invitation to that thread.',
  notInThread: 'You are not in that thread, and not invited to it.',
  refused: {
    tier: 'Only members can start group threads or invite people.',
    not_participant: 'Only people in the group can invite others to it.',
    not_group: 'This is not a group thread.',
    limit: (max: number) => `A group thread can have at most ${max} people, counting pending invitations.`,
    no_invitees: 'Name at least one other person.',
    self: 'Leave yourself out: you are in the group already.',
    unknown_person: "I don't know one of those people.",
  } satisfies Record<GroupRefusalReason, string | ((max: number) => string)>,
} as const

const participants = z
  .array(z.string().trim().min(1).max(PERSON_NAME_MAX_CHARS))
  .min(1)
  .max(GROUP_INVITEES_MAX)
  .describe('The other people, by name or username, e.g. ["Pepper", "Rhodey"]. Not the caller.')

export const ThreadStartGroupInput = z.object({
  participants,
  title: z.string().trim().min(1).max(GROUP_TITLE_MAX_CHARS).describe('A short title, e.g. "Mission".'),
  purpose: z
    .string()
    .trim()
    .max(GROUP_PURPOSE_MAX_CHARS)
    .optional()
    .describe('What the group is for, in one sentence.'),
})

export const ThreadInviteInput = z.object({ participants })

export const ThreadJoinInput = z.object({
  threadId: ThreadId.describe('The group thread id from the invitation, e.g. "thr_…".'),
})

export const ThreadLeaveInput = z.object({
  threadId: ThreadId.optional().describe(
    'The thread to leave, or the pending invitation to decline. Default: this thread.',
  ),
})

function toolError(content: string): ToolResult {
  return { content, error: true }
}

/**
 * Turns a refusal (`FORBIDDEN` with a `GroupRefusalReason`) or an unknown thread (`NOT_FOUND`) into
 * a tool error. Anything else is rethrown.
 */
function refusal(error: unknown, maxParticipants: number): ToolResult {
  if (isKeithError(error, 'NOT_FOUND')) return toolError(THREAD_MESSAGES.noSuchThread)
  if (isKeithError(error, 'FORBIDDEN')) {
    const reason = error.details?.reason as GroupRefusalReason | undefined
    if (reason !== undefined && reason in THREAD_MESSAGES.refused) {
      const answer = THREAD_MESSAGES.refused[reason]
      return toolError(typeof answer === 'function' ? answer(maxParticipants) : answer)
    }
  }
  throw error
}

/** The `thread.*` built-ins, bound to GroupThreads. */
export function createThreadTools(deps: ThreadToolsDeps): Tool[] {
  const max = (): number => deps.config.mind.group.maxParticipants

  /** Resolves every name, or answers the first unknown one. */
  async function resolve(names: string[]): Promise<PersonRecord[] | ToolResult> {
    const found: PersonRecord[] = []
    for (const name of names) {
      const person = await deps.persons.findByName(name)
      if (!person) return toolError(THREAD_MESSAGES.unknown(name))
      found.push(person)
    }
    return found
  }

  function namesOf(ids: PersonId[], people: PersonRecord[]): string[] {
    return ids.map((id) => people.find((p) => p.id === id)?.name ?? id)
  }

  const startGroup = defineTool({
    name: 'thread.start_group',
    description:
      'Start a group thread with other people, e.g. when someone asks to be connected with them. ' +
      'They get an invitation and join when they accept.',
    input: ThreadStartGroupInput,
    minTier: 'member',
    async run(input, ctx) {
      const people = await resolve(input.participants)
      if (!Array.isArray(people)) return people
      try {
        const r = await deps.service.start({
          creatorId: ctx.person.id,
          inviteeIds: people.map((p) => p.id),
          title: input.title,
          purpose: input.purpose && input.purpose !== '' ? input.purpose : null,
        })
        return {
          content: THREAD_MESSAGES.started({
            title: r.thread.title,
            threadId: r.thread.id,
            invited: namesOf(r.invited, people),
            joined: namesOf(r.joined, people),
          }),
        }
      } catch (error) {
        return refusal(error, max())
      }
    },
  })

  const invite = defineTool({
    name: 'thread.invite',
    description: 'Invite more people to this group thread.',
    input: ThreadInviteInput,
    minTier: 'member',
    async run(input, ctx) {
      if (ctx.threadId === null) return toolError(THREAD_MESSAGES.refused.not_group)
      const people = await resolve(input.participants)
      if (!Array.isArray(people)) return people
      try {
        const r = await deps.service.invite({
          threadId: ctx.threadId,
          inviterId: ctx.person.id,
          inviteeIds: people.map((p) => p.id),
        })
        return {
          content: THREAD_MESSAGES.invited({
            invited: namesOf(r.invited, people),
            joined: namesOf(r.joined, people),
            skipped: namesOf(r.skipped, people),
          }),
        }
      } catch (error) {
        return refusal(error, max())
      }
    },
  })

  const join = defineTool({
    name: 'thread.join',
    description: 'Accept an invitation to a group thread for the person you are talking to.',
    input: ThreadJoinInput,
    minTier: 'guest',
    async run(input, ctx) {
      try {
        const joined = await deps.service.join({ threadId: input.threadId, personId: ctx.person.id })
        if (!joined) return toolError(THREAD_MESSAGES.noInvitation)
      } catch (error) {
        return refusal(error, max())
      }
      const thread = await deps.threads.get(input.threadId)
      return { content: THREAD_MESSAGES.joined(thread?.title ?? input.threadId) }
    },
  })

  const leave = defineTool({
    name: 'thread.leave',
    description:
      'Take the person you are talking to out of a group thread, or decline an invitation to one. ' +
      'Afterwards they no longer see the group.',
    input: ThreadLeaveInput,
    minTier: 'guest',
    async run(input, ctx) {
      const threadId = input.threadId ?? ctx.threadId
      if (threadId === null) return toolError(THREAD_MESSAGES.noSuchThread)
      const thread = await deps.threads.get(threadId)
      if (!thread) return toolError(THREAD_MESSAGES.noSuchThread)
      const wasIn = (await deps.threads.participants(threadId)).some((p) => p.personId === ctx.person.id)
      try {
        const done = await deps.service.leave({ threadId, personId: ctx.person.id })
        if (!done) return toolError(THREAD_MESSAGES.notInThread)
      } catch (error) {
        return refusal(error, max())
      }
      return { content: wasIn ? THREAD_MESSAGES.left(thread.title) : THREAD_MESSAGES.declined(thread.title) }
    },
  })

  return [startGroup, invite, join, leave]
}
