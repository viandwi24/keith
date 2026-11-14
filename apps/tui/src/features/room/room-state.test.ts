import { describe, expect, test } from 'bun:test'
import {
  ROOM_PRESENCE_NOT_SHARED,
  type Room,
  type RoomEvent,
  type RoomHeader,
  type RoomListItem,
  type RoomMember,
  type RoomRequest,
  type RoomView,
  type RoomViewMember,
} from '@keith/contracts'
import {
  bannerOf,
  detailOf,
  dotOfPresence,
  indicatorText,
  inviteNoticeOf,
  lineOf,
  questionOf,
  roomViewOf,
} from './room-state.ts'

const ROOM = '0190a6a0-0000-4000-8000-0000000000b1'
const ME = 'ana'
const NOW = 1_000_000
const ana = { id: 'ana', name: 'Ana' }
const duta = { id: 'duta', name: 'Duta' }
const keith = { id: 'keith', name: 'Keith' }

function room(over: Partial<Room> = {}): Room {
  return {
    id: ROOM,
    name: 'Planning',
    initiator: ana,
    state: 'active',
    answerMode: 'addressed',
    windowMinutes: 30,
    windowEvents: 200,
    transport: 'text',
    createdAt: 1,
    startedAt: 2,
    endedAt: null,
    endedBy: null,
    endReason: null,
    ...over,
  }
}

function member(
  person: { id: string; name: string },
  status: RoomMember['status'],
  over: Partial<RoomMember> = {},
): RoomMember {
  return {
    person,
    status,
    invitedBy: ana,
    invitedAt: NOW - 60_000,
    joinedAt: status === 'active' ? NOW - 50_000 : null,
    leftAt: null,
    leaveReason: null,
    ...over,
  }
}

function header(roomOver: Partial<Room>, members: RoomMember[]): RoomHeader {
  return { room: room(roomOver), members }
}

/** A `rooms.get` answer: members carry their disclosed presence line (`not shared` when none is given). */
type ViewOver = Partial<Omit<RoomView, 'members'>> & {
  members?: Array<RoomMember & { presence?: string }>
}

function view(over: ViewOver = {}, roomOver: Partial<Room> = {}): RoomView {
  const members = (over.members ?? [member(ana, 'active'), member(duta, 'active')]).map(
    (m): RoomViewMember => ({
      ...m,
      presence: (m as { presence?: string }).presence ?? ROOM_PRESENCE_NOT_SHARED,
    }),
  )
  return {
    room: room(roomOver),
    indicator: { kind: 'idle' },
    you: { status: 'active', isInitiator: true, canSpeak: true, canControl: true },
    pending: [],
    ...over,
    members,
  }
}

/** A `rooms.list` item: the header and the caller's invitation expiry (`invitedAt` plus ten minutes, the default setting). */
function listed(roomOver: Partial<Room>, members: RoomMember[]): RoomListItem {
  const invited = members.find((m) => m.person.id === ME && m.status === 'invited')
  return {
    ...header(roomOver, members),
    inviteExpiresAt: invited === undefined ? null : invited.invitedAt + 10 * 60_000,
  }
}

function event(seq: number, over: Partial<RoomEvent> = {}): RoomEvent {
  return {
    seq,
    at: NOW - 10_000 + seq,
    kind: 'say',
    speaker: ana,
    text: `line ${seq}`,
    ...over,
  }
}

function request(over: Partial<RoomRequest> = {}): RoomRequest {
  return {
    id: 'r1',
    roomId: ROOM,
    kind: 'remove',
    status: 'pending',
    person: ME,
    payload: { target: duta },
    createdAt: NOW - 1000,
    expiresAt: NOW + 600_000,
    ...over,
  }
}

describe('banner', () => {
  test('an active room names its active members and Keith, accent', () => {
    const banner = bannerOf(
      [
        header({}, [
          member(ana, 'active'),
          member(duta, 'active'),
          member({ id: 'bo', name: 'Bo' }, 'invited'),
        ]),
      ],
      ME,
    )
    expect(banner).toEqual({
      roomId: ROOM,
      tone: 'accent',
      text: '● Room "Planning" · Ana, Duta, Keith · /room',
    })
  })

  test('invitations out: an open room the person started reads muted, waiting for the invitees', () => {
    const banner = bannerOf(
      [header({ state: 'open' }, [member(ana, 'active'), member(duta, 'invited')])],
      ME,
    )
    expect(banner).toEqual({
      roomId: ROOM,
      tone: 'muted',
      text: '○ Room "Planning" · waiting for Duta · /room',
    })
  })

  test('an active room wins over invitations out; an ended room and an invited-only person show nothing', () => {
    const active = header({}, [member(ana, 'active'), member(duta, 'active')])
    const open = header({ state: 'open', name: 'Later' }, [
      member(ana, 'active'),
      member(duta, 'invited'),
    ])
    expect(bannerOf([open, active], ME)?.tone).toBe('accent')
    expect(bannerOf([header({ state: 'ended' }, [member(ana, 'active')])], ME)).toBeUndefined()
    expect(bannerOf([header({}, [member(ana, 'invited')])], ME)).toBeUndefined()
    expect(bannerOf([], ME)).toBeUndefined()
  })
})

describe('invitation notice', () => {
  test('the oldest open invitation is the notice; the others count', () => {
    const newer = listed(
      { id: '0190a6a0-0000-4000-8000-0000000000c2', name: 'Second', initiator: duta },
      [member(ana, 'invited', { invitedAt: NOW - 5_000 })],
    )
    const older = listed({}, [member(ana, 'invited', { invitedAt: NOW - 30_000 })])
    const notice = inviteNoticeOf([newer, older], ME, NOW)
    expect(notice?.invite.roomId).toBe(ROOM)
    expect(notice?.more).toBe(1)
    expect(notice?.text).toBe('Ana invites you to a room with Keith.')
  })

  test('an expired invitation, an ended room and an answered one are not offered', () => {
    const expired = listed({}, [member(ana, 'invited', { invitedAt: NOW - 11 * 60_000 })])
    const ended = listed({ state: 'ended' }, [member(ana, 'invited')])
    const answered = listed({}, [member(ana, 'active')])
    expect(inviteNoticeOf([expired, ended, answered], ME, NOW)).toBeUndefined()
  })

  test('the expiry is the server’s inviteExpiresAt (rooms.inviteTtlMinutes), not a default', () => {
    const h = listed({}, [member(ana, 'invited', { invitedAt: NOW - 20 * 60_000 })])
    // a room setting of 30 minutes: the invitation from 20 minutes ago is still open, until its own expiry
    const longer: RoomListItem = { ...h, inviteExpiresAt: NOW - 20 * 60_000 + 30 * 60_000 }
    expect(inviteNoticeOf([longer], ME, NOW)?.invite.expiresAt).toBe(NOW + 10 * 60_000)
    // a setting that already passed: not offered, whatever the default would say
    const shorter: RoomListItem = { ...h, inviteExpiresAt: NOW - 1 }
    expect(inviteNoticeOf([shorter], ME, NOW)).toBeUndefined()
    // a list item with no expiry is not an invitation the notice may offer
    expect(inviteNoticeOf([{ ...h, inviteExpiresAt: null }], ME, NOW)).toBeUndefined()
  })
})

describe('indicator', () => {
  test('thinking, answering (with and without a target), listening, idle', () => {
    expect(indicatorText({ kind: 'thinking' })).toBe('Keith is thinking…')
    expect(indicatorText({ kind: 'speaking' })).toBe('Keith is answering…')
    expect(indicatorText({ kind: 'speaking', to: 'Ana' })).toBe('Keith is answering Ana…')
    expect(indicatorText({ kind: 'listening', who: 'Duta' })).toBe('Duta is typing…')
    expect(indicatorText({ kind: 'idle' })).toBeUndefined()
    expect(indicatorText(undefined)).toBeUndefined()
  })

  test('the room view carries the indicator from rooms.get; none after the person left or the room ended', () => {
    const base = { events: [], me: ME, now: NOW }
    expect(roomViewOf({ ...base, view: view({ indicator: { kind: 'thinking' } }) }).indicator).toBe(
      'Keith is thinking…',
    )
    expect(roomViewOf({ ...base, view: view() }).indicator).toBeUndefined()
    const ended = view({ indicator: { kind: 'thinking' } }, { state: 'ended' })
    expect(roomViewOf({ ...base, view: ended }).indicator).toBeUndefined()
    const leftView = view({
      indicator: { kind: 'thinking' },
      members: [member(ana, 'left', { leftAt: NOW - 5000 }), member(duta, 'active')],
      you: { status: 'left', isInitiator: true, canSpeak: false, canControl: false },
    })
    expect(roomViewOf({ ...base, view: leftView }).indicator).toBeUndefined()
  })
})

describe('room view', () => {
  test('members: active with a presence dot from the line, invited muted, then Keith; unshared when none is released', () => {
    const state = roomViewOf({
      view: view({
        members: [
          { ...member(ana, 'active'), presence: 'ana is active.' },
          { ...member(duta, 'active'), presence: 'duta is busy, until 2026-11-11T02:00:00.000Z.' },
          member({ id: 'bo', name: 'Bo' }, 'invited'),
        ],
      }),
      events: [],
      me: ME,
      now: NOW,
    })
    expect(state.members).toEqual([
      { id: 'ana', name: 'Ana', status: 'active', dot: 'online' },
      { id: 'duta', name: 'Duta', status: 'active', dot: 'busy' },
      { id: 'bo', name: 'Bo', status: 'invited', dot: 'offline' },
      { id: 'keith', name: 'Keith', status: 'active', dot: 'online' },
    ])
    const unshared = roomViewOf({ view: view(), events: [], me: ME, now: NOW })
    expect(unshared.members.find((m) => m.id === 'duta')?.dot).toBe('unshared')
    expect(unshared.members.find((m) => m.id === 'ana')?.dot).toBe('unshared')
  })

  test('the dot reads the state word of the disclosed line', () => {
    expect(dotOfPresence('ana is available.')).toBe('online')
    expect(dotOfPresence('ana is active (on a call).')).toBe('online')
    expect(dotOfPresence('ana is idle.')).toBe('online')
    expect(dotOfPresence('ana is busy.')).toBe('busy')
    expect(dotOfPresence('ana is not available.')).toBe('offline')
    expect(dotOfPresence('ana is away.')).toBe('offline')
    expect(dotOfPresence('ana is offline.')).toBe('offline')
    expect(dotOfPresence('ana is something new.')).toBe('offline')
    expect(dotOfPresence(ROOM_PRESENCE_NOT_SHARED)).toBe('unshared')
  })

  test('a transcript line per event, Keith marked, a handoff without text, membership named', () => {
    const lines = [
      event(1),
      event(2, { speaker: keith, kind: 'keith', text: 'Hello both' }),
      event(3, { kind: 'handoff', text: null, speaker: duta }),
      event(4, { kind: 'join', speaker: duta, text: null }),
      event(5, { kind: 'system', speaker: null, text: 'Room opened' }),
    ].map(lineOf)
    expect(lines.map((l) => [l.seq, l.speaker, l.keith, l.body])).toEqual([
      [1, 'Ana', false, 'line 1'],
      [2, 'Keith', true, 'Hello both'],
      [3, 'Duta', false, 'Duta asked in their own chat'],
      [4, 'Duta', false, 'Duta joined'],
      [5, undefined, false, 'Room opened'],
    ])
  })

  test("the transcript hides events after the person's leave, and the input is off", () => {
    const left = view({
      members: [member(ana, 'left', { leftAt: NOW - 5_000 }), member(duta, 'active')],
      you: { status: 'left', isInitiator: true, canSpeak: false, canControl: false },
    })
    const events = [
      event(1, { at: NOW - 9_000 }),
      event(2, { at: NOW - 5_000 }),
      event(3, { at: NOW - 4_000 }),
    ]
    const state = roomViewOf({ view: left, events, me: ME, now: NOW })
    expect(state.left).toBe(true)
    expect(state.transcript.map((l) => l.seq)).toEqual([1, 2])
    expect(state.canSpeak).toBe(false)
    expect(state.canControl).toBe(false)
  })

  test('the transcript is sorted by seq and shows everything for a member still in the room', () => {
    const state = roomViewOf({
      view: view(),
      events: [event(3), event(1), event(2)],
      me: ME,
      now: NOW,
    })
    expect(state.left).toBe(false)
    expect(state.transcript.map((l) => l.seq)).toEqual([1, 2, 3])
    expect(state.canSpeak).toBe(true)
  })

  test('an ended room cannot be spoken to or controlled', () => {
    const state = roomViewOf({ view: view({}, { state: 'ended' }), events: [], me: ME, now: NOW })
    expect(state.ended).toBe(true)
    expect(state.canSpeak).toBe(false)
    expect(state.canControl).toBe(false)
  })
})

describe('confirmation', () => {
  test('the bar shows what rooms.get lists for the caller: a request that names them', () => {
    const pending = view({ pending: [request()] })
    const confirmer = roomViewOf({ view: pending, events: [], me: ME, now: NOW })
    expect(confirmer.confirmation).toEqual({
      id: 'r1',
      kind: 'remove',
      question: 'Remove Duta from the room?',
      detail: undefined,
    })
    expect(roomViewOf({ view: view(), events: [], me: ME, now: NOW }).confirmation).toBeUndefined()
  })

  test('the owner, not named, gets the bar for a remove the server lists for them', () => {
    const listed = view({ pending: [request({ person: 'duta' })] })
    const state = roomViewOf({ view: listed, events: [], me: 'owner', now: NOW })
    expect(state.confirmation).toMatchObject({ id: 'r1', kind: 'remove' })
  })

  test('an expired, answered or ended-room request is not shown', () => {
    const expired = view({ pending: [request({ expiresAt: NOW - 1 })] })
    const answered = view({ pending: [request({ status: 'confirmed' })] })
    expect(roomViewOf({ view: expired, events: [], me: ME, now: NOW }).confirmation).toBeUndefined()
    expect(
      roomViewOf({ view: answered, events: [], me: ME, now: NOW }).confirmation,
    ).toBeUndefined()
    const ended = view({ pending: [request()] }, { state: 'ended' })
    expect(roomViewOf({ view: ended, events: [], me: ME, now: NOW }).confirmation).toBeUndefined()
  })

  test('the oldest of several requests comes first', () => {
    const state = roomViewOf({
      view: view({
        pending: [
          request({ id: 'new', createdAt: NOW - 1 }),
          request({ id: 'old', createdAt: NOW - 500 }),
        ],
      }),
      events: [],
      me: ME,
      now: NOW,
    })
    expect(state.confirmation?.id).toBe('old')
  })

  test('questions of end and post; the post text is quoted under it and cut', () => {
    expect(questionOf(request({ kind: 'end', payload: {} }), 'Planning')).toBe(
      'End the room "Planning"?',
    )
    const post = request({ kind: 'post', payload: { text: 'x'.repeat(120) } })
    expect(questionOf(post, 'Planning')).toBe('Share this with Planning?')
    const detail = detailOf(post) ?? ''
    expect(detail.startsWith('"xxx')).toBe(true)
    expect(detail.length).toBeLessThan(90)
    expect(detail.endsWith('…"')).toBe(true)
    expect(detailOf(request({ kind: 'end', payload: {} }))).toBeUndefined()
  })
})
