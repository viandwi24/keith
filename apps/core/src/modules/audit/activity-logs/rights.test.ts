import { describe, expect, test } from 'bun:test'
import {
  type Capability,
  LogsOwnerReadAuditDetailSchema,
  type PersonStatus,
} from '@keith/contracts'
import { auditRepo, migrateDatabase, openDatabase } from '@keith/db'
import { ACL_AUDIT_WINDOW_MS, createAclAudit } from '../acl-audit.ts'
import { createAudit } from '../audit.ts'
import { listMine } from '../mine.ts'
import { type AuditedLogsReader, createLogRights, type LogsSession } from './rights.ts'

// The rights of the activity logs (ADR-0032 §8). Real in-memory SQLite audit log and the real ACL audit recorder; the people and room
// ports are small fakes. The rows are read back the way `audit.mine` reads them.

const MIN = 60_000
const MEMBER_CAPS: Capability[] = ['chat', 'logs.mine', 'audit.mine']
const OWNER_CAPS: Capability[] = [...MEMBER_CAPS, 'logs.read', 'people.manage']

function world() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  let t = 1_800_000_000_000
  const now = () => t
  const repo = auditRepo(sqlite, { now })
  const audit = createAudit(repo)
  const aclAudit = createAclAudit({ audit, now })
  const statuses = new Map<string, PersonStatus>([
    ['boss', 'active'],
    ['ana', 'active'],
    ['bob', 'active'],
    ['cy', 'active'],
    ['dee', 'suspended'],
  ])
  // room r1: ana and bob are active members; cy left it (an ex-member)
  const members = new Map<string, Map<string, 'active' | 'left'>>([
    [
      'r1',
      new Map([
        ['ana', 'active'],
        ['bob', 'active'],
        ['cy', 'left'],
      ]),
    ],
  ])
  const rights = createLogRights({
    rooms: {
      canRead: (personId, roomId) => members.get(roomId)?.get(personId) === 'active',
      activeMembers: (roomId) =>
        [...(members.get(roomId) ?? new Map()).entries()]
          .filter(([, s]) => s === 'active')
          .map(([p]) => p),
    },
    people: { statusOf: (personId) => statuses.get(personId) },
    audit,
    aclAudit,
    now,
  })
  const owner: AuditedLogsReader = {
    personId: 'boss',
    isOwner: true,
    capabilities: new Set(OWNER_CAPS),
    via: 'tcp',
    session: 'boss-sess',
  }
  const reader = (personId: string, caps: Capability[] = MEMBER_CAPS): AuditedLogsReader => ({
    personId,
    isOwner: false,
    capabilities: new Set(caps),
    via: 'tcp',
    session: `${personId}-sess`,
  })
  const rows = () => repo.list(200).reverse()
  const ownerReads = () => rows().filter((r) => r.kind === 'logs.owner-read')
  return {
    rights,
    owner,
    reader,
    rows,
    ownerReads,
    repo,
    statuses,
    members,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const chatOf = (personId: string): LogsSession => ({
  id: `front:${personId}:g0`,
  kind: 'chat',
  personId,
})
const roomSession: LogsSession = { id: 'room:r1:g0', kind: 'room', roomId: 'r1' }
const guestSession: LogsSession = { id: 'guest:x1', kind: 'guest' }

describe('canReadSession', () => {
  test('own: a person reads their own chat, task, dream and aux sessions, with no audit row', () => {
    const w = world()
    const ana = w.reader('ana')
    const sessions: LogsSession[] = [
      chatOf('ana'),
      { id: 'front:ana:g0:agent:1', kind: 'task', personId: 'ana' },
      { id: 'dream-judge:1', kind: 'dream', personId: 'ana' },
      { id: 'aux:ana:helper', kind: 'aux', personId: 'ana' },
    ]
    for (const s of sessions) expect(w.rights.canReadSession(ana, s)).toBe('own')
    w.rights.authorize(ana, chatOf('ana'), { purpose: 'detail' })
    expect(w.rows()).toHaveLength(0)
  })

  test('another member on a person session is denied', () => {
    const w = world()
    expect(w.rights.canReadSession(w.reader('bob'), chatOf('ana'))).toBe('deny')
  })

  test('a member of the room reads the room session with no audit row; an ex-member is denied', () => {
    const w = world()
    expect(w.rights.canReadSession(w.reader('ana'), roomSession)).toBe('room')
    expect(w.rights.canReadSession(w.reader('cy'), roomSession)).toBe('deny')
    expect(w.rights.canReadSession(w.reader('dee'), roomSession)).toBe('deny')
    w.rights.authorize(w.reader('ana'), roomSession, { purpose: 'detail' })
    expect(w.rows()).toHaveLength(0)
  })

  test('a suspended person reads nothing, not even their own sessions', () => {
    const w = world()
    const dee = w.reader('dee')
    expect(w.rights.canReadSession(dee, chatOf('dee'))).toBe('deny')
    expect(w.rights.canReadSession(dee, { id: 'aux:dee:h', kind: 'aux', personId: 'dee' })).toBe(
      'deny',
    )
    expect(w.rights.canReadSession(dee, roomSession)).toBe('deny')
  })

  test('a person without logs.mine reads no own session (the capability is held by every role)', () => {
    const w = world()
    expect(w.rights.canReadSession(w.reader('ana', ['chat']), chatOf('ana'))).toBe('deny')
  })

  test('a guest session is read only through the owner path, never by a member', () => {
    const w = world()
    expect(w.rights.canReadSession(w.reader('ana'), guestSession)).toBe('deny')
    expect(w.rights.canReadSession(w.owner, guestSession)).toBe('owner-path')
  })

  test('the owner without logs.read (a grant cannot give it) is not an owner path reader', () => {
    const w = world()
    const noRead: AuditedLogsReader = { ...w.owner, capabilities: new Set(['logs.mine']) }
    expect(w.rights.canReadSession(noRead, chatOf('ana'))).toBe('deny')
  })

  test('the owner reading their own session is own, not the owner path', () => {
    const w = world()
    expect(w.rights.canReadSession(w.owner, chatOf('boss'))).toBe('own')
  })

  test('the owner reads a member session through the owner path, and a room they are not in too', () => {
    const w = world()
    expect(w.rights.canReadSession(w.owner, chatOf('ana'))).toBe('owner-path')
    expect(w.rights.canReadSession(w.owner, roomSession)).toBe('owner-path')
  })

  test('the owner who is a current room member reads the room as a member', () => {
    const w = world()
    w.members.get('r1')?.set('boss', 'active')
    expect(w.rights.canReadSession(w.owner, roomSession)).toBe('room')
  })
})

describe('authorize on the owner path', () => {
  test('the owner reads a member session in detail: one logs.owner-read and one acl.owner-access naming the member', () => {
    const w = world()
    expect(w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail' })).toBe('owner-path')
    const reads = w.ownerReads()
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({
      actor: 'boss',
      via: 'tcp',
      detail: { subject: 'ana', scope: 'session', sessionId: 'front:ana:g0' },
    })
    const access = w.rows().filter((r) => r.kind === 'acl.owner-access')
    expect(access).toHaveLength(1)
    expect(access[0]?.detail).toEqual({
      kind: 'session',
      id: 'front:ana:g0',
      owner: 'ana',
      bits: 4,
    })
    expect(LogsOwnerReadAuditDetailSchema.safeParse(reads[0]?.detail).success).toBe(true)
  })

  test('a detail of the same session in the window writes nothing; after the window it writes again', () => {
    const w = world()
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail' })
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail' })
    expect(w.ownerReads()).toHaveLength(1)
    w.advance(11 * MIN)
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail' })
    expect(w.ownerReads()).toHaveLength(2)
  })

  test('a list of one member in one window is one row for that person, not one per session', () => {
    const w = world()
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'list' })
    w.rights.authorize(
      w.owner,
      { id: 'front:ana:g1', kind: 'chat', personId: 'ana' },
      { purpose: 'list' },
    )
    expect(w.ownerReads()).toHaveLength(1)
    expect(w.ownerReads()[0]?.detail).toMatchObject({ subject: 'ana', scope: 'list' })
  })

  test('a raw read is audited every time, never folded into the window', () => {
    const w = world()
    for (let i = 0; i < 3; i++)
      w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'raw', callId: `c${i}` })
    const reads = w.ownerReads()
    expect(reads).toHaveLength(3)
    expect(reads.every((r) => r.detail?.scope === 'raw')).toBe(true)
    expect(w.rows().filter((r) => r.kind === 'acl.owner-access')).toHaveLength(3)
  })

  test('a detail of one call names the call', () => {
    const w = world()
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail', callId: 'call-9' })
    expect(w.ownerReads()[0]?.detail).toMatchObject({ scope: 'call', callId: 'call-9' })
  })

  test('the owner reading a room session writes one row per active member (room named, no text)', () => {
    const w = world()
    w.rights.authorize(w.owner, roomSession, { purpose: 'detail' })
    const reads = w.ownerReads()
    expect(reads.map((r) => r.detail?.subject).sort()).toEqual(['ana', 'bob'])
    expect(reads.every((r) => r.detail?.room === 'r1')).toBe(true)
    const owners = w
      .rows()
      .filter((r) => r.kind === 'acl.owner-access')
      .map((r) => r.detail?.owner)
    expect(owners.sort()).toEqual(['ana', 'bob'])
  })

  test('a guest session writes the owner-read row with no subject and no acl.owner-access, once per window', () => {
    const w = world()
    w.rights.authorize(w.owner, guestSession, { purpose: 'detail' })
    w.rights.authorize(w.owner, guestSession, { purpose: 'detail' })
    const reads = w.ownerReads()
    expect(reads).toHaveLength(1)
    expect(reads[0]?.detail?.subject).toBeUndefined()
    expect(LogsOwnerReadAuditDetailSchema.safeParse(reads[0]?.detail).success).toBe(true)
    expect(w.rows().filter((r) => r.kind === 'acl.owner-access')).toHaveLength(0)
  })

  test('a list of guest sessions writes one owner-read row per window, not one per session', () => {
    const w = world()
    const guests: LogsSession[] = ['guest:a', 'guest:b', 'guest:c'].map((id) => ({
      id,
      kind: 'guest',
    }))
    for (const guest of guests) w.rights.authorize(w.owner, guest, { purpose: 'list' })
    expect(w.ownerReads()).toHaveLength(1)
    expect(w.ownerReads()[0]?.detail).toMatchObject({ scope: 'list' })
    // a detail of one guest session keeps its own window
    w.rights.authorize(w.owner, guests[0] as LogsSession, { purpose: 'detail' })
    expect(w.ownerReads()).toHaveLength(2)
    // after the window a list writes again
    w.advance(ACL_AUDIT_WINDOW_MS + 1)
    w.rights.authorize(w.owner, guests[1] as LogsSession, { purpose: 'list' })
    expect(w.ownerReads()).toHaveLength(3)
  })

  test('a denied read writes nothing, and a member reading another person writes nothing', () => {
    const w = world()
    expect(w.rights.authorize(w.reader('bob'), chatOf('ana'), { purpose: 'raw' })).toBe('deny')
    expect(w.rights.authorize(w.reader('cy'), roomSession, { purpose: 'raw' })).toBe('deny')
    expect(w.rows()).toHaveLength(0)
  })

  test('audit.mine shows the person the owner-read row about their session', () => {
    const w = world()
    w.rights.authorize(w.owner, chatOf('ana'), { purpose: 'detail' })
    const mine = listMine(w.repo, 'ana', {}, (actor) => actor)
    const kinds = mine.map((m) => m.kind)
    expect(kinds).toContain('logs.owner-read')
    expect(mine.find((m) => m.kind === 'logs.owner-read')?.summary).toBe(
      'the owner looked at one of your sessions in the activity logs',
    )
    // the other member sees none of it
    expect(listMine(w.repo, 'bob', {}, (actor) => actor)).toHaveLength(0)
  })

  test('the owner reading their own session writes no audit row at all', () => {
    const w = world()
    w.rights.authorize(w.owner, chatOf('boss'), { purpose: 'raw' })
    expect(w.rows()).toHaveLength(0)
  })
})
