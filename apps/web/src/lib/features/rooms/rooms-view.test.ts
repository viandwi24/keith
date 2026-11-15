import { describe, expect, test } from 'bun:test'
import type { RoomListItem } from '@keith/contracts'
import {
  expiryText,
  inviteesOf,
  matchesFilter,
  pendingInvitesOf,
  roomRowsOf,
  standingOf,
} from './rooms-view.ts'

const NOW = 1_000_000
const id = (n: number): string => `0190a6a0-0000-4000-8000-00000000000${n}`

const item = (
  n: number,
  over: {
    state?: 'open' | 'active' | 'ended'
    me?: 'invited' | 'active' | 'left'
    expires?: number | null
    startedAt?: number | null
  } = {},
): RoomListItem => {
  const me = over.me ?? 'active'
  return {
    room: {
      id: id(n),
      name: `Room ${n}`,
      initiator: { id: 'duta', name: 'Duta' },
      state: over.state ?? 'active',
      answerMode: 'addressed',
      windowMinutes: 30,
      windowEvents: 20,
      transport: 'text',
      createdAt: n * 10,
      startedAt: over.startedAt ?? null,
      endedAt: null,
      endedBy: null,
      endReason: null,
    },
    members: [
      {
        person: { id: 'duta', name: 'Duta' },
        status: 'active',
        invitedBy: null,
        invitedAt: 0,
        joinedAt: 0,
        leftAt: null,
        leaveReason: null,
      },
      {
        person: { id: 'ana', name: 'Ana' },
        status: me,
        invitedBy: null,
        invitedAt: n,
        joinedAt: null,
        leftAt: null,
        leaveReason: null,
      },
    ],
    inviteExpiresAt: over.expires ?? null,
  } as RoomListItem
}

describe('standing', () => {
  test('what a room is to the person', () => {
    expect(standingOf(item(1), 'ana')).toBe('active')
    expect(standingOf(item(1, { state: 'open' }), 'ana')).toBe('waiting')
    expect(standingOf(item(1, { me: 'invited' }), 'ana')).toBe('invited')
    expect(standingOf(item(1, { me: 'left' }), 'ana')).toBe('left')
    expect(standingOf(item(1, { state: 'ended' }), 'ana')).toBe('ended')
  })
})

describe('rows', () => {
  test('newest first; members name the invited ones and end with Keith', () => {
    const rows = roomRowsOf(
      [item(1), item(2, { me: 'invited', expires: NOW + 5 * 60_000 })],
      'ana',
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual([id(2), id(1)])
    expect(rows[0]).toMatchObject({
      standing: 'invited',
      members: 'Duta, Ana (invited), Keith',
      expires: 'expires in 5 min',
    })
    expect(rows[1]?.expires).toBeUndefined()
  })
  test('filters group the standings', () => {
    expect(matchesFilter({ standing: 'waiting' }, 'active')).toBe(true)
    expect(matchesFilter({ standing: 'left' }, 'ended')).toBe(true)
    expect(matchesFilter({ standing: 'invited' }, 'active')).toBe(false)
    expect(matchesFilter({ standing: 'invited' }, 'all')).toBe(true)
  })
  test('expiry words', () => {
    expect(expiryText(NOW - 1, NOW)).toBe('expired')
    expect(expiryText(NOW + 125 * 60_000, NOW)).toBe('expires in 3 h')
  })
})

describe('invitations', () => {
  test('only open ones: invited, not ended, not expired, oldest first', () => {
    const headers = [
      item(3, { me: 'invited', expires: NOW + 1000 }),
      item(1, { me: 'invited', expires: NOW + 1000 }),
      item(2, { me: 'invited', expires: NOW - 1 }),
      item(4, { me: 'invited', expires: NOW + 1000, state: 'ended' }),
      item(5, { me: 'invited', expires: null }),
      item(6),
    ]
    expect(pendingInvitesOf(headers, 'ana', NOW).map((i) => i.roomId)).toEqual([id(1), id(3)])
  })
})

describe('invitees', () => {
  test('split on spaces and commas, drop @ and duplicates', () => {
    expect(inviteesOf('ana, @duta  ana')).toEqual(['ana', 'duta'])
    expect(inviteesOf('  ')).toEqual([])
  })
})
