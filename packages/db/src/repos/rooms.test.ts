import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { REQUEST_TTL_MS, roomsRepo } from './rooms.ts'

// The shared-room repo (docs/specs/corpus-callosum.md, "Data model"): one active room per person, the status machine of
// members, the window of a room, the transcript a member may read (from the latest `joined_at`, cut at `left_at`), the expiry of requests and the end.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const NEW = (id: string, initiator: string) => ({
  id,
  name: `Room ${id}`,
  initiator,
  answerMode: 'addressed' as const,
  windowMinutes: 30,
  windowEvents: 200,
})

const MINUTE = 60_000

describe('roomsRepo: one active room per person', () => {
  test('a person who is active in a room cannot start or join another one', () => {
    const sqlite = db()
    const repo = roomsRepo(sqlite)
    expect(repo.create(NEW('a', 'ana'), 1_000).status).toBe('created')
    expect(repo.create(NEW('b', 'ana'), 1_000)).toEqual({ status: 'busy' })
    expect(repo.get('b')).toBeUndefined()

    // Bob starts room c, so he is active there; an invitation to room a cannot be accepted while he is
    repo.create(NEW('c', 'bob'), 1_000)
    expect(repo.invite('c', 'bob', 'bob', 1_100)).toBe('exists')
    expect(repo.invite('a', 'bob', 'ana', 1_100)).toBe('invited')
    expect(repo.accept('a', 'bob', 1_200)).toBe('busy')
    expect(repo.member('a', 'bob')?.status).toBe('invited')
    expect(repo.activeRoomOf('bob')?.id).toBe('c')

    // the database refuses a second active row as well, not only the repo
    repo.create(NEW('d', 'cy'), 1_000)
    expect(() =>
      sqlite.exec(
        `INSERT INTO room_members (room_id, person_id, status, invited_at, joined_at)
         VALUES ('d', 'bob', 'active', 1, 1)`,
      ),
    ).toThrow(/UNIQUE constraint failed/)
  })

  test('a person may join the next room once they left the first', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.create(NEW('b', 'cy'), 1_000)
    repo.invite('a', 'bob', 'ana', 1_100)
    repo.accept('a', 'bob', 1_200)
    expect(repo.leave('a', 'bob', 'left', 'self', 1_300)).toBe('moved')
    expect(repo.activeRoomOf('bob')).toBeUndefined()
    repo.invite('b', 'bob', 'ana', 1_400)
    expect(repo.accept('b', 'bob', 1_500)).toBe('moved')
    expect(repo.activeRoomOf('bob')?.id).toBe('b')
  })
})

describe('roomsRepo: members and the room state', () => {
  test('the status machine: invite, decline, invite again, accept, leave, refused after removal', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    expect(repo.get('a')).toMatchObject({ state: 'open', startedAt: null, transport: 'text' })

    expect(repo.invite('a', 'bob', 'ana', 1_100)).toBe('invited')
    expect(repo.accept('a', 'bob', 1_150)).toBe('moved')
    expect(repo.accept('a', 'bob', 1_160)).toBe('stale')
    expect(repo.get('a')).toMatchObject({ state: 'active', startedAt: 1_150 })

    expect(repo.invite('a', 'cy', 'ana', 1_200)).toBe('invited')
    expect(repo.decline('a', 'cy')).toBe('moved')
    expect(repo.decline('a', 'cy')).toBe('stale')
    expect(repo.invite('a', 'cy', 'ana', 1_300)).toBe('invited')
    expect(repo.accept('a', 'cy', 1_310)).toBe('moved')

    expect(repo.leave('a', 'cy', 'removed', 'removed-by-initiator', 1_400)).toBe('moved')
    expect(repo.member('a', 'cy')).toMatchObject({
      status: 'removed',
      leftAt: 1_400,
      leaveReason: 'removed-by-initiator',
    })
    expect(repo.invite('a', 'cy', 'ana', 1_500)).toBe('refused')
    expect(repo.leave('a', 'cy', 'left', 'self', 1_600)).toBe('stale')
    expect(repo.members('a').map((m) => m.personId)).toEqual(['ana', 'bob', 'cy'])
  })

  test('invitations past their time expire; a fresh one is kept', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.invite('a', 'bob', 'ana', 1_000)
    repo.invite('a', 'cy', 'ana', 5_000)
    expect(repo.expireInvites(2_000)).toBe(1)
    expect(repo.member('a', 'bob')?.status).toBe('expired')
    expect(repo.member('a', 'cy')?.status).toBe('invited')
  })

  test('ending a room moves its active members to left, expires invitations and pending requests', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.invite('a', 'bob', 'ana', 1_100)
    repo.accept('a', 'bob', 1_200)
    repo.invite('a', 'cy', 'ana', 1_300)
    repo.createRequest({
      id: 'q1',
      roomId: 'a',
      person: 'ana',
      kind: 'end',
      createdAt: 1_400,
      expiresAt: 1_400 + REQUEST_TTL_MS,
    })

    expect(repo.end('a', 'ana', 'by-owner', 2_000)).toBe('ended')
    expect(repo.end('a', 'ana', 'again', 2_100)).toBe('stale')
    expect(repo.get('a')).toMatchObject({
      state: 'ended',
      endedAt: 2_000,
      endedBy: 'ana',
      endReason: 'by-owner',
    })
    expect(repo.member('a', 'ana')).toMatchObject({
      status: 'left',
      leftAt: 2_000,
      leaveReason: 'ended',
    })
    expect(repo.member('a', 'bob')).toMatchObject({ status: 'left', leftAt: 2_000 })
    expect(repo.member('a', 'cy')?.status).toBe('expired')
    expect(repo.request('q1')?.status).toBe('expired')
    expect(repo.activeRoomOf('bob')).toBeUndefined()
    expect(repo.accept('a', 'cy', 2_200)).toBe('stale')
    expect(repo.invite('a', 'dan', 'ana', 2_300)).toBe('refused')
  })

  test('a new generation counts up and the list shows the newest room first', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.create(NEW('b', 'bob'), 2_000)
    expect(repo.bumpGeneration('a')).toBe(2)
    expect(repo.get('a')?.generation).toBe(2)
    expect(repo.bumpGeneration('missing')).toBeUndefined()
    expect(repo.list(10).map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('roomsRepo: the window', () => {
  test('returns the newest 200 events of the last 30 minutes, oldest first', () => {
    const sqlite = db()
    const repo = roomsRepo(sqlite)
    repo.create(NEW('a', 'ana'), 1_000)
    const now = 100 * MINUTE
    repo.appendEvent({
      roomId: 'a',
      at: now - 31 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'too old',
    })
    for (let i = 0; i < 250; i++) {
      repo.appendEvent({
        roomId: 'a',
        at: now - 20 * MINUTE + i,
        kind: 'say',
        speaker: 'ana',
        text: `m${i}`,
      })
    }
    const window = repo.window('a', now)
    expect(window).toHaveLength(200)
    expect(window[0]?.text).toBe('m50')
    expect(window.at(-1)?.text).toBe('m249')
    expect(window.every((e) => e.at >= now - 30 * MINUTE)).toBe(true)
  })

  test('an event exactly at the start of the window is kept, one older is not', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    const now = 100 * MINUTE
    repo.appendEvent({
      roomId: 'a',
      at: now - 30 * MINUTE - 1,
      kind: 'say',
      speaker: 'ana',
      text: 'older',
    })
    repo.appendEvent({
      roomId: 'a',
      at: now - 30 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'edge',
    })
    repo.appendEvent({ roomId: 'a', at: now, kind: 'say', speaker: 'ana', text: 'now' })
    expect(repo.window('a', now).map((e) => e.text)).toEqual(['edge', 'now'])
  })

  test('text over 2000 characters is refused', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    expect(() =>
      repo.appendEvent({ roomId: 'a', at: 1, kind: 'say', speaker: 'ana', text: 'x'.repeat(2001) }),
    ).toThrow(RangeError)
    expect(
      repo.appendEvent({ roomId: 'a', at: 1, kind: 'say', speaker: 'ana', text: 'x'.repeat(2000) }),
    ).toBeGreaterThan(0)
  })
})

describe('roomsRepo: what a member may read', () => {
  test('events after left_at are excluded for the member who left; the others still read them', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 100)
    repo.invite('a', 'bob', 'ana', 100)
    repo.accept('a', 'bob', 100)
    repo.appendEvent({ roomId: 'a', at: 150, kind: 'say', speaker: 'ana', text: 'before' })
    repo.appendEvent({ roomId: 'a', at: 160, kind: 'say', speaker: 'bob', text: 'bob before' })
    repo.appendEvent({ roomId: 'a', at: 200, kind: 'leave', speaker: 'bob', text: null })
    repo.leave('a', 'bob', 'left', 'self', 200)
    repo.appendEvent({ roomId: 'a', at: 200, kind: 'say', speaker: 'ana', text: 'same instant' })
    repo.appendEvent({ roomId: 'a', at: 300, kind: 'say', speaker: 'ana', text: 'after' })

    const bob = repo.eventsForMember('a', 'bob', 0, 100).map((e) => e.text ?? e.kind)
    expect(bob).toEqual(['before', 'bob before', 'leave'])
    expect(repo.eventsForMember('a', 'bob', 2, 100).map((e) => e.kind)).toEqual(['leave'])

    const ana = repo.eventsForMember('a', 'ana', 0, 100).map((e) => e.text ?? e.kind)
    expect(ana).toEqual(['before', 'bob before', 'leave', 'same instant', 'after'])
    expect(repo.eventsForOwner('a', 0, 100)).toHaveLength(5)
  })

  test('a removed member reads up to the removal, and nobody else reads the transcript', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.invite('a', 'bob', 'ana', 100)
    repo.accept('a', 'bob', 100)
    repo.appendEvent({ roomId: 'a', at: 150, kind: 'say', speaker: 'ana', text: 'kept' })
    repo.appendEvent({ roomId: 'a', at: 200, kind: 'remove', speaker: 'bob' })
    repo.leave('a', 'bob', 'removed', 'removed-by-initiator', 200)
    repo.appendEvent({ roomId: 'a', at: 400, kind: 'say', speaker: 'ana', text: 'secret' })
    expect(repo.eventsForMember('a', 'bob', 0, 100).map((e) => e.text)).toEqual(['kept', null])

    // a person never invited, and one still only invited, read nothing
    repo.invite('a', 'cy', 'ana', 300)
    expect(repo.eventsForMember('a', 'cy', 0, 100)).toEqual([])
    expect(repo.eventsForMember('a', 'dan', 0, 100)).toEqual([])
    expect(repo.eventsForMember('missing', 'ana', 0, 100)).toEqual([])
  })
})

describe('roomsRepo: a member reads from their latest join', () => {
  test('a first join does not show what was said before the acceptance', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 100)
    repo.invite('a', 'bob', 'ana', 100)
    repo.appendEvent({ roomId: 'a', at: 150, kind: 'say', speaker: 'ana', text: 'before accept' })
    repo.accept('a', 'bob', 200)
    repo.appendEvent({ roomId: 'a', at: 250, kind: 'say', speaker: 'ana', text: 'after accept' })

    expect(repo.eventsForMember('a', 'bob', 0, 100).map((e) => e.text)).toEqual(['after accept'])
    expect(repo.eventsForMember('a', 'ana', 0, 100).map((e) => e.text)).toEqual([
      'before accept',
      'after accept',
    ])
  })

  test('a rejoin shows only events from the latest join: nothing from the gap, nothing before the first leave', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 100)
    repo.invite('a', 'bob', 'ana', 100)
    repo.accept('a', 'bob', 100)
    repo.appendEvent({ roomId: 'a', at: 150, kind: 'say', speaker: 'ana', text: 'bob before' })
    repo.appendEvent({ roomId: 'a', at: 200, kind: 'leave', speaker: 'bob', text: null })
    repo.leave('a', 'bob', 'left', 'self', 200)
    repo.appendEvent({ roomId: 'a', at: 300, kind: 'say', speaker: 'ana', text: 'while away' })
    expect(repo.invite('a', 'bob', 'ana', 400)).toBe('invited')
    repo.appendEvent({ roomId: 'a', at: 450, kind: 'say', speaker: 'ana', text: 'invited only' })
    expect(repo.accept('a', 'bob', 500)).toBe('moved')
    repo.appendEvent({ roomId: 'a', at: 600, kind: 'say', speaker: 'ana', text: 'after rejoin' })

    // bob sees only what was written from the rejoin on; the initiator still sees the whole transcript
    expect(repo.eventsForMember('a', 'bob', 0, 100).map((e) => e.text)).toEqual(['after rejoin'])
    expect(repo.eventsForMember('a', 'ana', 0, 100).map((e) => e.text ?? e.kind)).toEqual([
      'bob before',
      'leave',
      'while away',
      'invited only',
      'after rejoin',
    ])

    // a second leave ends the read at that instant, as for a first join
    repo.appendEvent({ roomId: 'a', at: 700, kind: 'leave', speaker: 'bob', text: null })
    repo.leave('a', 'bob', 'left', 'self', 700)
    repo.appendEvent({ roomId: 'a', at: 800, kind: 'say', speaker: 'ana', text: 'after leave' })
    expect(repo.eventsForMember('a', 'bob', 0, 100).map((e) => e.text ?? e.kind)).toEqual([
      'after rejoin',
      'leave',
    ])
  })
})

describe('roomsRepo: requests', () => {
  test('a request expires after its time and cannot be confirmed then', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    const made = 10 * MINUTE
    repo.createRequest({
      id: 'r1',
      roomId: 'a',
      person: 'ana',
      kind: 'remove',
      payload: { member: 'bob' },
      createdAt: made,
      expiresAt: made + REQUEST_TTL_MS,
    })
    repo.createRequest({
      id: 'r2',
      roomId: 'a',
      person: 'ana',
      kind: 'end',
      createdAt: made,
      expiresAt: made + REQUEST_TTL_MS,
    })
    expect(repo.request('r1')?.payload).toEqual({ member: 'bob' })
    expect(repo.pendingRequests('ana', made + MINUTE).map((r) => r.id)).toEqual(['r1', 'r2'])

    expect(repo.decideRequest('r1', 'confirmed', made + MINUTE)).toBe('decided')
    expect(repo.request('r1')?.status).toBe('confirmed')
    expect(repo.decideRequest('r1', 'refused', made + MINUTE)).toBe('stale')

    // r2 is past its expiry at the moment of the answer: it is marked expired, nothing is applied
    expect(repo.decideRequest('r2', 'confirmed', made + REQUEST_TTL_MS)).toBe('expired')
    expect(repo.request('r2')?.status).toBe('expired')
    expect(repo.pendingRequests('ana', made + MINUTE)).toEqual([])
  })

  test('pendingInRoom lists the room pending requests of every person, oldest first, and no other room', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    repo.create(NEW('b', 'cy'), 1_000)
    repo.invite('a', 'bob', 'ana', 1_000)
    repo.accept('a', 'bob', 1_000)
    const made = 10 * MINUTE
    const row = (id: string, roomId: string, person: string, expiresAt = made + REQUEST_TTL_MS) =>
      repo.createRequest({ id, roomId, person, kind: 'end', createdAt: made, expiresAt })
    row('p1', 'a', 'ana')
    row('p2', 'a', 'bob')
    row('p3', 'b', 'cy')
    row('p4', 'a', 'ana', made + MINUTE)
    expect(repo.pendingInRoom('a', made + MINUTE).map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(repo.pendingInRoom('a', made + 2 * MINUTE).map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(repo.pendingInRoom('b', made + MINUTE).map((r) => r.id)).toEqual(['p3'])
    expect(repo.pendingInRoom('a', made + REQUEST_TTL_MS).map((r) => r.id)).toEqual([])
  })

  test('the sweep expires only pending requests past their time', () => {
    const repo = roomsRepo(db())
    repo.create(NEW('a', 'ana'), 1_000)
    for (const [id, expiresAt] of [
      ['early', 1_000],
      ['late', 9_000_000],
      ['done', 1_000],
    ] as const) {
      repo.createRequest({ id, roomId: 'a', person: 'ana', kind: 'post', createdAt: 1, expiresAt })
    }
    repo.decideRequest('done', 'refused', 500)
    expect(repo.expireRequests(2_000)).toBe(1)
    expect(repo.request('early')?.status).toBe('expired')
    expect(repo.request('late')?.status).toBe('pending')
    expect(repo.request('done')?.status).toBe('refused')
  })
})
