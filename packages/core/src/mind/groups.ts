// Group threads (phase 5): start, invite, join and leave, with invitations as deliveries.
// See docs/architecture/core.md#group-threads and ADR-0017.

import { KeithError } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { DeliveryQueue } from '../scheduler/types.ts'
import type { Clock, Ids, Logger, PersonId, ThreadId, Tier, UiBlock } from '../shared/types.ts'
import type { PersonRecord, Repositories, ThreadRecord } from '../storage/types.ts'
import type { GroupRefusalReason, GroupThreads } from './types.ts'

export type GroupThreadsDeps = {
  /** `mind.group` (`maxParticipants`, `autoJoin`). */
  config: Pick<KeithConfig, 'mind'>
  repos: Pick<Repositories, 'persons' | 'threads' | 'threadInvitations'>
  /** Invitations are `invitation` deliveries in the invitee's main thread. */
  deliveries: Pick<DeliveryQueue, 'enqueue'>
  /** Emits `thread.participant_joined` and `thread.participant_left`. */
  events: Pick<CoreEventBus, 'emit'>
  ids: Ids
  clock: Clock
  log: Logger
}

/** Block ids of the invitation card and its buttons. */
export const INVITATION_CARD_ID = 'group_invitation'
export const INVITATION_ACTIONS_ID = 'group_invitation_actions'

function refuse(reason: GroupRefusalReason, message: string): KeithError {
  return new KeithError('FORBIDDEN', message, { details: { reason } })
}

function atLeastMember(tier: Tier): boolean {
  return tier === 'member' || tier === 'owner'
}

/** `text` followed by a period, unless it already ends a sentence. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** What the invitee's delivery says: an invitation to answer, or a notice that they were added. */
export function invitationText(a: {
  inviterName: string
  thread: Pick<ThreadRecord, 'id' | 'title' | 'purpose'>
  joined: boolean
}): string {
  const { inviterName, thread } = a
  const head = a.joined
    ? `${inviterName} added you to the group thread "${thread.title}" (${thread.id})`
    : `${inviterName} invites you to the group thread "${thread.title}" (${thread.id})`
  const purpose = thread.purpose ? `: ${thread.purpose}` : ''
  const tail = a.joined ? 'It is in your thread list.' : 'Say whether you want to join.'
  return `${sentence(head + purpose)} ${tail}`
}

function invitationCard(title: string, text: string, withButtons: boolean): UiBlock {
  return {
    type: 'card',
    id: INVITATION_CARD_ID,
    title,
    body: text,
    ...(withButtons
      ? {
          children: [
            {
              type: 'actions',
              id: INVITATION_ACTIONS_ID,
              actions: [
                { id: 'join', label: 'Join', style: 'primary' },
                { id: 'decline', label: 'Decline', style: 'secondary' },
              ],
            },
          ],
        }
      : {}),
  }
}

export function createGroupThreads(deps: GroupThreadsDeps): GroupThreads {
  const { repos, events, clock, log } = deps
  const max = (): number => deps.config.mind.group.maxParticipants

  async function getThread(threadId: ThreadId): Promise<ThreadRecord> {
    const thread = await repos.threads.get(threadId)
    if (!thread) throw new KeithError('NOT_FOUND', `no thread ${threadId}`)
    return thread
  }

  /** Checks the invitee list (no_invitees, self, unknown_person) and returns the records, deduplicated. */
  async function resolveInvitees(inviterId: PersonId, inviteeIds: PersonId[]): Promise<PersonRecord[]> {
    const unique = [...new Set(inviteeIds)]
    if (unique.length === 0) throw refuse('no_invitees', 'name at least one invitee')
    if (unique.includes(inviterId)) throw refuse('self', 'the invitee list names the inviter')
    const records: PersonRecord[] = []
    for (const id of unique) {
      const p = await repos.persons.get(id)
      if (!p) throw refuse('unknown_person', `unknown person ${id}`)
      records.push(p)
    }
    return records
  }

  /** The inviter's checks are done; invites everyone not already in or invited. */
  async function inviteChecked(
    thread: ThreadRecord,
    inviter: PersonRecord,
    invitees: PersonRecord[],
  ): Promise<{ invited: PersonId[]; joined: PersonId[]; skipped: PersonId[] }> {
    const current = new Set((await repos.threads.participants(thread.id)).map((p) => p.personId))
    const pending = await repos.threadInvitations.pendingForThread(thread.id)
    const pendingIds = new Set(pending.map((i) => i.personId))

    const skipped: PersonId[] = []
    const fresh: PersonRecord[] = []
    for (const p of invitees) {
      if (current.has(p.id) || pendingIds.has(p.id)) {
        skipped.push(p.id)
        continue
      }
      fresh.push(p)
    }
    if (current.size + pendingIds.size + fresh.length > max()) {
      throw refuse('limit', `a group thread has at most ${max()} people, counting pending invitations`)
    }

    const invited: PersonId[] = []
    const joined: PersonId[] = []
    for (const p of fresh) {
      const autoJoin = deps.config.mind.group.autoJoin && atLeastMember(p.tier)
      const text = invitationText({ inviterName: inviter.name, thread, joined: autoJoin })
      const delivery = await deps.deliveries.enqueue({
        personId: p.id,
        kind: 'invitation',
        authorPersonId: inviter.id,
        urgency: 'normal',
        content: text,
        ui: invitationCard(thread.title, text, !autoJoin),
      })
      const now = clock.now()
      const stored = await repos.threadInvitations.create({
        threadId: thread.id,
        personId: p.id,
        invitedBy: inviter.id,
        status: autoJoin ? 'accepted' : 'pending',
        deliveryId: delivery.id,
        createdAt: now,
        resolvedAt: autoJoin ? now : null,
      })
      if (!stored) log.warn('group invitation not stored', { threadId: thread.id, personId: p.id })
      if (autoJoin) {
        if (await repos.threads.addParticipant(thread.id, p.id, now)) {
          events.emit('thread.participant_joined', {
            threadId: thread.id,
            personId: p.id,
            invitedBy: inviter.id,
          })
        }
        joined.push(p.id)
      } else {
        invited.push(p.id)
      }
    }
    return { invited, joined, skipped }
  }

  return {
    async start(a) {
      const creator = await repos.persons.get(a.creatorId)
      if (!creator) throw new KeithError('NOT_FOUND', `no person ${a.creatorId}`)
      if (!atLeastMember(creator.tier)) throw refuse('tier', 'only members can start group threads')
      const invitees = await resolveInvitees(creator.id, a.inviteeIds)
      if (invitees.length > max() - 1) {
        throw refuse('limit', `a group thread has at most ${max()} people, counting pending invitations`)
      }

      const now = clock.now()
      const thread: ThreadRecord = {
        id: deps.ids.next('thr'),
        kind: 'group',
        slug: null,
        title: a.title,
        ownerPersonId: creator.id,
        summary: null,
        createdAt: now,
        updatedAt: now,
        purpose: a.purpose,
      }
      await repos.threads.create(thread, [creator.id])
      events.emit('thread.participant_joined', { threadId: thread.id, personId: creator.id, invitedBy: null })
      log.info('group thread started', { threadId: thread.id, personId: creator.id })

      const { invited, joined } = await inviteChecked(thread, creator, invitees)
      return { thread, invited, joined }
    },

    async invite(a) {
      const thread = await getThread(a.threadId)
      if (thread.kind !== 'group') throw refuse('not_group', 'not a group thread')
      const participants = await repos.threads.participants(thread.id)
      const inviter = await repos.persons.get(a.inviterId)
      if (!inviter || !participants.some((p) => p.personId === a.inviterId)) {
        throw refuse('not_participant', 'only participants can invite')
      }
      if (!atLeastMember(inviter.tier)) throw refuse('tier', 'only members can invite')
      const invitees = await resolveInvitees(inviter.id, a.inviteeIds)
      return inviteChecked(thread, inviter, invitees)
    },

    async join(a) {
      await getThread(a.threadId)
      const invitation = await repos.threadInvitations.get(a.threadId, a.personId)
      if (invitation?.status !== 'pending') return false
      const now = clock.now()
      if (!(await repos.threadInvitations.resolve(a.threadId, a.personId, 'accepted', now))) return false
      if (await repos.threads.addParticipant(a.threadId, a.personId, now)) {
        events.emit('thread.participant_joined', {
          threadId: a.threadId,
          personId: a.personId,
          invitedBy: invitation.invitedBy,
        })
      }
      return true
    },

    async leave(a) {
      const thread = await getThread(a.threadId)
      if (thread.kind !== 'group') throw refuse('not_group', 'a direct thread cannot be left')
      const now = clock.now()
      if (await repos.threads.removeParticipant(a.threadId, a.personId, now)) {
        events.emit('thread.participant_left', { threadId: a.threadId, personId: a.personId })
        return true
      }
      return repos.threadInvitations.resolve(a.threadId, a.personId, 'declined', now)
    },
  }
}
