import {
  ROOM_PRESENCE_NOT_SHARED,
  type RoomEvent,
  type RoomHeader,
  type RoomIndicator,
  type RoomInvite,
  type RoomListItem,
  type RoomRequest,
  type RoomView,
} from '@keith/contracts'
import { G } from '@keith/ui'

/** Keith's person id in a room: the speaker of every Keith line and the last name of the member list. */
export const KEITH_ID = 'keith'
export const KEITH_NAME = 'Keith'
/** The longest text a confirmation bar quotes before it is cut. */
export const CONFIRM_TEXT_MAX = 80

const memberOf = (header: RoomHeader, me: string) => header.members.find((m) => m.person.id === me)

/** One banner row: accent while a room is active, muted while only invitations are out. */
export interface RoomBanner {
  roomId: string
  tone: 'accent' | 'muted'
  text: string
}

/**
 * The banner on Home and in the chat header. An active room the person is in comes first (`● Room "Planning" · Ana, Duta,
 * Keith · /room`, every active member then Keith). Otherwise a room the person opened that waits for invitees reads
 * `○ Room "Planning" · waiting for Ana, Duta · /room`. Nothing else shows a banner.
 */
export function bannerOf(headers: readonly RoomHeader[], me: string): RoomBanner | undefined {
  for (const header of headers) {
    if (header.room.state !== 'active' || memberOf(header, me)?.status !== 'active') continue
    const names = header.members.filter((m) => m.status === 'active').map((m) => m.person.name)
    return {
      roomId: header.room.id,
      tone: 'accent',
      text: `${G.dot} Room "${header.room.name}" ${G.sep} ${[...names, KEITH_NAME].join(', ')} ${G.sep} /room`,
    }
  }
  for (const header of headers) {
    if (header.room.state !== 'open' || memberOf(header, me)?.status !== 'active') continue
    const waiting = header.members.filter((m) => m.status === 'invited').map((m) => m.person.name)
    if (waiting.length === 0) continue
    return {
      roomId: header.room.id,
      tone: 'muted',
      text: `${G.idle} Room "${header.room.name}" ${G.sep} waiting for ${waiting.join(', ')} ${G.sep} /room`,
    }
  }
  return undefined
}

/** The room the person is in, active: what `/room invite`, `/room leave`, `/room remove` and `/room end` act on. */
export function activeRoomOf(
  headers: readonly RoomHeader[],
  me: string,
): { roomId: string; name: string } | undefined {
  for (const header of headers) {
    if (header.room.state !== 'active' || memberOf(header, me)?.status !== 'active') continue
    return { roomId: header.room.id, name: header.room.name }
  }
  return undefined
}

/** The invitation the person is offered: the oldest one still open, and how many more wait. */
export interface InviteNotice {
  invite: RoomInvite
  /** Invitations behind this one. */
  more: number
  /** `Ana invites you to a room with Keith.` (the screen adds the keys). */
  text: string
}

/**
 * The invitations this person can still accept: invited (not answered), the room not ended, and within the invitation time. The
 * expiry is the server's (`inviteExpiresAt` of `rooms.list`: `invitedAt` plus the room setting `rooms.inviteTtlMinutes`); a
 * list item without one is not an invitation. The oldest is the notice; the rest count.
 */
export function inviteNoticeOf(
  headers: readonly RoomListItem[],
  me: string,
  now: number,
): InviteNotice | undefined {
  const open: RoomInvite[] = []
  for (const header of headers) {
    const member = memberOf(header, me)
    const expiresAt = header.inviteExpiresAt
    if (header.room.state === 'ended' || member?.status !== 'invited') continue
    if (expiresAt === null || expiresAt <= now) continue
    open.push({
      roomId: header.room.id,
      roomName: header.room.name,
      initiator: header.room.initiator,
      invitedAt: member.invitedAt,
      expiresAt,
    })
  }
  open.sort((a, b) => a.invitedAt - b.invitedAt)
  const invite = open[0]
  if (invite === undefined) return undefined
  return {
    invite,
    more: open.length - 1,
    text: `${invite.initiator.name} invites you to a room with ${KEITH_NAME}.`,
  }
}

/** A line of the transcript as the screen draws it: who, whether it is Keith, and the words. */
export interface TranscriptLine {
  seq: number
  at: number
  kind: RoomEvent['kind']
  /** The speaker's name; undefined for a system line. */
  speaker: string | undefined
  /** True for Keith's own lines (the `K` glyph). */
  keith: boolean
  body: string
}

/**
 * One event as a line. A `handoff` has no text in the room (its request stays in the speaker's chat), so it reads
 * `asked in their own chat`. Membership events name the person.
 */
export function lineOf(event: RoomEvent): TranscriptLine {
  const speaker = event.speaker?.name
  const name = speaker ?? 'someone'
  const body = (() => {
    switch (event.kind) {
      case 'handoff':
        return `${name} asked in their own chat`
      case 'join':
        return `${name} joined`
      case 'leave':
        return `${name} left`
      case 'remove':
        return event.text ?? `${name} was removed`
      case 'end':
        return event.text ?? 'the room ended'
      default:
        return event.text ?? ''
    }
  })()
  return {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    speaker,
    keith: event.speaker?.id === KEITH_ID,
    body,
  }
}

/** What the presence of a member reads as. `unshared`: the member released none (`not shared`). */
export type PresenceDot = 'online' | 'busy' | 'offline' | 'unshared'

export interface MemberRow {
  id: string
  name: string
  /** `active` members and `invited` ones (shown muted until they answer). */
  status: 'active' | 'invited'
  dot: PresenceDot
}

export interface PendingConfirmation {
  id: string
  kind: RoomRequest['kind']
  /** The question the bar shows, e.g. `Remove Duta from the room?`, `Share this with Planning?`. */
  question: string
  /** The text a `post` quotes under the question (cut at CONFIRM_TEXT_MAX); undefined for the other kinds. */
  detail: string | undefined
}

export interface RoomViewState {
  roomId: string
  name: string
  ended: boolean
  /** The person left or was removed: no input, no indicator; events after the leave are hidden. */
  left: boolean
  transcript: TranscriptLine[]
  /** The members (active and invited), then Keith. */
  members: MemberRow[]
  /** The indicator row text, or undefined when there is nothing to show. */
  indicator: string | undefined
  /** The oldest confirmation this person must answer; undefined for everyone else. */
  confirmation: PendingConfirmation | undefined
  canSpeak: boolean
  canControl: boolean
}

export interface RoomViewInput {
  /** The room as `rooms.get` answers it: presence, indicator and the requests the caller may confirm are in it. */
  view: RoomView
  events: readonly RoomEvent[]
  /** The signed-in person (`auth.whoami().personId`). */
  me: string
  now?: number
}

/** The indicator row: `Keith is thinking…`, `Keith is answering Ana…`, `Duta is typing…`; idle has none. */
export function indicatorText(indicator: RoomIndicator | undefined): string | undefined {
  switch (indicator?.kind) {
    case 'thinking':
      return `${KEITH_NAME} is thinking${G.ellipsis}`
    case 'speaking':
      return `${KEITH_NAME} is answering${indicator.to === undefined ? '' : ` ${indicator.to}`}${G.ellipsis}`
    case 'listening':
      return `${indicator.who} is typing${G.ellipsis}`
    default:
      return undefined
  }
}

/**
 * The dot of a disclosed presence line (`<name> is <state>…`, the core's P27 line). The state word is the one after ` is `:
 * `busy` is busy; `active`, `available` and `idle` are online; anything else (`away`, `offline`, `not available`) is offline.
 * `not shared` is unshared. A line the rule does not read is offline.
 */
export function dotOfPresence(presence: string): PresenceDot {
  if (presence === ROOM_PRESENCE_NOT_SHARED) return 'unshared'
  const state = /\bis ([a-z ]+?)(?=[ ,.(]|$)/.exec(presence)?.[1]
  if (state === 'busy') return 'busy'
  if (state === 'active' || state === 'available' || state === 'idle') return 'online'
  return 'offline'
}

/** The question of a confirmation bar, in the words the person confirms. */
export function questionOf(request: RoomRequest, roomName: string): string {
  switch (request.kind) {
    case 'remove':
      return `Remove ${request.payload.target?.name ?? 'a member'} from the room?`
    case 'end':
      return `End the room "${roomName}"?`
    case 'post':
      return `Share this with ${roomName}?`
  }
}

/** The text a `post` request quotes under its question, cut at CONFIRM_TEXT_MAX; undefined for the other kinds. */
export function detailOf(request: RoomRequest): string | undefined {
  if (request.kind !== 'post') return undefined
  const text = request.payload.text ?? ''
  return text.length > CONFIRM_TEXT_MAX
    ? `"${text.slice(0, CONFIRM_TEXT_MAX - 1)}${G.ellipsis}"`
    : `"${text}"`
}

/**
 * The room view of one person: the transcript they may read, the member list with presence dots, the indicator row, and the
 * oldest confirmation the server lists for them (`rooms.get` lists only what the caller may confirm: a request that names them,
 * and a remove or an end for the owner). An expired request is not shown. After the person's own leave (or removal) the
 * transcript stops at `leftAt` and there is no indicator.
 */
export function roomViewOf(input: RoomViewInput): RoomViewState {
  const { view, me } = input
  const now = input.now ?? Date.now()
  const own = view.members.find((m) => m.person.id === me)
  const left = own !== undefined && own.leftAt !== null
  const leftAt = own?.leftAt ?? null
  const ended = view.room.state === 'ended'
  const transcript = [...input.events]
    .filter((event) => leftAt === null || event.at <= leftAt)
    .sort((a, b) => a.seq - b.seq)
    .map(lineOf)
  const members: MemberRow[] = view.members
    .filter((m) => m.status === 'active' || m.status === 'invited')
    .map((m) => ({
      id: m.person.id,
      name: m.person.name,
      status: m.status === 'invited' ? 'invited' : 'active',
      dot: m.status === 'invited' ? 'offline' : dotOfPresence(m.presence),
    }))
  members.push({
    id: KEITH_ID,
    name: KEITH_NAME,
    status: 'active',
    dot: 'online',
  })
  const pending = view.pending
    .filter((r) => r.status === 'pending' && r.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  const confirmation =
    pending === undefined
      ? undefined
      : {
          id: pending.id,
          kind: pending.kind,
          question: questionOf(pending, view.room.name),
          detail: detailOf(pending),
        }
  return {
    roomId: view.room.id,
    name: view.room.name,
    ended,
    left,
    transcript,
    members,
    indicator: left || ended ? undefined : indicatorText(view.indicator),
    confirmation: left || ended ? undefined : confirmation,
    canSpeak: !left && !ended && view.you.canSpeak,
    canControl: !left && !ended && view.you.canControl,
  }
}
