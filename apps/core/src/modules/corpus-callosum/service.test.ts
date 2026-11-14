import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsRepo } from '@keith/db'
import { as, member, refusal, roomWorld } from './fixtures.ts'
import { RoomError, roomSessionId } from './service.ts'
import { createRoomSettings } from './settings.ts'
import { isRoomWorkspaceSealed, roomWorkspaceDir } from './workspace.ts'

// The room service (docs/specs/corpus-callosum.md "Control and limits", "Audit", P30.2.1 and P30.2.4): every transition, every
// refusal, real SQLite, real ACL and room repo. Delivery, feed, audit and activity are fakes that record their calls.

const MINUTE = 60_000

let dataDir = ''
let w: ReturnType<typeof roomWorld>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-rooms-'))
  w = roomWorld(dataDir)
})
afterAll(() => {
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
})

/** A room started by Ana with the given invitees; returns its id. */
async function startRoom(by = 'ana', invite: string[] = ['bob']): Promise<string> {
  const started = await w.svc.start(as(by), { invite })
  return started.room.id
}

/** The room's transcript as the repo holds it (every row, the owner's view of the table). */
const transcript = (roomId: string) => w.rooms.eventsForOwner(roomId, 0, 1000)

const kinds = (roomId: string) => transcript(roomId).map((e) => e.kind)

describe('start', () => {
  test('creates an open room with the initiator active, the ACL row, the folder and one invitation each', async () => {
    const started = await w.svc.start(as('ana'), { invite: ['bob', 'cy'] })
    const roomId = started.room.id
    expect(started.room.state).toBe('open')
    expect(started.room.initiator).toBe('ana')
    expect(started.room.name).toBe('Room of Ana')
    expect(started.room.generation).toBe(1)
    expect(started.invites).toEqual([
      { person: 'bob', status: 'invited' },
      { person: 'cy', status: 'invited' },
    ])
    const members = w.rooms.members(roomId)
    expect(members.find((m) => m.personId === 'ana')?.status).toBe('active')
    expect(members.find((m) => m.personId === 'bob')?.status).toBe('invited')
    expect(members.find((m) => m.personId === 'bob')?.invitedBy).toBe('ana')
    expect(w.roomAcl.canRead(member('ana'), roomId)).toBe(true)
    expect(existsSync(roomWorkspaceDir(dataDir, roomId))).toBe(true)
    expect(isRoomWorkspaceSealed(dataDir, roomId)).toBe(false)
    expect(w.audit.map((a) => a.kind)).toEqual(['room.create', 'room.invite', 'room.invite'])
    expect(w.audit[0]?.detail).toEqual({ roomId, subject: 'ana', invitees: 2 })
    expect(w.audit[1]?.detail).toEqual({ roomId, subject: 'bob' })
    expect(w.audit[1]?.actor).toBe('ana')
  })

  test('sends each invitation once through the delivery service, with the fixed text in note mode', async () => {
    const roomId = await startRoom('ana', ['bob'])
    expect(w.delivered).toHaveLength(1)
    expect(w.delivered[0]?.to).toBe('bob')
    expect(w.delivered[0]?.text).toBe('Ana invites you to a room with Keith.')
    expect(w.delivered[0]?.mode).toBe('note')
    expect(w.delivered[0]?.id.startsWith(`room-invite:${roomId}:bob:`)).toBe(true)
  })

  test('a person without rooms.start is refused (FORBIDDEN, no-capability)', async () => {
    const error = await refusal(() => w.svc.start(as('dee'), { invite: ['bob'] }))
    expect(error).toBeInstanceOf(RoomError)
    expect(error).toMatchObject({ code: 'FORBIDDEN', reason: 'no-capability' })
    expect(w.rooms.get('x')).toBeUndefined()
  })

  test('an initiator already active in a room gets CONFLICT and no second room', async () => {
    await startRoom('ana', ['bob'])
    const error = await refusal(() => w.svc.start(as('ana'), { invite: ['cy'] }))
    expect(error).toMatchObject({ code: 'CONFLICT' })
    expect(w.sqlite.query('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 1 })
  })

  test('a suspended invitee is refused, an unknown one is NOT_FOUND, and nothing is written', async () => {
    const suspended = await refusal(() => w.svc.start(as('ana'), { invite: ['sus'] }))
    expect(suspended).toMatchObject({ code: 'PRECONDITION_FAILED' })
    const unknown = await refusal(() => w.svc.start(as('ana'), { invite: ['nobody'] }))
    expect(unknown).toMatchObject({ code: 'NOT_FOUND' })
    expect(w.sqlite.query('SELECT COUNT(*) AS n FROM rooms').get()).toEqual({ n: 0 })
  })

  test('the initiator cannot invite themselves', async () => {
    const error = await refusal(() => w.svc.start(as('ana'), { invite: ['ana'] }))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  test('more invitees than rooms.maxMembers is refused', async () => {
    w.sqlite
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('rooms.maxMembers', '2', 1)")
      .run()
    const error = await refusal(() => w.svc.start(as('ana'), { invite: ['bob', 'cy', 'dee'] }))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('invite', () => {
  test('only the initiator (active) or the owner invites; a member who is not the initiator is refused', async () => {
    const roomId = await startRoom('ana', ['bob'])
    await w.svc.accept(as('bob'), roomId)
    const error = await refusal(() => w.svc.invite(as('bob'), roomId, ['cy']))
    expect(error).toMatchObject({ code: 'FORBIDDEN', reason: 'not-initiator' })
    const outsider = await refusal(() => w.svc.invite(as('cy'), roomId, ['dee']))
    expect(outsider).toMatchObject({ code: 'FORBIDDEN', reason: 'not-member' })
    const owner = await w.svc.invite(as('boss'), roomId, ['cy'])
    expect(owner).toEqual([{ person: 'cy', status: 'invited' }])
  })

  test('an invitee already invited is "exists"; a removed one is "refused" for everyone', async () => {
    const roomId = await startRoom('ana', ['bob'])
    expect(await w.svc.invite(as('ana'), roomId, ['bob'])).toEqual([
      { person: 'bob', status: 'exists' },
    ])
    await w.svc.accept(as('bob'), roomId)
    await w.svc.remove(as('ana'), roomId, 'bob')
    expect(await w.svc.invite(as('ana'), roomId, ['bob'])).toEqual([
      { person: 'bob', status: 'refused' },
    ])
  })

  test('a person who declined is invited again', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.decline(as('bob'), roomId)
    expect(await w.svc.invite(as('ana'), roomId, ['bob'])).toEqual([
      { person: 'bob', status: 'invited' },
    ])
  })

  test('a room that has ended takes no invitations (PRECONDITION_FAILED)', async () => {
    const roomId = await startRoom('ana', ['bob'])
    await w.svc.end(as('ana'), roomId)
    const error = await refusal(() => w.svc.invite(as('ana'), roomId, ['cy']))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  test('the room is full past rooms.maxMembers seats (PRECONDITION_FAILED)', async () => {
    w.sqlite
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('rooms.maxMembers', '2', 1)")
      .run()
    const roomId = await startRoom('ana', ['bob'])
    expect(await w.svc.invite(as('ana'), roomId, ['cy'])).toEqual([
      { person: 'cy', status: 'invited' },
    ])
    const error = await refusal(() => w.svc.invite(as('ana'), roomId, ['dee']))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'the room is full' })
  })
})

describe('accept', () => {
  test('moves the invitation to active, opens the room, grants write, writes a join and notifies the members', async () => {
    const roomId = await startRoom('ana', ['bob'])
    const room = w.svc.accept(as('bob'), roomId)
    expect(room.state).toBe('active')
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('active')
    expect(w.roomAcl.canWrite(member('bob'), roomId)).toBe(true)
    expect(kinds(roomId)).toEqual(['join'])
    expect(transcript(roomId)[0]?.speaker).toBe('bob')
    expect(w.notified.at(-1)).toEqual({
      roomId,
      personIds: ['ana', 'bob'],
      seq: transcript(roomId)[0]?.seq ?? 0,
    })
    expect(w.audit.at(-1)).toMatchObject({ kind: 'room.accept', actor: 'bob' })
    expect(w.activity.at(-1)).toEqual({
      sessionId: 'front:bob',
      type: 'brain.corpus-callosum.join',
      payload: { region: 'corpus-callosum', roomId },
    })
  })

  test("an invitation is recorded on the invitee's front session as brain.corpus-callosum.invite (no text)", async () => {
    const roomId = await startRoom('ana', ['bob'])
    expect(w.activity.filter((a) => a.type === 'brain.corpus-callosum.invite')).toEqual([
      {
        sessionId: 'front:bob',
        type: 'brain.corpus-callosum.invite',
        payload: { region: 'corpus-callosum', roomId },
      },
    ])
    expect(await w.svc.invite(as('ana'), roomId, ['bob'])).toEqual([
      { person: 'bob', status: 'exists' },
    ])
    expect(w.activity.filter((a) => a.type === 'brain.corpus-callosum.invite')).toHaveLength(1)
  })

  test('a person who is active in another room gets CONFLICT', async () => {
    const roomA = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomA)
    const roomB = await startRoom('cy', ['bob'])
    const error = await refusal(() => w.svc.accept(as('bob'), roomB))
    expect(error).toMatchObject({ code: 'CONFLICT' })
    expect(w.rooms.member(roomB, 'bob')?.status).toBe('invited')
  })

  test('an invitation past its lifetime is expired and refused (PRECONDITION_FAILED)', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.advance(11 * MINUTE)
    const error = await refusal(() => w.svc.accept(as('bob'), roomId))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'the invitation expired' })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('expired')
  })

  test('a person with no invitation is NOT_FOUND; an answered one is CONFLICT', async () => {
    const roomId = await startRoom('ana', ['bob'])
    const none = await refusal(() => w.svc.accept(as('dee'), roomId))
    expect(none).toMatchObject({ code: 'NOT_FOUND' })
    w.svc.accept(as('bob'), roomId)
    const again = await refusal(() => w.svc.accept(as('bob'), roomId))
    expect(again).toMatchObject({ code: 'CONFLICT' })
  })

  test('a room that has ended takes no acceptance (PRECONDITION_FAILED)', async () => {
    const roomId = await startRoom('ana', ['bob'])
    await w.svc.end(as('ana'), roomId)
    const error = await refusal(() => w.svc.accept(as('bob'), roomId))
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('decline', () => {
  test('marks the invitation declined, audits it, and tells the members with a system line (no name, no text)', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.decline(as('bob'), roomId)
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('declined')
    expect(w.audit.at(-1)).toMatchObject({ kind: 'room.decline', actor: 'bob' })
    const last = transcript(roomId).at(-1)
    expect(last).toMatchObject({ kind: 'system', speaker: null, text: null })
    expect(w.notified.at(-1)?.personIds).toEqual(['ana'])
  })

  test('a second answer is CONFLICT', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.decline(as('bob'), roomId)
    const error = await refusal(() => w.svc.decline(as('bob'), roomId))
    expect(error).toMatchObject({ code: 'CONFLICT' })
  })
})

describe('leave', () => {
  test('the speaker leaves: write gone, read kept up to the leave, a leave row, the members told', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    w.svc.leave(as('bob'), roomId)
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('left')
    expect(w.roomAcl.canWrite(member('bob'), roomId)).toBe(false)
    expect(w.roomAcl.canRead(member('bob'), roomId)).toBe(true)
    expect(kinds(roomId)).toEqual(['join', 'join', 'leave'])
    expect(w.notified.at(-1)?.personIds).toEqual(['ana', 'bob', 'cy'])
    expect(w.audit.at(-1)).toMatchObject({
      kind: 'room.leave',
      actor: 'bob',
      detail: { roomId, subject: 'bob', reason: 'left' },
    })
  })

  test('a person who is not an active member (or leaves twice) is FORBIDDEN not-member', async () => {
    const roomId = await startRoom('ana', ['bob'])
    const outsider = await refusal(() => w.svc.leave(as('dee'), roomId))
    expect(outsider).toMatchObject({ code: 'FORBIDDEN', reason: 'not-member' })
    w.svc.accept(as('bob'), roomId)
    w.svc.leave(as('bob'), roomId)
    const again = await refusal(() => w.svc.leave(as('bob'), roomId))
    expect(again).toMatchObject({ code: 'FORBIDDEN', reason: 'not-member' })
  })

  test('the initiator leaves and the room continues; the initiator then has no control, the owner still ends it', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    w.svc.leave(as('ana'), roomId)
    expect(w.rooms.get(roomId)?.state).toBe('active')
    expect(w.rooms.get(roomId)?.initiator).toBe('ana')
    const removal = await refusal(() => w.svc.remove(as('ana'), roomId, 'cy'))
    expect(removal).toMatchObject({ code: 'FORBIDDEN', reason: 'not-member' })
    const byBob = await refusal(() => w.svc.remove(as('bob'), roomId, 'cy'))
    expect(byBob).toMatchObject({ code: 'FORBIDDEN', reason: 'not-initiator' })
    await w.svc.end(as('boss'), roomId, 'owner closed it')
    expect(w.rooms.get(roomId)?.state).toBe('ended')
    expect(w.audit.map((a) => a.kind)).toContain('room.owner-end')
  })

  test('the last active member leaving ends the room with reason empty, seals the folder and writes brain end', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    w.svc.leave(as('ana'), roomId)
    expect(w.rooms.get(roomId)?.state).toBe('active')
    w.svc.leave(as('bob'), roomId)
    const room = w.rooms.get(roomId)
    expect(room?.state).toBe('ended')
    expect(room?.endReason).toBe('empty')
    expect(room?.endedBy).toBe('bob')
    expect(w.audit.find((a) => a.kind === 'room.leave' && a.actor === 'bob')?.detail).toMatchObject(
      { reason: 'empty' },
    )
    expect(w.audit.map((a) => a.kind)).toContain('room.end')
    expect(isRoomWorkspaceSealed(dataDir, roomId)).toBe(true)
    expect(w.activity.at(-1)).toEqual({
      sessionId: roomSessionId(roomId, 1),
      type: 'brain.corpus-callosum.end',
      payload: { region: 'corpus-callosum', roomId, reason: 'empty' },
    })
  })
})

describe('remove', () => {
  test('the initiator removes a member: the member loses write, keeps read, a remove row, an audit row', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    await w.svc.remove(as('ana'), roomId, 'bob')
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('removed')
    expect(w.roomAcl.canWrite(member('bob'), roomId)).toBe(false)
    expect(w.roomAcl.canRead(member('bob'), roomId)).toBe(true)
    expect(transcript(roomId).at(-1)).toMatchObject({ kind: 'remove', speaker: 'bob' })
    expect(w.audit.at(-1)).toMatchObject({
      kind: 'room.remove',
      actor: 'ana',
      detail: { roomId, subject: 'bob', reason: 'removed' },
    })
  })

  test('another member (not the initiator) is refused; a person not in the room is CONFLICT', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const byMember = await refusal(() => w.svc.remove(as('bob'), roomId, 'cy'))
    expect(byMember).toMatchObject({ code: 'FORBIDDEN', reason: 'not-initiator' })
    const absent = await refusal(() => w.svc.remove(as('ana'), roomId, 'dee'))
    expect(absent).toMatchObject({ code: 'CONFLICT' })
    const self = await refusal(() => w.svc.remove(as('ana'), roomId, 'ana'))
    expect(self).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  test('the owner removes a member of a room the owner is not in', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    await w.svc.remove(as('boss'), roomId, 'cy')
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('removed')
    expect(w.audit.at(-1)).toMatchObject({ actor: 'boss', kind: 'room.remove' })
  })
})

describe('end', () => {
  test('the initiator ends the room: members lose write and are left, the end row, the folder sealed, audit and brain', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    await w.svc.end(as('ana'), roomId, 'done')
    const room = w.rooms.get(roomId)
    expect(room).toMatchObject({ state: 'ended', endReason: 'done', endedBy: 'ana' })
    expect(w.rooms.member(roomId, 'bob')).toMatchObject({ status: 'left', leaveReason: 'ended' })
    expect(w.roomAcl.canWrite(member('bob'), roomId)).toBe(false)
    expect(w.roomAcl.canRead(member('bob'), roomId)).toBe(true)
    expect(transcript(roomId).at(-1)).toMatchObject({ kind: 'end', data: { reason: 'done' } })
    expect(w.notified.at(-1)?.personIds).toEqual(['ana', 'bob'])
    expect(isRoomWorkspaceSealed(dataDir, roomId)).toBe(true)
    expect(w.audit.map((a) => a.kind)).toEqual([
      'room.create',
      'room.invite',
      'room.accept',
      'room.end',
    ])
    expect(w.activity.at(-1)?.type).toBe('brain.corpus-callosum.end')
  })

  test('the owner who did not start the room ends it: room.end and room.owner-end', async () => {
    const roomId = await startRoom('ana', ['bob'])
    await w.svc.accept(as('bob'), roomId)
    await w.svc.end(as('boss'), roomId)
    expect(w.rooms.get(roomId)).toMatchObject({
      state: 'ended',
      endReason: 'ended',
      endedBy: 'boss',
    })
    expect(w.audit.slice(-2).map((a) => a.kind)).toEqual(['room.end', 'room.owner-end'])
    // the members active at the end (the initiator and bob) are the subjects of the row, no text
    expect(w.audit.at(-1)?.detail).toEqual({
      roomId,
      subject: 'ana',
      reason: 'ended',
      members: ['ana', 'bob'],
    })
  })

  test('a member who is not the initiator is refused, a stranger is refused, a second end is PRECONDITION_FAILED', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    const byMember = await refusal(() => w.svc.end(as('bob'), roomId))
    expect(byMember).toMatchObject({ code: 'FORBIDDEN', reason: 'not-initiator' })
    const stranger = await refusal(() => w.svc.end(as('dee'), roomId))
    expect(stranger).toMatchObject({ code: 'FORBIDDEN', reason: 'not-member' })
    await w.svc.end(as('ana'), roomId)
    const again = await refusal(() => w.svc.end(as('ana'), roomId))
    expect(again).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  test('an ended room expires its open invitations and pending requests', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.rooms.createRequest({
      id: 'req-1',
      roomId,
      person: 'ana',
      kind: 'remove',
      payload: null,
      createdAt: w.now(),
      expiresAt: w.now() + 10 * MINUTE,
    })
    await w.svc.end(as('ana'), roomId)
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('expired')
    expect(w.rooms.request('req-1')?.status).toBe('expired')
  })
})

describe('endMemberships (suspension and removal of a person)', () => {
  test('a suspended member is removed with reason suspended; the room goes on for the others', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const ended = w.svc.endMemberships('bob', 'suspended', { by: 'boss', via: 'tcp' })
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ roomId, seq: transcript(roomId).at(-1)?.seq })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('removed')
    expect(w.audit.at(-1)).toMatchObject({
      kind: 'room.remove',
      actor: 'boss',
      via: 'tcp',
      detail: { roomId, subject: 'bob', reason: 'suspended' },
    })
    expect(w.rooms.get(roomId)?.state).toBe('active')
  })

  test('an invitation of the person is declined; the last active member ends the room as empty', async () => {
    const roomA = await startRoom('ana', ['bob'])
    const roomB = await startRoom('cy', ['bob'])
    const ended = w.svc.endMemberships('bob', 'removed', { by: 'system', via: 'local' })
    expect(ended.map((e) => e.roomId).sort()).toEqual([roomA, roomB].sort())
    expect(ended.every((e) => e.from.status === 'invited')).toBe(true)
    expect(w.rooms.member(roomA, 'bob')?.status).toBe('declined')
  })

  test('the initiator suspended with no one else left ends the room empty', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    w.svc.leave(as('bob'), roomId)
    w.svc.endMemberships('ana', 'suspended', { by: 'system', via: 'local' })
    expect(w.rooms.get(roomId)).toMatchObject({ state: 'ended', endReason: 'empty' })
  })
})

describe('sweep', () => {
  test('expires invitations past the lifetime and pending requests past their expiry', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.rooms.createRequest({
      id: 'req-2',
      roomId,
      person: 'ana',
      kind: 'end',
      payload: null,
      createdAt: w.now(),
      expiresAt: w.now() + 10 * MINUTE,
    })
    w.advance(5 * MINUTE)
    expect(w.svc.sweep()).toEqual({ invites: 0, requests: 0 })
    w.advance(6 * MINUTE)
    expect(w.svc.sweep()).toEqual({ invites: 1, requests: 1 })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('expired')
    expect(w.rooms.request('req-2')?.status).toBe('expired')
  })
})

describe('settings', () => {
  test('the defaults hold until a value is stored; a stored value outside its bounds reads as the default', () => {
    const settings = createRoomSettings(settingsRepo(w.sqlite))
    expect(settings.values()).toEqual({
      maxMembers: 8,
      inviteTtlMinutes: 10,
      maxTurnsPerHour: 60,
      maxQueue: 10,
      windowMinutes: 30,
      windowEvents: 200,
    })
    settings.set({ maxMembers: 4, windowMinutes: 45 })
    expect(settings.maxMembers()).toBe(4)
    expect(settings.windowMinutes()).toBe(45)
    w.sqlite.query("UPDATE settings SET value = '99' WHERE key = 'rooms.maxMembers'").run()
    expect(settings.maxMembers()).toBe(8)
  })

  test('a value outside its bounds is refused and nothing is written', () => {
    const settings = createRoomSettings(settingsRepo(w.sqlite))
    expect(() => settings.set({ maxMembers: 1 })).toThrow(RangeError)
    expect(() => settings.set({ maxTurnsPerHour: 601 })).toThrow(RangeError)
    expect(settings.maxMembers()).toBe(8)
  })

  test('the room copies the window settings in force when it starts', async () => {
    createRoomSettings(settingsRepo(w.sqlite)).set({ windowMinutes: 45, windowEvents: 50 })
    const roomId = await startRoom('ana', ['bob'])
    expect(w.rooms.get(roomId)).toMatchObject({ windowMinutes: 45, windowEvents: 50 })
  })
})

describe('roomWorkspaceDir', () => {
  test('a name that is not a room id names no folder', () => {
    expect(() => roomWorkspaceDir(dataDir, '../etc')).toThrow(RangeError)
  })
})

describe('requests: remove and end, confirmed by the person they name (P30.4.1)', () => {
  test("the initiator's remove request, confirmed by the initiator, removes the member", async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    expect(request).toMatchObject({ kind: 'remove', person: 'ana', status: 'pending' })
    expect(request.payload).toEqual({ target: 'cy' })
    // the request alone changes nothing
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('active')
    expect(await w.svc.confirm(request.id, as('ana'), true)).toEqual({ status: 'confirmed' })
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('removed')
    expect(w.rooms.request(request.id)?.status).toBe('confirmed')
    expect(w.audit.some((a) => a.kind === 'room.remove' && a.detail?.subject === 'cy')).toBe(true)
    // a settled request cannot be confirmed again
    const again = await refusal(() => w.svc.confirm(request.id, as('ana'), true))
    expect((again as RoomError).code).toBe('CONFLICT')
  })

  test("another member's confirmation is FORBIDDEN and the request stays pending", async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    const error = (await refusal(() => w.svc.confirm(request.id, as('bob'), true))) as RoomError
    expect(error).toBeInstanceOf(RoomError)
    expect(error.code).toBe('FORBIDDEN')
    expect(error.reason).toBe('not-initiator')
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('active')
    expect(w.rooms.request(request.id)?.status).toBe('pending')
  })

  test('a request by a member who is not the initiator is refused and creates no row', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const error = (await refusal(() => w.svc.requestRemove(as('bob'), roomId, 'cy'))) as RoomError
    expect(error.code).toBe('FORBIDDEN')
    expect(error.reason).toBe('not-initiator')
    expect(w.rooms.pendingRequests('bob', w.now())).toEqual([])
    expect(
      w.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM room_requests').get()?.n,
    ).toBe(0)
  })

  test('a refused tool call writes room.turn.refused with the speaker and the tool, and no text', async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    w.svc.turnRefused('bob', roomId, 'room_request_remove', 'not-initiator-or-owner')
    const row = w.audit.find((a) => a.kind === 'room.turn.refused')
    expect(row?.actor).toBe('bob')
    expect(row?.detail).toEqual({
      roomId,
      speaker: 'bob',
      tool: 'room_request_remove',
      reason: 'not-initiator-or-owner',
    })
  })

  test('an unconfirmed request expires after ten minutes and changes nothing', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    w.advance(10 * MINUTE - 1)
    expect(w.svc.sweep().requests).toBe(0)
    w.advance(1)
    expect(w.svc.sweep().requests).toBe(1)
    const error = (await refusal(() => w.svc.confirm(request.id, as('ana'), true))) as RoomError
    expect(error.code).toBe('PRECONDITION_FAILED')
    expect(w.rooms.request(request.id)?.status).toBe('expired')
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('active')
    expect(w.rooms.get(roomId)?.state).toBe('active')
  })

  test('a late confirmation, before any sweep, is refused as expired and changes nothing', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    w.advance(10 * MINUTE)
    const error = (await refusal(() => w.svc.confirm(request.id, as('ana'), true))) as RoomError
    expect(error.code).toBe('PRECONDITION_FAILED')
    expect(w.rooms.request(request.id)?.status).toBe('expired')
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('active')
  })

  test('the owner confirms a remove for any room, without being a member', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    expect(w.rooms.member(roomId, 'boss')).toBeUndefined()
    await w.svc.confirm(request.id, as('boss'), true)
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('removed')
    expect(w.audit.find((a) => a.kind === 'room.remove')?.actor).toBe('boss')
  })

  test("the initiator's end request, confirmed by the initiator, ends the room", async () => {
    const roomId = await startRoom('ana', ['bob'])
    w.svc.accept(as('bob'), roomId)
    const request = await w.svc.requestEnd(as('ana'), roomId)
    expect(request).toMatchObject({ kind: 'end', person: 'ana', status: 'pending' })
    expect(w.rooms.get(roomId)?.state).toBe('active')
    await w.svc.confirm(request.id, as('ana'), true)
    expect(w.rooms.get(roomId)).toMatchObject({ state: 'ended', endReason: 'ended' })
    expect(w.rooms.member(roomId, 'bob')?.status).toBe('left')
  })

  test('a refusal settles the request as refused and changes nothing', async () => {
    const roomId = await startRoom('ana', ['bob', 'cy'])
    w.svc.accept(as('bob'), roomId)
    w.svc.accept(as('cy'), roomId)
    const request = await w.svc.requestRemove(as('ana'), roomId, 'cy')
    expect(await w.svc.confirm(request.id, as('ana'), false)).toEqual({ status: 'refused' })
    expect(w.rooms.request(request.id)?.status).toBe('refused')
    expect(w.rooms.member(roomId, 'cy')?.status).toBe('active')
  })

  test('an unknown request is NOT_FOUND; the owner may not confirm a post; the named person posts it once (P30.4.3)', async () => {
    const roomId = await startRoom('ana', ['bob'])
    await w.svc.accept(as('bob'), roomId)
    expect(((await refusal(() => w.svc.confirm('nope', as('ana'), true))) as RoomError).code).toBe(
      'NOT_FOUND',
    )
    w.rooms.createRequest({
      id: 'post-1',
      roomId,
      person: 'bob',
      kind: 'post',
      payload: { text: 'a result' },
      createdAt: w.now(),
      expiresAt: w.now() + 10 * MINUTE,
    })
    const boss = (await refusal(() => w.svc.confirm('post-1', as('boss'), true))) as RoomError
    expect(boss.code).toBe('FORBIDDEN')
    expect(await w.svc.confirm('post-1', as('bob'), true)).toEqual({ status: 'confirmed' })
    expect(w.rooms.request('post-1')?.status).toBe('confirmed')
    expect(w.rooms.window(roomId, w.now()).filter((e) => e.kind === 'post')).toHaveLength(1)
  })
})
