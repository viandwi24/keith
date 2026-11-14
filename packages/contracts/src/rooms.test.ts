import { describe, expect, test } from 'bun:test'
import {
  RoomEventSchema,
  RoomFileSchema,
  RoomIdSchema,
  RoomIndicatorSchema,
  RoomInviteSchema,
  RoomMemberSchema,
  RoomRequestSchema,
  RoomSchema,
  RoomSettingsSetSchema,
  RoomsConfirmInputSchema,
  RoomsEventsInputSchema,
  RoomsFilesInputSchema,
  RoomsListOutputSchema,
  RoomsOkSchema,
  RoomsRemoveInputSchema,
  RoomsSayInputSchema,
  RoomsStartInputSchema,
  RoomViewSchema,
} from './rooms.ts'

const ROOM_ID = '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f'
const ANA = { id: 'ana', name: 'Ana' }
const KEITH = { id: 'keith', name: 'Keith' }

const room = {
  id: ROOM_ID,
  name: 'Planning',
  initiator: ANA,
  state: 'open',
  answerMode: 'addressed',
  windowMinutes: 30,
  windowEvents: 200,
  transport: 'text',
  createdAt: 1_800_000_000_000,
  startedAt: null,
  endedAt: null,
  endedBy: null,
  endReason: null,
}

describe('room shapes', () => {
  test('a room parses; the state is open, active or ended, the transport is text', () => {
    expect(RoomSchema.safeParse(room).success).toBe(true)
    expect(RoomSchema.safeParse({ ...room, state: 'closed' }).success).toBe(false)
    expect(RoomSchema.safeParse({ ...room, transport: 'audio' }).success).toBe(false)
  })

  test('the name is 1 to 60 characters after trimming', () => {
    expect(RoomSchema.safeParse({ ...room, name: 'a'.repeat(60) }).success).toBe(true)
    expect(RoomSchema.safeParse({ ...room, name: 'a'.repeat(61) }).success).toBe(false)
    expect(RoomsStartInputSchema.safeParse({ name: '   ', invite: ['ana'] }).success).toBe(false)
  })

  test('the window is bounded: 1 to 240 minutes, 10 to 1000 events', () => {
    expect(RoomSchema.safeParse({ ...room, windowMinutes: 0 }).success).toBe(false)
    expect(RoomSchema.safeParse({ ...room, windowMinutes: 241 }).success).toBe(false)
    expect(RoomSchema.safeParse({ ...room, windowEvents: 9 }).success).toBe(false)
    expect(RoomSchema.safeParse({ ...room, windowEvents: 1001 }).success).toBe(false)
  })

  test('a room id must be a uuid', () => {
    expect(RoomIdSchema.safeParse(ROOM_ID).success).toBe(true)
    expect(RoomIdSchema.safeParse('room-1').success).toBe(false)
  })

  test('a member has a status from the closed set; an invitation is not a member', () => {
    const member = {
      person: ANA,
      status: 'invited',
      invitedBy: ANA,
      invitedAt: 1_800_000_000_000,
      joinedAt: null,
      leftAt: null,
      leaveReason: null,
    }
    expect(RoomMemberSchema.safeParse(member).success).toBe(true)
    expect(RoomMemberSchema.safeParse({ ...member, status: 'left-for-good' }).success).toBe(false)
    expect(RoomMemberSchema.safeParse({ ...member, status: 'expired' }).success).toBe(true)
  })

  test('an event carries text up to 2000 characters, a speaker or null, and no data field', () => {
    const event = { seq: 1, at: 1_800_000_000_000, kind: 'say', speaker: ANA, text: 'hi' }
    expect(RoomEventSchema.safeParse(event).success).toBe(true)
    expect(RoomEventSchema.safeParse({ ...event, speaker: null, kind: 'system' }).success).toBe(
      true,
    )
    expect(RoomEventSchema.safeParse({ ...event, text: 'a'.repeat(2001) }).success).toBe(false)
    expect(RoomEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false)
    const stripped = RoomEventSchema.parse({ ...event, data: { queued: true } }) as Record<
      string,
      unknown
    >
    expect('data' in stripped).toBe(false)
    expect(RoomEventSchema.safeParse({ ...event, kind: 'shout' }).success).toBe(false)
    expect(RoomEventSchema.safeParse({ ...event, speaker: KEITH }).success).toBe(true)
  })

  test('an invitation and a pending request parse; a request payload holds a target or text', () => {
    expect(
      RoomInviteSchema.safeParse({
        roomId: ROOM_ID,
        roomName: 'Planning',
        initiator: ANA,
        invitedAt: 1,
        expiresAt: 2,
      }).success,
    ).toBe(true)
    const request = {
      id: 'req-1',
      roomId: ROOM_ID,
      kind: 'remove',
      status: 'pending',
      person: ANA.id,
      payload: { target: { id: 'duta', name: 'Duta' } },
      createdAt: 1,
      expiresAt: 600_001,
    }
    expect(RoomRequestSchema.safeParse(request).success).toBe(true)
    expect(RoomRequestSchema.safeParse({ ...request, kind: 'shutdown' }).success).toBe(false)
    expect(
      RoomRequestSchema.safeParse({ ...request, kind: 'post', payload: { text: 'a'.repeat(2001) } })
        .success,
    ).toBe(false)
  })

  test('a room view holds the caller rights and no other rooms', () => {
    const view = {
      room,
      members: [],
      indicator: { kind: 'idle' },
      you: { status: 'active', isInitiator: true, canSpeak: true, canControl: true },
      pending: [],
    }
    expect(RoomViewSchema.safeParse(view).success).toBe(true)
    expect(
      RoomViewSchema.safeParse({ ...view, you: { ...view.you, status: 'banned' } }).success,
    ).toBe(false)
    expect(RoomViewSchema.safeParse({ ...view, indicator: undefined }).success).toBe(false)
    expect(
      RoomsListOutputSchema.safeParse({ rooms: [{ room, members: [], inviteExpiresAt: null }] })
        .success,
    ).toBe(true)
    expect(RoomsListOutputSchema.safeParse({ rooms: [{ room, members: [] }] }).success).toBe(false)
  })
})

describe('indicator (RoomTransport, ADR-0026 §6)', () => {
  test('the four indicator states parse; an unknown kind does not', () => {
    expect(RoomIndicatorSchema.safeParse({ kind: 'idle' }).success).toBe(true)
    expect(RoomIndicatorSchema.safeParse({ kind: 'thinking' }).success).toBe(true)
    expect(RoomIndicatorSchema.safeParse({ kind: 'speaking', to: 'Duta' }).success).toBe(true)
    expect(RoomIndicatorSchema.safeParse({ kind: 'speaking' }).success).toBe(true)
    expect(RoomIndicatorSchema.safeParse({ kind: 'listening', who: 'Ana' }).success).toBe(true)
    expect(RoomIndicatorSchema.safeParse({ kind: 'listening' }).success).toBe(false)
    expect(RoomIndicatorSchema.safeParse({ kind: 'typing' }).success).toBe(false)
  })
})

describe('RPC inputs', () => {
  test('rooms.start takes 1 to 16 invitees and an optional name', () => {
    expect(RoomsStartInputSchema.safeParse({ invite: ['ana'] }).success).toBe(true)
    expect(RoomsStartInputSchema.safeParse({ invite: [] }).success).toBe(false)
    expect(
      RoomsStartInputSchema.safeParse({
        invite: Array.from({ length: 17 }, (_, i) => `p${i}`),
      }).success,
    ).toBe(false)
  })

  test('rooms.say trims the text, rejects an empty or long one, and takes the reply flag', () => {
    expect(RoomsSayInputSchema.parse({ roomId: ROOM_ID, text: '  hi  ' }).text).toBe('hi')
    expect(RoomsSayInputSchema.safeParse({ roomId: ROOM_ID, text: '   ' }).success).toBe(false)
    expect(RoomsSayInputSchema.safeParse({ roomId: ROOM_ID, text: 'a'.repeat(2001) }).success).toBe(
      false,
    )
    expect(
      RoomsSayInputSchema.safeParse({ roomId: ROOM_ID, text: 'hi', replyToKeith: true }).success,
    ).toBe(true)
  })

  test('a remove names one person; a crafted extra field is stripped, not trusted', () => {
    const parsed = RoomsRemoveInputSchema.parse({
      roomId: ROOM_ID,
      person: 'duta',
      as: 'owner',
    }) as Record<string, unknown>
    expect(parsed).toEqual({ roomId: ROOM_ID, person: 'duta' })
  })

  test('confirm needs the request id and the person decision as a boolean', () => {
    expect(RoomsConfirmInputSchema.safeParse({ requestId: 'r1', approved: true }).success).toBe(
      true,
    )
    expect(RoomsConfirmInputSchema.safeParse({ requestId: 'r1' }).success).toBe(false)
  })

  test('events paging: after is a seq of at least 0, limit is 1 to 200', () => {
    expect(RoomsEventsInputSchema.safeParse({ roomId: ROOM_ID, after: 0 }).success).toBe(true)
    expect(RoomsEventsInputSchema.safeParse({ roomId: ROOM_ID, after: -1 }).success).toBe(false)
    expect(RoomsEventsInputSchema.safeParse({ roomId: ROOM_ID, limit: 201 }).success).toBe(false)
  })

  test('a files path is relative and has no ".." segment', () => {
    expect(RoomsFilesInputSchema.safeParse({ roomId: ROOM_ID }).success).toBe(true)
    expect(RoomsFilesInputSchema.safeParse({ roomId: ROOM_ID, path: 'notes/a.md' }).success).toBe(
      true,
    )
    expect(RoomsFilesInputSchema.safeParse({ roomId: ROOM_ID, path: '../keith' }).success).toBe(
      false,
    )
    expect(RoomsFilesInputSchema.safeParse({ roomId: ROOM_ID, path: '/etc' }).success).toBe(false)
    expect(
      RoomFileSchema.safeParse({ name: 'a.md', path: 'a.md', dir: false, size: 3 }).success,
    ).toBe(true)
  })

  test('the ok answer is the literal true', () => {
    expect(RoomsOkSchema.safeParse({ ok: true }).success).toBe(true)
    expect(RoomsOkSchema.safeParse({ ok: false }).success).toBe(false)
  })
})

describe('rooms.settings.set input', () => {
  test('takes any subset of the six settings within bounds, and refuses an empty change', () => {
    expect(RoomSettingsSetSchema.safeParse({ maxMembers: 4 }).success).toBe(true)
    expect(RoomSettingsSetSchema.safeParse({ windowEvents: 10, maxQueue: 50 }).success).toBe(true)
    expect(RoomSettingsSetSchema.safeParse({}).success).toBe(false)
    expect(RoomSettingsSetSchema.safeParse({ maxMembers: 1 }).success).toBe(false)
    expect(RoomSettingsSetSchema.safeParse({ maxTurnsPerHour: 601 }).success).toBe(false)
  })
})
