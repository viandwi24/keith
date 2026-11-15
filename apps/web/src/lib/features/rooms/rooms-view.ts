import { KEITH_NAME } from '@keith/app-model'
import type { RoomInvite, RoomListItem, RoomMemberStatus } from '@keith/contracts'

// View models of the Rooms list: every room the person is in or invited to, the invitations still open, a filter.

export type RoomFilter = 'all' | 'active' | 'invited' | 'ended'

export const ROOM_FILTERS: readonly { id: RoomFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'invited', label: 'Invitations' },
  { id: 'ended', label: 'Ended' },
]

/** What a room is to this person: live, waiting for invitees, an invitation, left (or removed) or over. */
export type RoomStanding = 'active' | 'waiting' | 'invited' | 'left' | 'ended'

const WORD: Record<RoomStanding, string> = {
  active: 'active',
  waiting: 'waiting for invitees',
  invited: 'invited',
  left: 'left',
  ended: 'ended',
}
const TONE: Record<RoomStanding, 'success' | 'info' | 'warning' | 'muted'> = {
  active: 'success',
  waiting: 'info',
  invited: 'warning',
  left: 'muted',
  ended: 'muted',
}

const mineOf = (header: RoomListItem, me: string) => header.members.find((m) => m.person.id === me)

const GONE: readonly RoomMemberStatus[] = ['left', 'removed', 'declined', 'expired']

export function standingOf(header: RoomListItem, me: string): RoomStanding {
  if (header.room.state === 'ended') return 'ended'
  const mine = mineOf(header, me)?.status
  if (mine === 'invited') return 'invited'
  if (mine !== undefined && GONE.includes(mine)) return 'left'
  return header.room.state === 'active' ? 'active' : 'waiting'
}

export interface RoomRowView {
  id: string
  name: string
  standing: RoomStanding
  word: string
  tone: (typeof TONE)[RoomStanding]
  initiator: string
  /** The active and invited members, then Keith. */
  members: string
  /** When the room started (or was made): the sort key and the date shown. */
  at: number
  /** `expires in 12 min` for an open invitation, else undefined. */
  expires: string | undefined
}

/** `expires in 12 min`, `expires in 2 h`, `expired`. */
export function expiryText(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'
  const min = Math.ceil(ms / 60_000)
  return min < 60 ? `expires in ${min} min` : `expires in ${Math.ceil(min / 60)} h`
}

export function roomRowsOf(
  headers: readonly RoomListItem[],
  me: string,
  now: number,
): RoomRowView[] {
  return headers
    .map((h) => {
      const standing = standingOf(h, me)
      const people = h.members
        .filter((m) => m.status === 'active' || m.status === 'invited')
        .map((m) => (m.status === 'invited' ? `${m.person.name} (invited)` : m.person.name))
      return {
        id: h.room.id,
        name: h.room.name,
        standing,
        word: WORD[standing],
        tone: TONE[standing],
        initiator: h.room.initiator.name,
        members: [...people, KEITH_NAME].join(', '),
        at: h.room.startedAt ?? h.room.createdAt,
        expires:
          standing === 'invited' && h.inviteExpiresAt !== null
            ? expiryText(h.inviteExpiresAt, now)
            : undefined,
      }
    })
    .sort((a, b) => b.at - a.at)
}

export function matchesFilter(row: Pick<RoomRowView, 'standing'>, filter: RoomFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return row.standing === 'active' || row.standing === 'waiting'
    case 'invited':
      return row.standing === 'invited'
    case 'ended':
      return row.standing === 'ended' || row.standing === 'left'
  }
}

/**
 * Every invitation this person can still answer: invited, the room not ended, within the server's expiry (`inviteExpiresAt`; a
 * list item without one is not an invitation). Oldest first, like the TUI's notice.
 */
export function pendingInvitesOf(
  headers: readonly RoomListItem[],
  me: string,
  now: number,
): RoomInvite[] {
  const out: RoomInvite[] = []
  for (const h of headers) {
    const member = mineOf(h, me)
    const expiresAt = h.inviteExpiresAt
    if (h.room.state === 'ended' || member?.status !== 'invited') continue
    if (expiresAt === null || expiresAt <= now) continue
    out.push({
      roomId: h.room.id,
      roomName: h.room.name,
      initiator: h.room.initiator,
      invitedAt: member.invitedAt,
      expiresAt,
    })
  }
  return out.sort((a, b) => a.invitedAt - b.invitedAt)
}

/** The usernames of a start or invite form: separated by spaces or commas, each once. */
export function inviteesOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter((w) => w !== '')
        .map((w) => w.replace(/^@/, '')),
    ),
  ]
}

export const NO_ROOMS =
  'You are not in a room. Start one with people you know: Keith joins and answers when addressed.'
export const DECLINED_TEXT = 'Declined.'
