/**
 * P30.4.4, the leak and rights test of phase 4 (docs/specs/corpus-callosum.md "Tests", ADR-0026 §3, ADR-0020 §2): ana plants a
 * private note, asks Keith in the room to check it, and the room agent hands the request to ana's own front session
 * (`room_handoff`). The front session reads the note (`notes_get`) and shares the result with the room through `room_post`, which
 * only writes a pending request. Bob asks for his own handoff in the same room; nothing of ana's note reaches him, and his request
 * never lands in ana's chat. The result is posted only when ana confirms the exact text (`rooms.confirm`); bob and the owner are
 * refused, and a replay is `CONFLICT`.
 *
 * One scripted model serves the room agent and the front sessions (both use the `front` role). It routes each call by its prompt:
 * a room turn carries the room reminder ("The person speaking now is"), bob's front turn carries bob's request, every other call is
 * ana's front turn. Real core over TCP and the local socket, the same boot as `rooms-leak.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import type { ScriptedCallOptions, ScriptedModel } from 'eharness/testing'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { createCredential } from './modules/auth/index.ts'
import { HANDOFF_LINE, HANDOFF_REPLY } from './modules/corpus-callosum/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { until } from './testing/wait.ts'

// Built at runtime (gitleaks prefers it); each sentinel is unique to this run.
const sentinel = (label: string): string => `zq${label}${crypto.randomUUID().replaceAll('-', '')}`
/** The body of ana's private note: it must never reach the room or bob. */
const NOTE_BODY = sentinel('hnote')
/** The mark of the result ana's front session writes: it reaches the room only after ana confirms it. */
const RESULT_MARK = sentinel('hres')
const A_REQUEST = 'check my private note about the harbour plan'
const B_REQUEST = 'send me my private note about the orchard'
const RESULT_TEXT = `Result of your note on the harbour plan: ${RESULT_MARK}`
/** What ana's front session says after it asks for the confirmation. */
const ANA_FRONT_REPLY = 'Asked you to confirm the text before it goes to the room.'
/** What bob's front session says after his handoff. */
const BOB_FRONT_REPLY = 'Done, I will look in your own chat.'
const ROOM_NAME = 'Room handoff'
const PORT_LABEL = 'room-handoff'

type Person = 'ana' | 'bob'
type Route = 'room' | 'bob' | 'ana'

/** The front role's model: one provider, one id. Every call goes to the scripted model its prompt routes to. */
const scripts: Record<Route, ScriptedModel> = {
  room: scriptedModel(
    [
      { toolCalls: [{ toolName: 'room_handoff', input: { request: A_REQUEST } }] },
      { text: HANDOFF_REPLY },
      { toolCalls: [{ toolName: 'room_handoff', input: { request: B_REQUEST } }] },
      { text: HANDOFF_REPLY },
    ],
    { provider: 'desk-p', modelId: 'm' },
  ),
  ana: scriptedModel(
    [
      // reads ana's own note (the note id is known once it is planted)
      () => ({ toolCalls: [{ toolName: 'notes_get', input: { id: state.noteId } }] }),
      // shares the result: the room id is the one the step reminder names in ana's chat
      (call) => ({
        toolCalls: [
          { toolName: 'room_post', input: { roomId: roomIdOf(call), text: RESULT_TEXT } },
        ],
      }),
      { text: ANA_FRONT_REPLY },
    ],
    { provider: 'desk-p', modelId: 'm' },
  ),
  bob: scriptedModel([{ text: BOB_FRONT_REPLY }, { text: BOB_FRONT_REPLY }], {
    provider: 'desk-p',
    modelId: 'm',
  }),
}

const state = { noteId: '', roomId: '' }

/** The room id the step reminder names: "(roomId <id>)". Read from the prompt of the call. */
function roomIdOf(call: ScriptedCallOptions): string {
  const found = /roomId ([\w-]+)\)/.exec(JSON.stringify(call.prompt))
  if (found === null) throw new Error('no room id in the front prompt')
  return found[1] as string
}

function routeOf(json: string): Route {
  if (json.includes('The person speaking now is')) return 'room'
  if (json.includes(B_REQUEST)) return 'bob'
  return 'ana'
}

/** Every model call as JSON, by route: the room agent's contexts and each front session's prompts. */
const captured: Record<Route, string[]> = { room: [], bob: [], ana: [] }

/** The one model of the `front` role: a proxy whose `doStream` routes each call to its script and records its prompt. */
const deskModel = new Proxy(scriptedModel([], { provider: 'desk-p', modelId: 'm' }), {
  get(target, prop, receiver) {
    if (prop !== 'doStream') return Reflect.get(target, prop, receiver)
    return (call: ScriptedCallOptions) => {
      const json = JSON.stringify(call.prompt)
      const route = routeOf(json)
      captured[route].push(json)
      return scripts[route].doStream(call)
    }
  },
})

const desk = {
  id: 'desk-p',
  label: 'desk-p',
  settings: z.object({}),
  create: () => ({ languageModel: () => deskModel }),
  listModels: async () => [{ id: 'm', name: 'm', tools: true }],
}

let b: BootedCore
let db: Sqlite
const tokens = new Map<Person, string>()
const ids = new Map<Person | 'owner', string>()
let roomId = ''
let requestId = ''

const tokenClient = (name: Person) => {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}
const bearer = (name: Person) => ({
  authorization: `Bearer ${tokens.get(name)}`,
  'content-type': 'application/json',
})

beforeAll(async () => {
  b = await bootCore({}, { definitions: [desk as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'desk-p' })
  await owner.models.roles.set({ role: 'front', ref: 'desk-p:m' })
  for (const name of ['ana', 'bob'] as const) {
    await owner.admin.people.add({ username: name })
    ids.set(name, (await owner.admin.people.get({ person: name })).id)
    const { token } = await createCredential(credentialsRepo(db), {
      personId: ids.get(name) as string,
      kind: 'token',
      label: `${name}-${PORT_LABEL}`,
    })
    tokens.set(name, token)
  }
  ids.set('owner', (await owner.admin.people.get({ person: 'owner' })).id)
  await owner.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
})
afterAll(async () => {
  db.close()
  await b.stop()
})

/** The stored messages of a person's front session, every role, as parsed parts. */
function frontParts(name: Person): Array<Record<string, unknown>> {
  return db
    .query<{ parts: string }, [string]>(
      'SELECT parts FROM eh_messages WHERE session_id = ? ORDER BY created_at, id',
    )
    .all(`front:${ids.get(name)}`)
    .flatMap((row) => JSON.parse(row.parts) as Array<Record<string, unknown>>)
}

/** The tool name of a stored tool part: `tool-<name>` (static) or `toolName` (dynamic). */
function partName(part: Record<string, unknown>): string {
  return typeof part.toolName === 'string' ? part.toolName : String(part.type).replace(/^tool-/, '')
}

/** Whether a person's front session ran a tool to a result. */
const ranTool = (name: Person, tool: string): boolean =>
  frontParts(name).some((p) => partName(p) === tool && p.state === 'output-available')

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

/** One SSE record of the activity feed, parsed. */
interface FeedRecord {
  type: string
  payload: Record<string, unknown> | null
  sessionId: string | null
}

/** The activity feed of a person from the start, read until it goes quiet (the stream stays open). */
async function feedOf(name: Person): Promise<{ raw: string; records: FeedRecord[] }> {
  const res = await fetch(`${b.url}/activity/stream?after=0`, {
    headers: { authorization: `Bearer ${tokens.get(name)}` },
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

/** Every room event as ana reads it (the transcript). */
const transcript = async () =>
  (await tokenClient('ana').rpc.rooms.events({ roomId: state.roomId, after: 0, limit: 200 })).events

describe('ana plants a private note and starts the room with bob', () => {
  test('a note with the sentinel body, and a room with bob accepted', async () => {
    const note = await fetch(`${b.url}/plugins/notes/create`, {
      method: 'POST',
      headers: bearer('ana'),
      body: JSON.stringify({ title: 'ana private', body: NOTE_BODY }),
    })
    expect(note.status).toBe(200)
    state.noteId = ((await note.json()) as { id: string }).id

    roomId = (await tokenClient('ana').rpc.rooms.start({ name: ROOM_NAME, invite: ['bob'] })).room
      .id
    state.roomId = roomId
    await tokenClient('bob').rpc.rooms.accept({ roomId })
  })
})

describe("ana's request is handed to ana's own chat; the room sees only the handoff line", () => {
  test('ana asks Keith in the room; the room answers; ana`s front session reads the note and proposes the result', async () => {
    await tokenClient('ana').rpc.rooms.say({ roomId, text: `keith, ${A_REQUEST}` })
    await until(
      'the room answers the handoff',
      transcript,
      (events) => events.some((e) => e.kind === 'keith' && e.text === HANDOFF_REPLY),
      10_000,
    )
    await until(
      "ana's front session posts the result request",
      () => ranTool('ana', 'room_post'),
      Boolean,
      10_000,
    )
    expect(ranTool('ana', 'notes_get')).toBe(true)
  }, 20_000)

  test('the front session of ana received exactly her request, and the note read stays in her chat', () => {
    const chat = JSON.stringify(frontParts('ana'))
    expect(chat).toContain(A_REQUEST)
    expect(chat).toContain(NOTE_BODY)
    // the request reached the front session once, through the wake route
  })

  test('the room transcript holds the handoff line and nothing of the note or the result; no post yet', async () => {
    const events = await transcript()
    // the RPC never sends a handoff's text (corpus-callosum.md, "Transcript"): the row is there, with no text
    expect(events.filter((e) => e.kind === 'handoff').map((e) => e.text)).toEqual([null])
    // the stored line is the fixed one, the only text the room keeps of the handoff
    const stored = db
      .query<{ text: string }, [string]>(
        "SELECT text FROM room_events WHERE room_id = ? AND kind = 'handoff' ORDER BY seq",
      )
      .all(roomId)
    expect(stored.map((r) => r.text)).toEqual([HANDOFF_LINE])
    const all = JSON.stringify(events)
    expect(all).not.toContain(NOTE_BODY)
    expect(all).not.toContain(RESULT_MARK)
    expect(events.some((e) => e.kind === 'post')).toBe(false)
  })

  test('the pending post request names ana alone, and no room event carries the result yet', async () => {
    const view = await tokenClient('ana').rpc.rooms.get({ roomId })
    const posts = view.pending.filter((r) => r.kind === 'post')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.person).toBe(ids.get('ana'))
    expect(posts[0]?.payload.text).toBe(RESULT_TEXT)
    requestId = posts[0]?.id as string
    expect(JSON.stringify(await transcript())).not.toContain(RESULT_MARK)
  })
})

describe('bob never sees ana’s note or result, and his own request never reaches ana', () => {
  test('bob asks for his own handoff in the room; his front session answers; ana’s chat holds none of his request', async () => {
    await tokenClient('bob').rpc.rooms.say({ roomId, text: `keith, ${B_REQUEST}` })
    await until(
      "bob's front session answers",
      () => JSON.stringify(frontParts('bob')),
      (chat) => chat.includes(BOB_FRONT_REPLY),
      10_000,
    )
    expect(JSON.stringify(frontParts('ana'))).not.toContain(B_REQUEST)
  }, 20_000)

  test('every room model call holds neither the note nor the result (the room context of bob included)', () => {
    expect(captured.room.length).toBeGreaterThanOrEqual(2)
    const everything = captured.room.join('\n')
    expect(everything).toContain(A_REQUEST)
    expect(everything).toContain(B_REQUEST)
    expect(everything).not.toContain(NOTE_BODY)
    expect(everything).not.toContain(RESULT_MARK)
  })

  test("bob's front session context holds none of ana's note", () => {
    expect(captured.bob.length).toBeGreaterThanOrEqual(1)
    expect(captured.bob.join('\n')).not.toContain(NOTE_BODY)
    expect(captured.bob.join('\n')).not.toContain(RESULT_MARK)
  })

  test('every RPC response to bob holds neither the note nor the unconfirmed result', async () => {
    const answers = await Promise.all([
      outcome(tokenClient('bob').rpc.rooms.get({ roomId })),
      outcome(tokenClient('bob').rpc.rooms.events({ roomId, after: 0, limit: 200 })),
      outcome(tokenClient('bob').rpc.rooms.files({ roomId })),
      outcome(tokenClient('bob').rpc.rooms.list({})),
      outcome(tokenClient('bob').rpc.admin.audit.mine({ limit: 200 })),
      outcome(tokenClient('bob').rpc.rooms.confirm({ requestId, approved: true })),
    ])
    const text = answers.join('\n')
    expect(text).not.toContain(NOTE_BODY)
    expect(text).not.toContain(RESULT_MARK)
  })

  test('the feed of bob holds neither the note nor the result', async () => {
    const feed = await feedOf('bob')
    expect(feed.raw).not.toContain(NOTE_BODY)
    expect(feed.raw).not.toContain(RESULT_MARK)
    expect(feed.records.some((r) => r.type === 'room.event')).toBe(true)
  })
})

describe('the result reaches the room only when ana confirms the exact text', () => {
  test('bob and the owner are refused and post nothing', async () => {
    expect(
      await outcome(tokenClient('bob').rpc.rooms.confirm({ requestId, approved: true })),
    ).toContain('FORBIDDEN')
    expect(await outcome(b.local.rpc.rooms.confirm({ requestId, approved: true }))).toContain(
      'FORBIDDEN',
    )
    expect((await transcript()).some((e) => e.kind === 'post')).toBe(false)
  })

  test('ana confirms: the exact text is posted once, with ana as speaker', async () => {
    expect(await tokenClient('ana').rpc.rooms.confirm({ requestId, approved: true })).toEqual({
      status: 'confirmed',
    })
    const posts = (await transcript()).filter((e) => e.kind === 'post')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.speaker?.id).toBe(ids.get('ana'))
    expect(posts[0]?.text).toBe(RESULT_TEXT)
  })

  test('a replay of the confirmation is CONFLICT and posts nothing more', async () => {
    expect(
      await outcome(tokenClient('ana').rpc.rooms.confirm({ requestId, approved: true })),
    ).toContain('CONFLICT')
    expect((await transcript()).filter((e) => e.kind === 'post')).toHaveLength(1)
  })

  test("after the post, bob's feed and his RPC responses still hold none of ana's note", async () => {
    const feed = await feedOf('bob')
    expect(feed.raw).not.toContain(NOTE_BODY)
    const events = await outcome(
      tokenClient('bob').rpc.rooms.events({ roomId, after: 0, limit: 200 }),
    )
    expect(events).not.toContain(NOTE_BODY)
  })
})
