/**
 * P30.2.7, the leak and rights test of phase 2 (docs/specs/corpus-callosum.md "Tests", ADR-0020 §2 and §4): two rooms and a
 * person in neither. Every `rooms.*` procedure and the activity feed are read as each person, and a sentinel said in room A
 * must appear in no response and no feed record of a non-member or of a member of room B. The owner's read of a room they
 * are not in is the one allowed path: it is audited (`room.read`, `acl.owner-access`) and the initiator and the members active
 * then see the row through `audit.mine`. Real core over TCP and the socket, the same boot as `procedures.test.ts`; the feed is read as an SSE stream.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

// The sentinels are built at runtime (gitleaks and the guest leak test both prefer it); each one is unique to this run.
const SAY_A = `zq${crypto.randomUUID().replaceAll('-', '')}`
const SAY_B = `zq${crypto.randomUUID().replaceAll('-', '')}`
const SAY_AFTER_REMOVAL = `zq${crypto.randomUUID().replaceAll('-', '')}`

type Client = ReturnType<BootedCore['tcp']>
/** The people of the test: ana starts room A (bob is in it), cy starts room B (dan is in it), eve is in neither. */
const PEOPLE = ['ana', 'bob', 'cy', 'dan', 'eve', 'owner'] as const
type Name = (typeof PEOPLE)[number]

let b: BootedCore
let db: Sqlite
const clients = new Map<Name, Client>()
const tokens = new Map<Name, string>()
const ids = new Map<Name, string>()
let roomA = ''
let roomB = ''
let seqAfterRemoval = 0

const client = (name: Name): Client => {
  const found = clients.get(name)
  if (found === undefined) throw new Error(`no client for ${name}`)
  return found
}
const tokenOf = (name: Name): string => {
  const found = tokens.get(name)
  if (found === undefined) throw new Error(`no token for ${name}`)
  return found
}

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  for (const name of ['ana', 'bob', 'cy', 'dan', 'eve'] as const) {
    await b.local.rpc.admin.people.add({ username: name })
    ids.set(name, (await b.local.rpc.admin.people.get({ person: name })).id)
  }
  ids.set('owner', (await b.local.rpc.admin.people.get({ person: 'owner' })).id)
  await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
  await b.local.rpc.admin.people.grant({ person: 'cy', capability: 'rooms.start' })
  for (const name of PEOPLE) {
    const { token } = await createCredential(credentialsRepo(db), {
      personId: ids.get(name) as string,
      kind: 'token',
      label: `${name}-isolation`,
    })
    tokens.set(name, token)
    clients.set(name, b.tcp(token))
  }
})
afterAll(async () => {
  db.close()
  await b.stop()
})

describe('two rooms', () => {
  test('ana and bob talk in room A; cy and dan talk in room B', async () => {
    roomA = (await client('ana').rpc.rooms.start({ name: 'Room A', invite: ['bob'] })).room.id
    await client('bob').rpc.rooms.accept({ roomId: roomA })
    await client('ana').rpc.rooms.say({ roomId: roomA, text: SAY_A })

    roomB = (await client('cy').rpc.rooms.start({ name: 'Room B', invite: ['dan'] })).room.id
    expect(roomB).not.toBe(roomA)
    await client('dan').rpc.rooms.accept({ roomId: roomB })
    await client('cy').rpc.rooms.say({ roomId: roomB, text: SAY_B })

    // the members read their own room's line
    const bobSees = await client('bob').rpc.rooms.events({ roomId: roomA, after: 0, limit: 200 })
    expect(bobSees.events.some((e) => e.text === SAY_A)).toBe(true)
    const danSees = await client('dan').rpc.rooms.events({ roomId: roomB, after: 0, limit: 200 })
    expect(danSees.events.some((e) => e.text === SAY_B)).toBe(true)
  })
})

/** One call as text: its response, or its error code, message and data. Never throws. */
async function outcome(call: Promise<unknown>): Promise<string> {
  const value = await call.then(
    (v) => v,
    (e: { code?: string; message?: string; data?: unknown }) => ({
      error: e.code,
      message: e.message,
      data: e.data,
    }),
  )
  return JSON.stringify(value) ?? ''
}

/**
 * Every room procedure for one room. The state-changing ones are refused for a non-member and change nothing, so they
 * can run against a room a person is not in.
 */
function roomCalls(name: Name, roomId: string): Promise<string>[] {
  const c = client(name)
  return [
    outcome(c.rpc.rooms.get({ roomId })),
    outcome(c.rpc.rooms.events({ roomId, after: 0, limit: 200 })),
    outcome(c.rpc.rooms.files({ roomId })),
    outcome(c.rpc.rooms.say({ roomId, text: 'probe' })),
    outcome(c.rpc.rooms.accept({ roomId })),
    outcome(c.rpc.rooms.decline({ roomId })),
    outcome(c.rpc.rooms.invite({ roomId, invite: ['eve'] })),
    outcome(c.rpc.rooms.leave({ roomId })),
    outcome(c.rpc.rooms.remove({ roomId, person: 'bob' })),
    outcome(c.rpc.rooms.end({ roomId })),
  ]
}

/** The procedures that name no room: the lists, the confirmation stub, the settings and, for a person without the capability, `start`. */
function sharedCalls(name: Name): Promise<string>[] {
  const c = client(name)
  return [
    outcome(c.rpc.rooms.list({})),
    outcome(c.rpc.rooms.confirm({ requestId: 'no-such-request', approved: true })),
    outcome(c.rpc.rooms.settings.get()),
    ...(name === 'cy' ? [] : [outcome(c.rpc.rooms.start({ invite: ['eve'] }))]),
  ]
}

/** One SSE record of the activity feed, parsed. */
interface FeedRecord {
  type: string
  payload: Record<string, unknown> | null
  sessionId: string | null
}
interface Feed {
  /** The raw stream text: every byte the person's feed sent. */
  raw: string
  records: FeedRecord[]
}

/** The activity feed of a person from the start, read until it goes quiet (the stream stays open). */
async function feedOf(name: Name): Promise<Feed> {
  const res = await fetch(`${b.url}/activity/stream?after=0`, {
    headers: { authorization: `Bearer ${tokenOf(name)}` },
  })
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  const deadline = Date.now() + 3000
  while (reader !== undefined && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(400).then(() => undefined)])
    if (chunk === undefined || chunk.done) break
    raw += decoder.decode(chunk.value, { stream: true })
  }
  await reader?.cancel()
  const records: FeedRecord[] = []
  for (const block of raw.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('')
    if (data === '') continue
    try {
      records.push(JSON.parse(data) as FeedRecord)
    } catch {
      // a block cut by the end of a read: the raw text is still checked above
    }
  }
  return { raw, records }
}

describe('non-members read nothing of room A', () => {
  test('cy (in B), dan (in B) and eve (in neither) get no text and no id of A from any rooms.* procedure', async () => {
    for (const name of ['cy', 'dan', 'eve'] as const) {
      const answers = await Promise.all([...roomCalls(name, roomA), ...sharedCalls(name)])
      const text = answers.join('\n')
      expect(text).not.toContain(SAY_A)
      expect(text).not.toContain(roomA)
      // the room-scoped calls answer as good as absent: NOT_FOUND (or FORBIDDEN for the capability), never the room
      const roomScoped = answers.slice(0, 10)
      expect(roomScoped.every((a) => /NOT_FOUND|FORBIDDEN/.test(a))).toBe(true)
    }
  })

  test('the members of A get nothing of room B, and the members of B and eve get nothing of room A', async () => {
    for (const name of ['ana', 'bob', 'eve'] as const) {
      const text = (await Promise.all(roomCalls(name, roomB))).join('\n')
      expect(text).not.toContain(SAY_B)
      expect(text).not.toContain(roomB)
    }
    for (const name of ['cy', 'dan', 'eve'] as const) {
      const text = (await Promise.all(roomCalls(name, roomA))).join('\n')
      expect(text).not.toContain(SAY_A)
    }
  })

  test('the feed of every non-member holds no text of A and no record that names room A', async () => {
    for (const name of ['cy', 'dan', 'eve'] as const) {
      const feed = await feedOf(name)
      expect(feed.raw).not.toContain(SAY_A)
      expect(feed.raw).not.toContain(roomA)
    }
  })

  test('a member of A gets room.event records for A, and the record never carries the text', async () => {
    const bob = await feedOf('bob')
    expect(bob.records.some((r) => r.type === 'room.event' && r.payload?.roomId === roomA)).toBe(
      true,
    )
    expect(bob.raw).not.toContain(SAY_A)
    expect((await feedOf('ana')).raw).not.toContain(SAY_A)
  })
})

describe('the owner reads a room they are not in', () => {
  test('the owner reads the transcript of A (the text is there), and the read is audited', async () => {
    const read = await client('owner').rpc.rooms.events({ roomId: roomA, after: 0, limit: 200 })
    expect(read.events.some((e) => e.text === SAY_A)).toBe(true)
    // the owner's feed holds the room lifecycle records only: never the text
    expect((await feedOf('owner')).raw).not.toContain(SAY_A)

    const audit = await b.local.rpc.admin.audit.list({ limit: 500 })
    expect(audit.some((e) => e.kind === 'room.read' && e.detail?.roomId === roomA)).toBe(true)
    expect(
      audit.some((e) => e.kind === 'acl.owner-access' && JSON.stringify(e.detail).includes(roomA)),
    ).toBe(true)
  })

  test('the initiator and every member of A active at the read see the room.read row through audit.mine; an outsider does not', async () => {
    // the row names the initiator (`owner`) and the active members (`members`), never the transcript
    const ana = await client('ana').rpc.admin.audit.mine({ limit: 200 })
    expect(ana.find((e) => e.kind === 'room.read')?.summary).toBe(
      'the owner read the transcript of a room you started',
    )
    // bob is a plain member of A (not the initiator): he sees the row, worded for a member
    const bob = await client('bob').rpc.admin.audit.mine({ limit: 200 })
    expect(bob.find((e) => e.kind === 'room.read')?.summary).toBe(
      'the owner read the transcript of a room you were in',
    )
    expect(JSON.stringify(bob)).not.toContain(SAY_A)
    // eve is in neither room: the row is not hers
    const eve = await client('eve').rpc.admin.audit.mine({ limit: 200 })
    expect(eve.some((e) => e.kind === 'room.read')).toBe(false)
  })
})

describe('a removed member cannot read after the removal', () => {
  test('ana removes bob; a line said after the removal reaches neither bob nor his feed', async () => {
    await client('ana').rpc.rooms.remove({ roomId: roomA, person: 'bob' })
    const after = await client('ana').rpc.rooms.say({ roomId: roomA, text: SAY_AFTER_REMOVAL })
    seqAfterRemoval = after.seq

    const events = await client('bob').rpc.rooms.events({ roomId: roomA, after: 0, limit: 200 })
    expect(events.events.some((e) => e.text === SAY_AFTER_REMOVAL)).toBe(false)
    expect(events.events.every((e) => e.seq < seqAfterRemoval)).toBe(true)
    expect(
      await outcome(client('bob').rpc.rooms.say({ roomId: roomA, text: 'still here' })),
    ).toContain('FORBIDDEN')
    const view = await client('bob').rpc.rooms.get({ roomId: roomA })
    expect(view.you).toMatchObject({ status: 'removed', canSpeak: false })

    const feed = await feedOf('bob')
    expect(feed.raw).not.toContain(SAY_AFTER_REMOVAL)
    const late = feed.records.filter(
      (r) =>
        r.type === 'room.event' &&
        r.payload?.roomId === roomA &&
        Number(r.payload?.seq) >= seqAfterRemoval,
    )
    expect(late).toEqual([])
  })
})

describe('a suspended person leaves their rooms', () => {
  test('suspending dan (a member of B) ends the membership with reason suspended, and the owner sees it', async () => {
    await b.local.rpc.admin.people.suspend({ person: 'dan' })
    const view = await b.local.rpc.rooms.get({ roomId: roomB })
    expect(view.members.find((m) => m.person.id === ids.get('dan'))?.status).toBe('removed')
    const audit = await b.local.rpc.admin.audit.list({ limit: 500 })
    expect(
      audit.some(
        (r) =>
          r.kind === 'room.remove' &&
          r.detail?.roomId === roomB &&
          r.detail?.subject === ids.get('dan') &&
          r.detail?.reason === 'suspended',
      ),
    ).toBe(true)
    // a suspended person's credential is refused: the room is out of reach
    expect(await outcome(client('dan').rpc.rooms.get({ roomId: roomB }))).toContain('UNAUTHORIZED')
  })
})
