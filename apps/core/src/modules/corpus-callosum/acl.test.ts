import { describe, expect, test } from 'bun:test'
import type { AclActor } from '@keith/contracts'
import { migrateDatabase, openDatabase, roomsRepo, type Sqlite, sqliteAcl } from '@keith/db'
import { createKindTable } from '../acl/index.ts'
import type { AclAuditCaller } from '../audit/index.ts'
import { createRoomAcl, ROOM_KIND, ROOM_KIND_DEF } from './acl.ts'

// The room ACL (docs/specs/corpus-callosum.md, "ACL"; leak test of phase 1, P30.1.5). Real SQLite store, real room repo.

const MINUTE = 60_000
const T0 = 1_000

function world() {
  const sqlite: Sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  for (const [id, role] of [
    ['boss', 'owner'],
    ['ana', 'member'],
    ['bob', 'member'],
    ['cy', 'member'],
    ['dee', 'member'],
    ['eve', 'member'],
  ] as const) {
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, 'active', 1)",
      )
      .run(id, id, role, id)
  }
  const kinds = createKindTable()
  kinds.register(ROOM_KIND, ROOM_KIND_DEF)
  kinds.register('note', { class: 'leaf' })
  const acl = sqliteAcl(sqlite, { kinds })
  const rooms = roomsRepo(sqlite)
  const auditRows: { kind: string; actor: string; detail: Record<string, unknown> | undefined }[] =
    []
  const ownerRows: { kind: string; resources: { id: string; owner: string }[] }[] = []
  const roomAcl = createRoomAcl({
    acl,
    rooms,
    aclAudit: {
      ownerAccess: (_caller, access) => {
        ownerRows.push({ kind: access.kind, resources: access.resources })
        return 1
      },
    },
    audit: {
      record: (event) => {
        auditRows.push({ kind: event.kind, actor: event.actor, detail: event.detail })
      },
    },
  })
  return { sqlite, acl, rooms, roomAcl, auditRows, ownerRows }
}

const member = (id: string): AclActor => ({ kind: 'user', id, role: 'member' })
const owner = (id: string): AclActor => ({ kind: 'user', id, role: 'owner' })
const caller = (by: string): AclAuditCaller => ({ by, via: 'local' })

const NEW = (id: string, initiator: string) => ({
  id,
  name: `Room ${id}`,
  initiator,
  answerMode: 'addressed' as const,
  windowMinutes: 30,
  windowEvents: 200,
})

/** A room with its ACL row, the initiator active, and the people in `joined` accepted. */
function openRoom(w: ReturnType<typeof world>, id: string, initiator: string, joined: string[]) {
  w.rooms.create(NEW(id, initiator), T0)
  w.roomAcl.create(id, initiator)
  for (const p of joined) {
    w.rooms.invite(id, p, initiator, T0)
    expect(w.rooms.accept(id, p, T0)).toBe('moved')
    w.roomAcl.grant(id, p, p)
  }
}

describe('room ACL: leak test (phase 1)', () => {
  test('a person who was never invited cannot read the transcript or any right of the room', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 1,
      kind: 'say',
      speaker: 'ana',
      text: 'secret plan',
    })
    expect(w.roomAcl.canRead(member('cy'), 'x')).toBe(false)
    expect(w.roomAcl.canWrite(member('cy'), 'x')).toBe(false)
    expect(
      w.roomAcl.read({ actor: member('cy'), caller: caller('cy') }, 'x', 0, 50),
    ).toBeUndefined()
    expect(w.ownerRows).toHaveLength(0)
  })

  test('a member of room X cannot read room Y', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    openRoom(w, 'y', 'dee', [])
    w.rooms.appendEvent({
      roomId: 'y',
      at: T0 + 1,
      kind: 'say',
      speaker: 'dee',
      text: 'room y text',
    })
    expect(w.roomAcl.canRead(member('bob'), 'x')).toBe(true)
    expect(w.roomAcl.canRead(member('bob'), 'y')).toBe(false)
    expect(
      w.roomAcl.read({ actor: member('bob'), caller: caller('bob') }, 'y', 0, 50),
    ).toBeUndefined()
  })

  test('a declined invitation gives no right', () => {
    const w = world()
    openRoom(w, 'x', 'ana', [])
    w.rooms.invite('x', 'eve', 'ana', T0)
    expect(w.rooms.decline('x', 'eve')).toBe('moved')
    expect(w.roomAcl.canRead(member('eve'), 'x')).toBe(false)
  })

  test('personal kinds are unaffected by room grants', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    // ana's note; bob is an active member of room x and must still not read it
    w.acl.createResource({ kind: 'note', id: 'n1', ownerId: 'ana' })
    expect(w.acl.check(member('bob'), 'note', 'n1', 4).allowed).toBe(false)
    expect(w.acl.check(member('bob'), 'note', 'n1', 2).allowed).toBe(false)
    // and the room grant is not a grant on the note kind either
    expect(w.acl.check(member('ana'), 'note', 'n1', 4).allowed).toBe(true)
  })
})

describe('room ACL: grants and the cut of a removed member', () => {
  test('the initiator reads their room without an owner-access row', () => {
    const w = world()
    openRoom(w, 'x', 'ana', [])
    w.rooms.appendEvent({ roomId: 'x', at: T0 + 1, kind: 'say', speaker: 'ana', text: 'hello' })
    const events = w.roomAcl.read({ actor: member('ana'), caller: caller('ana') }, 'x', 0, 50)
    expect(events?.map((e) => e.text)).toEqual(['hello'])
    expect(w.ownerRows).toHaveLength(0)
    expect(w.auditRows.some((r) => r.kind === 'room.read')).toBe(false)
  })

  test('an accepted member reads and may write; leaving removes the write and keeps the read', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    expect(w.roomAcl.canWrite(member('bob'), 'x')).toBe(true)
    w.roomAcl.revokeWrite('x', 'bob', 'bob')
    expect(w.roomAcl.canWrite(member('bob'), 'x')).toBe(false)
    expect(w.roomAcl.canRead(member('bob'), 'x')).toBe(true)
  })

  test('a removed member keeps r, but the transcript stops at the removal', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 1 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'before',
    })
    const removedAt = T0 + 2 * MINUTE
    expect(w.rooms.leave('x', 'bob', 'removed', 'removed', removedAt)).toBe('moved')
    w.roomAcl.revokeWrite('x', 'bob', 'ana')
    w.rooms.appendEvent({
      roomId: 'x',
      at: removedAt,
      kind: 'remove',
      speaker: null,
      data: { person: 'bob' },
    })
    w.rooms.appendEvent({
      roomId: 'x',
      at: removedAt + 1,
      kind: 'say',
      speaker: 'ana',
      text: 'after',
    })

    expect(w.roomAcl.canRead(member('bob'), 'x')).toBe(true)
    expect(w.roomAcl.canWrite(member('bob'), 'x')).toBe(false)
    const seen = w.roomAcl.read({ actor: member('bob'), caller: caller('bob') }, 'x', 0, 50)
    expect(seen?.map((e) => e.text ?? e.kind)).toEqual(['before', 'remove'])
    expect(w.ownerRows).toHaveLength(0)
  })

  test('a granted entry is not a grant on another room (per-resource entries)', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    openRoom(w, 'y', 'ana', [])
    expect(w.acl.getResource(ROOM_KIND, 'y')?.entries).toEqual([])
    expect(w.roomAcl.canWrite(member('bob'), 'y')).toBe(false)
  })
})

describe('room ACL: rejoin leak (P30.1.4 open issue)', () => {
  test('a member who left and was invited again reads nothing written while away or before the rejoin', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 1 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'bob before',
    })
    const leftAt = T0 + 2 * MINUTE
    w.rooms.appendEvent({ roomId: 'x', at: leftAt, kind: 'leave', speaker: 'bob', text: null })
    expect(w.rooms.leave('x', 'bob', 'left', 'self', leftAt)).toBe('moved')
    w.roomAcl.revokeWrite('x', 'bob', 'bob')
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 3 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'while away',
    })

    // invited again, accepted, and the entry granted again
    expect(w.rooms.invite('x', 'bob', 'ana', T0 + 4 * MINUTE)).toBe('invited')
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 5 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'invited only',
    })
    expect(w.rooms.accept('x', 'bob', T0 + 6 * MINUTE)).toBe('moved')
    w.roomAcl.grant('x', 'bob', 'bob')
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 7 * MINUTE,
      kind: 'say',
      speaker: 'ana',
      text: 'after rejoin',
    })

    expect(w.roomAcl.canRead(member('bob'), 'x')).toBe(true)
    const seen = w.roomAcl.read({ actor: member('bob'), caller: caller('bob') }, 'x', 0, 50)
    expect(seen?.map((e) => e.text)).toEqual(['after rejoin'])
    expect(w.ownerRows).toHaveLength(0)
  })
})

describe('room ACL: owner read is audited', () => {
  test('the instance owner who is not in the room reads the whole transcript, with acl.owner-access and room.read', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 1 * MINUTE,
      kind: 'say',
      speaker: 'bob',
      text: 'a',
    })
    w.rooms.appendEvent({
      roomId: 'x',
      at: T0 + 2 * MINUTE,
      kind: 'say',
      speaker: 'bob',
      text: 'b',
    })
    const events = w.roomAcl.read({ actor: owner('boss'), caller: caller('boss') }, 'x', 0, 50)
    expect(events?.map((e) => e.text)).toEqual(['a', 'b'])
    expect(w.ownerRows).toEqual([{ kind: ROOM_KIND, resources: [{ id: 'x', owner: 'ana' }] }])
    expect(w.auditRows.filter((r) => r.kind === 'room.read')).toEqual([
      // the initiator and the active member (bob) are named; no text
      {
        kind: 'room.read',
        actor: 'boss',
        detail: { roomId: 'x', owner: 'ana', members: ['ana', 'bob'] },
      },
    ])
  })

  test('a member reading their own room is not an owner read', () => {
    const w = world()
    openRoom(w, 'x', 'ana', ['bob'])
    w.roomAcl.read({ actor: member('bob'), caller: caller('bob') }, 'x', 0, 50)
    expect(w.ownerRows).toHaveLength(0)
    expect(w.auditRows).toHaveLength(0)
  })

  test('the owner read is refused for a room that does not exist', () => {
    const w = world()
    expect(
      w.roomAcl.read({ actor: owner('boss'), caller: caller('boss') }, 'nope', 0, 50),
    ).toBeUndefined()
    expect(w.ownerRows).toHaveLength(0)
    expect(w.auditRows).toHaveLength(0)
  })
})
