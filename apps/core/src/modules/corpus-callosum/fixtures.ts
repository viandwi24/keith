// Shared fixtures of the room tests: a real SQLite store with the people, the room ACL and the room repo, and fakes for the
// delivery, feed, audit, activity and people directory that record their calls. Test files only (`*.test.ts`) import it.
import type { Person } from '@keith/contracts'
import {
  migrateDatabase,
  openDatabase,
  roomsRepo,
  type Sqlite,
  settingsRepo,
  sqliteAcl,
} from '@keith/db'
import { createKindTable } from '../acl/index.ts'
import { PeopleError } from '../people/index.ts'
import { createRoomAcl, ROOM_KIND, ROOM_KIND_DEF } from './acl.ts'
import { createRoomService, type RoomActivity, type RoomCaller, type RoomFeed } from './service.ts'
import { createRoomSettings } from './settings.ts'

export const PEOPLE = [
  { id: 'boss', name: 'Owner', role: 'owner', status: 'active' },
  { id: 'ana', name: 'Ana', role: 'member', status: 'active' },
  { id: 'bob', name: 'Bob', role: 'member', status: 'active' },
  { id: 'cy', name: 'Cy', role: 'member', status: 'active' },
  { id: 'dee', name: 'Dee', role: 'member', status: 'active' },
  { id: 'sus', name: 'Sus', role: 'member', status: 'suspended' },
] as const
/** The members that hold `rooms.start` by grant (the owner holds it by role). Dee does not. */
export const GRANTED = new Set(['ana', 'bob', 'cy', 'sus'])

export interface Recorded {
  kind: string
  actor: string
  via: string
  detail: Record<string, unknown> | undefined
}

export function roomWorld(dataDir: string) {
  const sqlite: Sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  for (const p of PEOPLE)
    sqlite
      .query(
        'INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, ?, 1)',
      )
      .run(p.id, p.name, p.role, p.id, p.status)
  const kinds = createKindTable()
  kinds.register(ROOM_KIND, ROOM_KIND_DEF)
  const acl = sqliteAcl(sqlite, { kinds })
  const rooms = roomsRepo(sqlite)
  const audit: Recorded[] = []
  const notified: { roomId: string; personIds: string[]; seq: number }[] = []
  const delivered: { id: string; to: string; text: string; mode: string }[] = []
  const activity: { sessionId: string; type: string; payload: Record<string, unknown> }[] = []
  let clock = 1_000_000
  const feed: RoomFeed = {
    notify: (roomId, personIds, seq) => notified.push({ roomId, personIds: [...personIds], seq }),
  }
  const act: RoomActivity = {
    record: (sessionId, type, payload) => activity.push({ sessionId, type, payload }),
  }
  const people = {
    get: async (ref: string): Promise<Person> => {
      const p = PEOPLE.find((x) => x.id === ref)
      if (p === undefined) throw new PeopleError('NOT_FOUND', `no person ${ref}`)
      return {
        id: p.id,
        username: p.id,
        name: p.name,
        role: p.role,
        status: p.status,
        canLogin: true,
        createdBy: null,
        createdAt: 1,
        updatedAt: 1,
      } as Person
    },
  }
  const roomAcl = createRoomAcl({
    acl,
    rooms,
    aclAudit: { ownerAccess: () => 1 },
    audit: { record: () => {} },
  })
  const svc = createRoomService({
    rooms,
    acl: roomAcl,
    people,
    // the fixture's people never reset: every front session is generation 0
    generations: { current: () => 0 },
    delivery: {
      deliver: async (request) => {
        delivered.push({
          id: request.id,
          to: request.to,
          text: request.text,
          mode: request.needs?.mode ?? 'wake',
        })
        return { status: 'delivered', route: 'front', attempts: 1 }
      },
    },
    audit: {
      record: (event) =>
        audit.push({
          kind: event.kind,
          actor: event.actor,
          via: event.via,
          detail: event.detail,
        }),
    },
    feed,
    transport: {
      sayLine: async (roomId, from, text, data) =>
        rooms.appendEvent({
          roomId,
          at: clock,
          kind: from === 'keith' ? 'keith' : 'say',
          speaker: from,
          text,
          ...(data === undefined ? {} : { data }),
        }),
      postLine: async (roomId, personId, text) =>
        rooms.appendEvent({ roomId, at: clock, kind: 'post', speaker: personId, text }),
    },
    activity: act,
    capabilities: {
      holds: (personId, capability) =>
        capability === 'rooms.start' &&
        (personId === 'boss' || (GRANTED.has(personId) && personId !== 'sus')),
    },
    settings: createRoomSettings(settingsRepo(sqlite)),
    dataDir,
    now: () => clock,
  })
  return {
    sqlite,
    roomAcl,
    rooms,
    svc,
    audit,
    notified,
    delivered,
    activity,
    dataDir,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

export const as = (by: string): RoomCaller => ({ by, via: 'local' })
/** The refusal a call throws (sync or async), or undefined when it returns. */
export async function refusal(call: () => unknown): Promise<unknown> {
  try {
    await call()
    return undefined
  } catch (error) {
    return error
  }
}
export const member = (id: string) => ({ kind: 'user' as const, id, role: 'member' as const })
