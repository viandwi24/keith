// Built-in tools `thread.start_group`, `thread.invite`, `thread.join` and `thread.leave`
// (reserved namespace `thread`, phase 5). Registered through `tools.registerBuiltin()` when
// `BuiltinDeps.groups` is given. Rules: ADR-0017; see docs/architecture/core.md#group-threads.
// The bodies are placeholders: P5-C1 implements them with these names, schemas, tiers and answers.

import { ThreadId } from '@keith/protocol'
import { defineTool, type Tool, type ToolResult } from '@keith/sdk'
import { z } from 'zod'
import type { KeithConfig } from '../config/types.ts'
import type { GroupRefusalReason, GroupThreads } from '../mind/types.ts'
import type { PersonsRepository } from '../storage/types.ts'

/** Longest person name the tools accept (the `keith person add` limit). */
const PERSON_NAME_MAX_CHARS = 80

export type ThreadToolsDeps = {
  service: GroupThreads
  /** Resolves participant names (a name or a username, case-insensitive). */
  persons: Pick<PersonsRepository, 'findByName'>
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

function notImplemented(): ToolResult {
  return { content: 'thread tools are not implemented yet (P5-C1).', error: true }
}

/** The `thread.*` built-ins, bound to GroupThreads. */
export function createThreadTools(_deps: ThreadToolsDeps): Tool[] {
  const startGroup = defineTool({
    name: 'thread.start_group',
    description:
      'Start a group thread with other people, e.g. when someone asks to be connected with them. ' +
      'They get an invitation and join when they accept.',
    input: ThreadStartGroupInput,
    minTier: 'member',
    async run() {
      return notImplemented()
    },
  })
  const invite = defineTool({
    name: 'thread.invite',
    description: 'Invite more people to this group thread.',
    input: ThreadInviteInput,
    minTier: 'member',
    async run() {
      return notImplemented()
    },
  })
  const join = defineTool({
    name: 'thread.join',
    description: 'Accept an invitation to a group thread for the person you are talking to.',
    input: ThreadJoinInput,
    minTier: 'guest',
    async run() {
      return notImplemented()
    },
  })
  const leave = defineTool({
    name: 'thread.leave',
    description:
      'Take the person you are talking to out of a group thread, or decline an invitation to one. ' +
      'Afterwards they no longer see the group.',
    input: ThreadLeaveInput,
    minTier: 'guest',
    async run() {
      return notImplemented()
    },
  })
  return [startGroup, invite, join, leave]
}
