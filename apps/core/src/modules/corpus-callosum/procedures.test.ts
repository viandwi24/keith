import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { credentialsRepo, openDatabase, REQUEST_TTL_MS, roomsRepo, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'
import { roomWorkspaceDir } from './workspace.ts'

// The `rooms.*` procedures over a real core (docs/specs/corpus-callosum.md "RPC"): the owner, a member with the capability, a
// member without it and a person in no room. Every refusal is the RPC code, FORBIDDEN carries its reason in `data.reason`.
let b: BootedCore
let db: Sqlite
type Client = ReturnType<BootedCore['tcp']>
let ana: Client
let bob: Client
let cy: Client
let anaId: string
let cyId: string
let ownerId: string
let roomId: string

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  for (const username of ['ana', 'bob', 'cy']) await b.local.rpc.admin.people.add({ username })
  await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
  anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  cyId = (await b.local.rpc.admin.people.get({ person: 'cy' })).id
  ownerId = (await b.local.rpc.admin.people.get({ person: 'owner' })).id
  ana = await memberOf('ana')
  bob = await memberOf('bob')
  cy = await memberOf('cy')
})
afterAll(async () => {
  db.close()
  await b.stop()
})

async function memberOf(name: string): Promise<Client> {
  const person = await b.local.rpc.admin.people.get({ person: name })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: `${name}-rooms`,
  })
  return b.tcp(token)
}

/** The RPC code of a refusal (FORBIDDEN with its reason, when it has one); `ok` when the call returns. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )
const auditRows = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)
const NO_SUCH_ROOM = '11111111-1111-4111-8111-111111111111'

describe('rooms.start and the capability', () => {
  test('a member without rooms.start is refused FORBIDDEN; the owner starts a room and holds the header', async () => {
    expect(await refusal(bob.rpc.rooms.start({ invite: ['cy'] }))).toBe('FORBIDDEN')
    const view = await b.local.rpc.rooms.start({ name: 'Planning', invite: ['ana', 'cy'] })
    roomId = view.room.id
    expect(view.room).toMatchObject({ name: 'Planning', state: 'open' })
    expect(view.you).toEqual({
      status: 'active',
      isInitiator: true,
      canSpeak: true,
      canControl: true,
    })
    expect(view.members.find((m) => m.person.id === anaId)?.status).toBe('invited')
    expect(existsSync(roomWorkspaceDir(b.dir, roomId))).toBe(true)
  })
})

describe('visibility', () => {
  test('a person in no room gets NOT_FOUND for the room, its transcript, its files and a say', async () => {
    expect(await refusal(bob.rpc.rooms.get({ roomId }))).toBe('NOT_FOUND')
    expect(await refusal(bob.rpc.rooms.events({ roomId }))).toBe('NOT_FOUND')
    expect(await refusal(bob.rpc.rooms.files({ roomId }))).toBe('NOT_FOUND')
    expect(await refusal(bob.rpc.rooms.say({ roomId, text: 'hi' }))).toBe('NOT_FOUND')
    expect(await refusal(bob.rpc.rooms.get({ roomId: NO_SUCH_ROOM }))).toBe('NOT_FOUND')
  })

  test('a person in no room lists no rooms; the owner lists the header of every room, no text', async () => {
    expect((await bob.rpc.rooms.list({})).rooms).toEqual([])
    const { rooms } = await b.local.rpc.rooms.list({})
    const header = rooms.find((r) => r.room.id === roomId)
    expect(header).toBeDefined()
    expect(Object.keys(header ?? {}).sort()).toEqual(['inviteExpiresAt', 'members', 'room'])
    expect(header?.inviteExpiresAt).toBeNull()
  })

  test('the invitee reads the room as invited and cannot speak before accepting', async () => {
    const view = await ana.rpc.rooms.get({ roomId })
    expect(view.you).toMatchObject({ status: 'invited', canSpeak: false, canControl: false })
    expect(await refusal(ana.rpc.rooms.say({ roomId, text: 'too early' }))).toBe(
      'FORBIDDEN:not-member',
    )
  })
})

describe('accept, decline and the lines', () => {
  test('accept moves the room to active; a second answer is CONFLICT; decline before accept works', async () => {
    const accepted = await ana.rpc.rooms.accept({ roomId })
    expect(accepted.room.state).toBe('active')
    expect(accepted.you).toMatchObject({ status: 'active', canSpeak: true, canControl: false })
    expect(await refusal(ana.rpc.rooms.accept({ roomId }))).toBe('CONFLICT')
    await cy.rpc.rooms.decline({ roomId })
    expect(await refusal(cy.rpc.rooms.accept({ roomId }))).toBe('CONFLICT')
  })

  test('say stores the line, reports whether it addresses Keith, and the transcript carries the name', async () => {
    const plain = await ana.rpc.rooms.say({ roomId, text: 'hello room' })
    expect(plain).toEqual({ seq: expect.any(Number), queued: false, addressed: false })
    const addressed = await ana.rpc.rooms.say({ roomId, text: '@keith what is the plan?' })
    expect(addressed.addressed).toBe(true)
    expect(addressed.seq).toBeGreaterThan(plain.seq)
    const replied = await ana.rpc.rooms.say({ roomId, text: 'and this', replyToKeith: true })
    expect(replied.addressed).toBe(true)

    const { events, nextAfter } = await b.local.rpc.rooms.events({ roomId, after: 0 })
    const line = events.find((e) => e.text === 'hello room')
    expect(line).toMatchObject({ kind: 'say', speaker: { id: anaId, name: 'ana' } })
    expect(nextAfter).toBe(Math.max(...events.map((e) => e.seq)))
    const after = await ana.rpc.rooms.events({ roomId, after: plain.seq })
    expect(after.events.every((e) => e.seq > plain.seq)).toBe(true)
  })

  test('a member who is not active (cy declined) cannot say; the owner reads the header and the transcript', async () => {
    expect(await refusal(cy.rpc.rooms.say({ roomId, text: 'hi' }))).toBe('FORBIDDEN:not-member')
    const view = await b.local.rpc.rooms.get({ roomId })
    expect(view.you).toMatchObject({ status: 'active', canControl: true })
  })
})

describe('control', () => {
  test('an active member who is not the initiator is refused the controls with not-initiator', async () => {
    expect(await refusal(ana.rpc.rooms.remove({ roomId, person: 'cy' }))).toBe(
      'FORBIDDEN:not-initiator',
    )
    expect(await refusal(ana.rpc.rooms.end({ roomId }))).toBe('FORBIDDEN:not-initiator')
  })

  test('the owner removes a member: the member can no longer speak and is told by the transcript', async () => {
    await b.local.rpc.rooms.remove({ roomId, person: 'ana' })
    expect(await refusal(ana.rpc.rooms.say({ roomId, text: 'still here?' }))).toBe(
      'FORBIDDEN:not-member',
    )
    const rows = await auditRows('room.remove')
    expect(rows.some((r) => r.detail?.roomId === roomId && r.detail?.subject === anaId)).toBe(true)
  })

  test('confirm answers NOT_FOUND for a request that does not exist', async () => {
    expect(await refusal(b.local.rpc.rooms.confirm({ requestId: 'nope', approved: true }))).toBe(
      'NOT_FOUND',
    )
  })

  test('the owner ends the room; a line after the end is PRECONDITION_FAILED; the end is audited', async () => {
    const ended = await b.local.rpc.rooms.end({ roomId, reason: 'done' })
    expect(ended).toEqual({ ok: true })
    expect(await refusal(b.local.rpc.rooms.say({ roomId, text: 'late' }))).toBe(
      'PRECONDITION_FAILED',
    )
    const view = await b.local.rpc.rooms.get({ roomId })
    expect(view.room).toMatchObject({ state: 'ended', endReason: 'done' })
    expect(await auditRows('room.end')).not.toHaveLength(0)
  })
})

describe('the owner reads a room she is not in', () => {
  test('a room started by a member: the owner reads the transcript and the read is audited', async () => {
    const started = await ana.rpc.rooms.start({ name: 'Side talk', invite: ['cy'] })
    await cy.rpc.rooms.accept({ roomId: started.room.id })
    const events = await b.local.rpc.rooms.events({ roomId: started.room.id })
    expect(events.events.some((e) => e.kind === 'join' && e.speaker?.id === cyId)).toBe(true)
    const reads = await auditRows('room.read')
    expect(reads.some((r) => r.detail?.roomId === started.room.id)).toBe(true)
    // the owner is not in the room: the header is fine, the files are not (members only)
    expect(await refusal(b.local.rpc.rooms.files({ roomId: started.room.id }))).toBe('NOT_FOUND')
    roomId = started.room.id
  })

  test('a member of the room lists its folder (empty), an invitee who is not in it is NOT_FOUND', async () => {
    expect(await cy.rpc.rooms.files({ roomId })).toEqual({ files: [] })
    expect(await refusal(bob.rpc.rooms.files({ roomId }))).toBe('NOT_FOUND')
  })
})

describe('suspension ends the memberships', () => {
  test('suspending a member removes them from their active room with reason suspended', async () => {
    await b.local.rpc.admin.people.suspend({ person: 'cy' })
    const view = await b.local.rpc.rooms.get({ roomId })
    expect(view.members.find((m) => m.person.id === cyId)?.status).toBe('removed')
    const rows = await auditRows('room.remove')
    expect(
      rows.some(
        (r) =>
          r.detail?.roomId === roomId &&
          r.detail?.subject === cyId &&
          r.detail?.reason === 'suspended',
      ),
    ).toBe(true)
    await b.local.rpc.admin.people.reactivate({ person: 'cy' })
  })
})

describe('owner settings', () => {
  test('a member reads the six settings and cannot set them; the owner sets them with a step-up', async () => {
    expect(await ana.rpc.rooms.settings.get()).toEqual({
      maxMembers: 8,
      inviteTtlMinutes: 10,
      maxTurnsPerHour: 60,
      maxQueue: 10,
      windowMinutes: 30,
      windowEvents: 200,
    })
    expect(await refusal(ana.rpc.rooms.settings.set({ maxMembers: 4 }))).toBe('FORBIDDEN')

    const { token } = await createCredential(credentialsRepo(db), {
      personId: ownerId,
      kind: 'token',
      label: 'owner-rooms-tcp',
    })
    const tcp = b.tcp(token)
    expect(await refusal(tcp.rpc.rooms.settings.set({ maxMembers: 4 }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, token)
    const after = await tcp.rpc.rooms.settings.set({ maxMembers: 4, maxQueue: 5 })
    expect(after).toMatchObject({ maxMembers: 4, maxQueue: 5, windowEvents: 200 })
    expect(await refusal(tcp.rpc.rooms.settings.set({ maxMembers: 1 }))).toBe('BAD_REQUEST')
    expect(await refusal(tcp.rpc.rooms.settings.set({}))).toBe('BAD_REQUEST')
    const rows = await auditRows('settings.rooms.set')
    expect(rows.at(-1)?.detail).toEqual({
      from: { maxMembers: 8, maxQueue: 10 },
      to: { maxMembers: 4, maxQueue: 5 },
    })
    await b.local.rpc.rooms.settings.set({ maxMembers: 8, maxQueue: 10 })
  })
})

describe('rooms.confirm (P30.4.1): the person a request names, or the owner', () => {
  // the owner ends every room still open, so ana (one active room at a time) can start a new one
  const endOpenRooms = async () => {
    for (const row of (await b.local.rpc.rooms.list({})).rooms)
      if (row.room.state !== 'ended') await b.local.rpc.rooms.end({ roomId: row.room.id })
  }
  beforeEach(endOpenRooms)
  // `cy` is suspended above; a fresh member takes the removal
  beforeAll(async () => {
    await b.local.rpc.admin.people.add({ username: 'dee' })
  })

  test('another member is FORBIDDEN; the initiator confirms the removal; the owner confirms another', async () => {
    const dee = await memberOf('dee')
    const deeId = (await b.local.rpc.admin.people.get({ person: 'dee' })).id
    const started = await ana.rpc.rooms.start({ name: 'Confirm', invite: ['bob', 'dee'] })
    const id = started.room.id
    await bob.rpc.rooms.accept({ roomId: id })
    await dee.rpc.rooms.accept({ roomId: id })
    const repo = roomsRepo(db)
    const at = Date.now()
    const removal = repo.createRequest({
      id: 'rpc-remove-1',
      roomId: id,
      person: anaId,
      kind: 'remove',
      payload: { target: deeId },
      createdAt: at,
      expiresAt: at + REQUEST_TTL_MS,
    })
    expect(await refusal(bob.rpc.rooms.confirm({ requestId: removal.id, approved: true }))).toBe(
      'FORBIDDEN:not-initiator',
    )
    expect(await ana.rpc.rooms.confirm({ requestId: removal.id, approved: true })).toEqual({
      status: 'confirmed',
    })
    expect(
      (await ana.rpc.rooms.get({ roomId: id })).members.find((m) => m.person.id === deeId),
    ).toMatchObject({ status: 'removed' })
    expect(await refusal(ana.rpc.rooms.confirm({ requestId: removal.id, approved: true }))).toBe(
      'CONFLICT',
    )
  })

  test('an expired request is PRECONDITION_FAILED and changes nothing', async () => {
    const started = await ana.rpc.rooms.start({ name: 'Expired', invite: ['bob'] })
    await bob.rpc.rooms.accept({ roomId: started.room.id })
    const past = Date.now() - 2 * REQUEST_TTL_MS
    roomsRepo(db).createRequest({
      id: 'rpc-end-old',
      roomId: started.room.id,
      person: anaId,
      kind: 'end',
      createdAt: past,
      expiresAt: past + REQUEST_TTL_MS,
    })
    expect(await refusal(ana.rpc.rooms.confirm({ requestId: 'rpc-end-old', approved: true }))).toBe(
      'PRECONDITION_FAILED',
    )
    expect((await ana.rpc.rooms.get({ roomId: started.room.id })).room.state).toBe('active')
  })
})

describe('rooms.get reads presence, the indicator and the requests the caller may confirm (P30.5.1)', () => {
  const endOpenRooms = async () => {
    for (const row of (await b.local.rpc.rooms.list({})).rooms)
      if (row.room.state !== 'ended') await b.local.rpc.rooms.end({ roomId: row.room.id })
  }
  let eve: Client
  let eveId: string
  let bobPid: string
  beforeEach(endOpenRooms)
  beforeAll(async () => {
    await b.local.rpc.admin.people.add({ username: 'eve' })
    eveId = (await b.local.rpc.admin.people.get({ person: 'eve' })).id
    bobPid = (await b.local.rpc.admin.people.get({ person: 'bob' })).id
    eve = await memberOf('eve')
  })
  afterAll(async () => {
    await b.local.rpc.rooms.settings.set({ inviteTtlMinutes: 10 })
  })

  test('presence: an active member reads the disclosed line of the others; an invitee and a non-member read `not shared`', async () => {
    const started = await ana.rpc.rooms.start({ name: 'Presence', invite: ['bob', 'eve'] })
    const id = started.room.id
    await bob.rpc.rooms.accept({ roomId: id })
    const view = await ana.rpc.rooms.get({ roomId: id })
    const presenceOf = (personId: string) =>
      view.members.find((m) => m.person.id === personId)?.presence
    // ana reads bob's line (bob is active; the default for members is the state level, "Bob is ...")
    expect(presenceOf(bobPid)).toMatch(/^bob is /)
    // ana reads herself in full, and eve (invited, not active) is not shared
    expect(presenceOf(anaId)).toMatch(/^ana is /)
    expect(presenceOf(eveId)).toBe('not shared')
    // bob is active, so he reads the same of the active members
    const asBob = await bob.rpc.rooms.get({ roomId: id })
    expect(asBob.members.find((m) => m.person.id === anaId)?.presence).toMatch(/^ana is /)
    // the invitee who has not answered reads no presence and no indicator
    const asEve = await eve.rpc.rooms.get({ roomId: id })
    expect(asEve.members.every((m) => m.presence === 'not shared')).toBe(true)
    expect(asEve.indicator).toEqual({ kind: 'idle' })
  })

  test('the indicator is idle until a turn sets it; the owner, not a member, reads presence not shared and idle', async () => {
    const started = await ana.rpc.rooms.start({ name: 'Indicator', invite: ['bob'] })
    const id = started.room.id
    await bob.rpc.rooms.accept({ roomId: id })
    expect((await ana.rpc.rooms.get({ roomId: id })).indicator).toEqual({ kind: 'idle' })
    const asOwner = await b.local.rpc.rooms.get({ roomId: id })
    expect(asOwner.you.status).toBeNull()
    expect(asOwner.indicator).toEqual({ kind: 'idle' })
    expect(asOwner.members.every((m) => m.presence === 'not shared')).toBe(true)
  })

  test('pending: the person named in a post sees it, the owner does not; a remove is seen by its confirmer and the owner', async () => {
    const started = await ana.rpc.rooms.start({ name: 'Pending', invite: ['bob', 'eve'] })
    const id = started.room.id
    await bob.rpc.rooms.accept({ roomId: id })
    await eve.rpc.rooms.accept({ roomId: id })
    const repo = roomsRepo(db)
    const at = Date.now()
    repo.createRequest({
      id: 'view-post-bob',
      roomId: id,
      person: bobPid,
      kind: 'post',
      payload: { text: 'my line' },
      createdAt: at,
      expiresAt: at + REQUEST_TTL_MS,
    })
    repo.createRequest({
      id: 'view-remove-eve',
      roomId: id,
      person: anaId,
      kind: 'remove',
      payload: { target: eveId },
      createdAt: at + 1,
      expiresAt: at + REQUEST_TTL_MS,
    })
    const ids = async (c: Client) =>
      (await c.rpc.rooms.get({ roomId: id })).pending.map((r) => r.id)
    expect(await ids(bob)).toEqual(['view-post-bob'])
    expect(await ids(ana)).toEqual(['view-remove-eve'])
    // the owner confirms a remove for any room, never a post: only the remove is listed
    expect(await ids(b.local)).toEqual(['view-remove-eve'])
    // eve is named by neither request
    expect(await ids(eve)).toEqual([])
    // an expired request is not listed
    repo.createRequest({
      id: 'view-remove-old',
      roomId: id,
      person: anaId,
      kind: 'remove',
      payload: { target: eveId },
      createdAt: at - 2 * REQUEST_TTL_MS,
      expiresAt: at - REQUEST_TTL_MS,
    })
    expect(await ids(ana)).toEqual(['view-remove-eve'])
  })

  test('rooms.list carries the invitation expiry from rooms.inviteTtlMinutes, null when not invited', async () => {
    await b.local.rpc.rooms.settings.set({ inviteTtlMinutes: 5 })
    const started = await ana.rpc.rooms.start({ name: 'Ttl', invite: ['eve'] })
    const invited = (await eve.rpc.rooms.list({})).rooms.find((r) => r.room.id === started.room.id)
    const row = invited?.members.find((m) => m.person.id === eveId)
    expect(row?.status).toBe('invited')
    expect(invited?.inviteExpiresAt).toBe((row?.invitedAt ?? Number.NaN) + 5 * 60_000)
    const asAna = (await ana.rpc.rooms.list({})).rooms.find((r) => r.room.id === started.room.id)
    expect(asAna?.inviteExpiresAt).toBeNull()
  })
})
