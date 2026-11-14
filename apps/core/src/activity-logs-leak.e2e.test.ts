/**
 * P36.4.4, the leak and rights test of the activity logs (docs/specs/activity-logs.md "Rights" and "RPC"; ADR-0032 §8; ADR-0020
 * §2 and §4). The owner, ana and bob. ana and bob chat in their front sessions; ana starts a room with the owner while bob stays
 * outside; ana types a fake secret. Every answer bob gets from `logs.*` is checked for ana's marker and ana's ids, and so are
 * bob's captured prompts, his `audit.mine` rows and the feed rows of his session. The owner's reads of ana's sessions are audited
 * (the summary, no content); the owner's read of their own session is not; a raw read is audited every time. Real core over TCP
 * and the local socket, the same boot as `chat-context-leak.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { roomSessionId } from './modules/corpus-callosum/index.ts'
import { loadConfig } from './platform/config.ts'
import { frontSessionId } from './platform/sessions.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

// Built at runtime (gitleaks flags key-shaped literals). The secret matches the secret guard's `keith_` pattern.
const hex = (): string => crypto.randomUUID().replaceAll('-', '')
const MARK_A = `zqana${hex()}`
const MARK_B = `zqbob${hex()}`
const SECRET_A = ['keith', hex()].join('_')
const OWNER = 'owner'
const ROOM_NAME = 'Logs leak'
const PORT_LABEL = 'activity-logs-leak'

/** Who is speaking now: the test sets it before it acts, so each captured prompt knows whose call it was. */
let current: 'owner' | 'ana' | 'bob' = 'owner'
const seen: Array<{ who: string; prompt: string }> = []
const model = testProvider({
  id: 'leak-logs',
  models: { m: Array.from({ length: 12 }, (_, i) => ({ text: `Noted ${i}.` })) },
  before: async (prompt) => {
    seen.push({ who: current, prompt })
  },
})

let b: BootedCore
let db: Sqlite
const tokens = new Map<'ana' | 'bob', string>()
const ids = new Map<'owner' | 'ana' | 'bob', string>([['owner', OWNER]])
let roomId = ''
let anaCallId = ''
let roomCallId = ''
/** The room's session: the room starts at generation 1 (`roomSessionId`, the session of its turns). */
const roomSession = (): string => roomSessionId(roomId, 1)
/** Every body bob receives from `logs.*` (success or error): checked for ana's marker and ids at the end. */
const bobAnswers: string[] = []

const tokenClient = (name: 'ana' | 'bob'): KeithClient => {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}
const idOf = (name: 'owner' | 'ana' | 'bob'): string => ids.get(name) as string
const frontOf = (name: 'owner' | 'ana' | 'bob'): string => frontSessionId(idOf(name), 0)

/** One answer as text and its error code, or null for a success. Never throws. */
async function answer(call: Promise<unknown>): Promise<{ code: string | null; body: string }> {
  try {
    const value = await call
    return { code: null, body: JSON.stringify(value) ?? '' }
  } catch (error) {
    const e = error as { code?: string; message?: string }
    return { code: e.code ?? 'ERROR', body: JSON.stringify({ code: e.code, message: e.message }) }
  }
}
/** A call bob makes: the answer is kept for the leak scan at the end. */
async function asBob(call: Promise<unknown>): Promise<{ code: string | null; body: string }> {
  const a = await answer(call)
  bobAnswers.push(a.body)
  return a
}

/** Sends one message in the person's front session and waits for the turn to end. */
async function talk(name: 'owner' | 'ana' | 'bob', text: string): Promise<void> {
  current = name
  const client = name === 'owner' ? b.local : tokenClient(name)
  for await (const _ of client.reply(text, frontOf(name))) {
    // drain: the stream ends with the turn
  }
}

/** The newest generation (call) of a session, read by the owner (its read is audited; used for ids only). */
async function latestCall(sessionId: string): Promise<string> {
  const { generations } = await b.local.rpc.logs.session({ id: sessionId })
  const last = generations.at(-1)
  if (last === undefined) throw new Error(`no call in ${sessionId}`)
  return last.id
}

/** The `logs.owner-read` rows that carry a `scope` (decoded from the audit detail). */
function ownerReadScopes(): string[] {
  const rows = db.query("SELECT detail FROM audit_events WHERE kind = 'logs.owner-read'").all() as {
    detail: string
  }[]
  return rows.map((r) => (JSON.parse(r.detail) as { scope: string }).scope)
}

beforeAll(async () => {
  b = await bootCore({}, { definitions: [model as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'leak-logs' })
  await owner.models.roles.set({ role: 'front', ref: 'leak-logs:m' })
  for (const name of ['ana', 'bob'] as const) {
    await owner.admin.people.add({ username: name })
    ids.set(name, (await owner.admin.people.get({ person: name })).id)
  }
  await owner.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
  for (const name of ['ana', 'bob'] as const) {
    const { token } = await createCredential(credentialsRepo(db), {
      personId: idOf(name),
      kind: 'token',
      label: `${name}-${PORT_LABEL}`,
    })
    tokens.set(name, token)
  }
})
afterAll(async () => {
  db.close()
  await b.stop()
})

describe('the sessions exist: chats of ana, bob and the owner, and a room of ana with the owner', () => {
  test('each person chats with a marker; the stored calls are readable by their own person', async () => {
    await talk('ana', `hello from ana ${MARK_A}`)
    await talk('bob', `hello from bob ${MARK_B}`)
    await talk('owner', 'hello from the owner')

    roomId = (await tokenClient('ana').rpc.rooms.start({ name: ROOM_NAME, invite: [OWNER] })).room
      .id
    await b.local.rpc.rooms.accept({ roomId })
    current = 'ana'
    await tokenClient('ana').rpc.rooms.say({ roomId, text: `keith, room line ${MARK_A}` })
    await until(
      'the room turn answered',
      async () =>
        (await tokenClient('ana').rpc.rooms.events({ roomId, after: 0, limit: 200 })).events,
      (events) => events.some((e) => e.kind === 'keith'),
    )
    await b.core.activity.flush()

    const own = await tokenClient('ana').rpc.logs.sessions({})
    expect(own.sessions.map((s) => s.id)).toContain(frontOf('ana'))
    anaCallId = await latestCall(frontOf('ana'))
    const raw = await tokenClient('ana').rpc.logs.raw({ callId: anaCallId })
    expect(raw.request).toContain(MARK_A)
    roomCallId = (await tokenClient('ana').rpc.logs.session({ id: roomSession() })).generations.at(
      -1,
    )?.id as string
    expect(roomCallId).toBeTruthy()
  }, 30_000)
})

describe('bob cannot read ana through any logs procedure', () => {
  test('bob lists only his own sessions; ana by her person id is FORBIDDEN; ana by her session or call id is NOT_FOUND', async () => {
    const list = await asBob(tokenClient('bob').rpc.logs.sessions({}))
    expect(list.code).toBeNull()
    expect(list.body).toContain(frontOf('bob'))
    expect(list.body).not.toContain(MARK_A)
    expect(list.body).not.toContain(idOf('ana'))
    expect(list.body).not.toContain(frontOf('ana'))
    expect(list.body).not.toContain(roomId)

    const byPerson = await asBob(tokenClient('bob').rpc.logs.sessions({ person: idOf('ana') }))
    expect(byPerson.code).toBe('FORBIDDEN')

    const session = await asBob(tokenClient('bob').rpc.logs.session({ id: frontOf('ana') }))
    expect(session.code).toBe('NOT_FOUND')
    const room = await asBob(tokenClient('bob').rpc.logs.session({ id: roomSession() }))
    expect(room.code).toBe('NOT_FOUND')
    const own = await asBob(tokenClient('bob').rpc.logs.session({ id: frontOf('bob') }))
    expect(own.code).toBeNull()

    const call = await asBob(tokenClient('bob').rpc.logs.call({ id: anaCallId }))
    expect(call.code).toBe('NOT_FOUND')
    const raw = await asBob(tokenClient('bob').rpc.logs.raw({ callId: anaCallId }))
    expect(raw.code).toBe('NOT_FOUND')
    const roomRaw = await asBob(tokenClient('bob').rpc.logs.raw({ callId: roomCallId }))
    expect(roomRaw.code).toBe('NOT_FOUND')
  })

  test('no answer bob received holds ana marker, ana person id or ana session ids', () => {
    const everything = bobAnswers.join('\n')
    expect(everything).toContain(frontOf('bob')) // control: the answers are real
    for (const leak of [MARK_A, idOf('ana'), frontOf('ana'), anaCallId, roomCallId])
      expect(everything).not.toContain(leak)
  })
})

describe('bob prompt, feed and audit rows hold no content of ana', () => {
  test('bob captured prompts are real and hold no ana marker', () => {
    const bob = seen.filter((p) => p.who === 'bob')
    expect(bob.some((p) => p.prompt.includes(MARK_B))).toBe(true)
    for (const p of bob) expect(p.prompt).not.toContain(MARK_A)
  })

  test('the activity feed rows of bob session hold no ana marker', () => {
    const rows = db
      .query('SELECT payload FROM events WHERE session_id = ?')
      .all(frontOf('bob')) as { payload: string }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.payload).not.toContain(MARK_A)
  })

  test('bob audit.mine holds no ana marker and no owner-read row (the owner has not read bob)', async () => {
    const mine = await tokenClient('bob').rpc.admin.audit.mine({})
    const text = JSON.stringify(mine)
    expect(text).not.toContain(MARK_A)
    expect(text).not.toContain(idOf('ana'))
    expect(mine.map((r) => r.kind)).not.toContain('logs.owner-read')
  })
})

describe('the owner path is audited; the owner own sessions are not', () => {
  test('the owner reads ana session: ana sees logs.owner-read and acl.owner-access with no content', async () => {
    const read = await b.local.rpc.logs.session({ id: frontOf('ana') })
    expect(read.generations.length).toBeGreaterThan(0)
    const mine = await tokenClient('ana').rpc.admin.audit.mine({})
    const kinds = mine.map((r) => r.kind)
    expect(kinds).toContain('logs.owner-read')
    expect(kinds).toContain('acl.owner-access')
    const summary = mine.find((r) => r.kind === 'logs.owner-read')?.summary ?? ''
    expect(summary).toContain('one of your sessions')
    expect(JSON.stringify(mine)).not.toContain(MARK_A)
  })

  test('the owner reads their own session: no audit row is written', async () => {
    const before = ownerReadScopes().length
    await b.local.rpc.logs.session({ id: frontOf('owner') })
    expect(ownerReadScopes().length).toBe(before)
  })

  test('a raw read is audited every time, never folded into a window', async () => {
    const before = ownerReadScopes().filter((s) => s === 'raw').length
    await b.local.rpc.logs.raw({ callId: anaCallId })
    await b.local.rpc.logs.raw({ callId: anaCallId })
    expect(ownerReadScopes().filter((s) => s === 'raw').length).toBe(before + 2)
  })
})

describe('a secret typed by ana is redacted in the stored request', () => {
  test('logs.raw shows the redaction marker, never the secret; a plain call keeps its text', async () => {
    await talk('ana', SECRET_A)
    await b.core.activity.flush()
    const secretCall = await latestCall(frontOf('ana'))
    const raw = await b.local.rpc.logs.raw({ callId: secretCall })
    expect(raw.request).toContain('[redacted:secret]')
    expect(raw.request).not.toContain(SECRET_A)
    expect(raw.bodyState).toBe('stored')
  })
})

describe('captureBodies off: the next call keeps its figures and no body', () => {
  test('the owner turns bodies off; ana next call has figures, no messages and no raw request', async () => {
    await b.local.rpc.logs.settings.set({ captureBodies: false })
    await talk('ana', 'a call without a body')
    await b.core.activity.flush()
    const id = await latestCall(frontOf('ana'))
    const call = await b.local.rpc.logs.call({ id })
    expect(call.call.bodyState).toBe('off')
    expect(call.call.modelId).toBe('m')
    expect(typeof call.call.durationMs).toBe('number')
    expect(call.messages).toEqual([])
    const raw = await b.local.rpc.logs.raw({ callId: id })
    expect(raw.request).toBeNull()
  })
})

describe('room rights: outside bob cannot read; a member loses the session when leaving', () => {
  test('ana and the owner, members, read the room session; bob, outside, does not', async () => {
    expect((await tokenClient('ana').rpc.logs.session({ id: roomSession() })).session.kind).toBe(
      'room',
    )
    expect((await b.local.rpc.logs.session({ id: roomSession() })).session.roomId).toBe(roomId)
    const bob = await asBob(tokenClient('bob').rpc.logs.session({ id: roomSession() }))
    expect(bob.code).toBe('NOT_FOUND')
    const bobList = await tokenClient('bob').rpc.logs.sessions({ kind: 'room' })
    expect(bobList.sessions.map((s) => s.id)).not.toContain(roomSession())
  })

  test('after ana leaves the room, her room session and its call are NOT_FOUND', async () => {
    await tokenClient('ana').rpc.rooms.leave({ roomId })
    expect((await answer(tokenClient('ana').rpc.logs.session({ id: roomSession() }))).code).toBe(
      'NOT_FOUND',
    )
    expect((await answer(tokenClient('ana').rpc.logs.raw({ callId: roomCallId }))).code).toBe(
      'NOT_FOUND',
    )
    const list = await tokenClient('ana').rpc.logs.sessions({ kind: 'room' })
    expect(list.sessions.map((s) => s.id)).not.toContain(roomSession())
  })
})
