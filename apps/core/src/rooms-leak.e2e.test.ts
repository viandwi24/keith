/**
 * P30.3.6, the leak test of phase 3 (docs/specs/corpus-callosum.md "Tests", ADR-0020 §2, ADR-0026 §3 and §4): two people, ana and
 * bob, each with a private note, a memory file, an agenda item, a pending reminder and a node, planted with a sentinel unique to
 * each item. They talk in a shared room; every model call of the room agent is captured by wrapping the scripted model's
 * `doStream` (system, volatile reminder and messages), and the tool list of each call is read. No planted string may appear in
 * any captured context, and the room agent's tool list may hold none of the tools that could read those items.
 * Real core over TCP and the local socket, the same boot as `rooms-isolation.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { ROOM_AGENT_TOOL_NAMES } from './modules/corpus-callosum/agent.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

// Built at runtime (gitleaks and the other leak tests prefer it); one sentinel per planted item and per person.
const sentinel = (label: string): string => `zq${label}${crypto.randomUUID().replaceAll('-', '')}`
// a node name must match /^[a-z0-9][a-z0-9-]{0,31}$/ (the join manifest), so its sentinel is short and lower case
const nodeName = (): string => `nd${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const planted = {
  ana: {
    note: sentinel('anote'),
    memory: sentinel('amemo'),
    agenda: sentinel('aagen'),
    reminder: sentinel('arem'),
    node: nodeName(),
  },
  bob: {
    note: sentinel('bnote'),
    memory: sentinel('bmemo'),
    agenda: sentinel('bagen'),
    reminder: sentinel('brem'),
    node: nodeName(),
  },
}
const ALL_PLANTED = Object.values(planted).flatMap((items) => Object.values(items))

/** Tool names that could read a planted item (notes, memory, agenda, reminders, nodes, protocols, tasks, motor, shell). */
const READER_TOOL =
  /^(memory|reminders?|notes?|agenda|motor|nodes?|protocols?|tasks?|todos?|subagent|shell)/

const PORT_LABEL = 'room-leak'
const ROOM_NAME = 'Room leak'

let b: BootedCore
let db: Sqlite
/** Each captured model call: the wire prompt as JSON (system, reminder and messages), taken as the call goes through `doStream`. */
const captured: string[] = []
/** The room agent's scripted model: one text answer per turn. Its `before` hook is the capture of every `doStream` call. */
const room = testProvider({
  id: 'room-p',
  models: { m: Array.from({ length: 6 }, (_, i) => ({ text: `Noted, ${i}.` })) },
  before: async (prompt) => {
    captured.push(prompt)
  },
})

const tokens = new Map<'ana' | 'bob', string>()
const noteIds = new Map<'ana' | 'bob', string>()
const ids = new Map<'ana' | 'bob', string>()
let roomId = ''

function tokenClient(name: 'ana' | 'bob') {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}
const bearer = (name: 'ana' | 'bob') => ({
  authorization: `Bearer ${tokens.get(name)}`,
  'content-type': 'application/json',
})

beforeAll(async () => {
  b = await bootCore({}, { definitions: [room as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'room-p' })
  await owner.models.roles.set({ role: 'front', ref: 'room-p:m' })

  for (const name of ['ana', 'bob'] as const) {
    await owner.admin.people.add({ username: name })
    ids.set(name, (await owner.admin.people.get({ person: name })).id)
  }
  await owner.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
  for (const name of ['ana', 'bob'] as const) {
    const { token } = await createCredential(credentialsRepo(db), {
      personId: ids.get(name) as string,
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

describe('the sentinels are planted in every store of each person', () => {
  test('ana and bob each get a note, a memory file, an agenda item, a reminder and a node', async () => {
    for (const name of ['ana', 'bob'] as const) {
      const items = planted[name]
      const id = ids.get(name) as string

      // a private note, through the notes plugin as the person
      const note = await fetch(`${b.url}/plugins/notes/create`, {
        method: 'POST',
        headers: bearer(name),
        body: JSON.stringify({ title: `${name} private`, body: items.note }),
      })
      expect(note.status).toBe(200)
      noteIds.set(name, ((await note.json()) as { id: string }).id)

      // a memory file, in the person's own memory folder (`<dataDir>/memory/<personId>/`)
      const memoryDir = join(b.dir, 'memory', id)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'profile.md'), `Preference: ${items.memory}\n`)

      // an agenda item, through the agenda procedures as the person
      await tokenClient(name).rpc.agenda.add({
        what: items.agenda,
        startsAt: Date.now() + 3_600_000,
        status: 'confirmed',
      })

      // a pending reminder for the person, due in ten hours
      const reminder = await fetch(`${b.url}/plugins/reminders/create`, {
        method: 'POST',
        headers: bearer(name),
        body: JSON.stringify({ text: items.reminder, inMinutes: 600 }),
      })
      expect(reminder.status).toBe(200)
    }

    // a node per person: nodes are Keith's own layer (ADR-0027 §9), so the owner pairs each one and it carries the sentinel
    for (const name of ['ana', 'bob'] as const) {
      const { code } = await b.local.rpc.nodes.pair()
      const joined = await fetch(`${b.url}/nodes/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          manifest: {
            name: planted[name].node,
            os: 'linux',
            arch: 'x64',
            version: '1',
            capabilities: ['system.info'],
            policy: { allowShell: false },
          },
        }),
      })
      if (joined.status !== 200) throw new Error(`join refused: ${await joined.text()}`)
    }
  })

  test('control: every plant is stored and readable by its owner, so an empty scan later means something', async () => {
    const ana = await tokenClient('ana').rpc.agenda.list({})
    expect(JSON.stringify(ana)).toContain(planted.ana.agenda)
    const notes = await fetch(`${b.url}/plugins/notes/get`, {
      method: 'POST',
      headers: bearer('ana'),
      body: JSON.stringify({ id: noteIds.get('ana') }),
    })
    expect(await notes.text()).toContain(planted.ana.note)
    const reminders = await fetch(`${b.url}/plugins/reminders/list`, {
      method: 'POST',
      headers: bearer('bob'),
      body: '{}',
    })
    expect(await reminders.text()).toContain(planted.bob.reminder)
    expect(JSON.stringify(await b.local.rpc.nodes.list())).toContain(planted.bob.node)
    expect(
      await Bun.file(join(b.dir, 'memory', ids.get('ana') as string, 'profile.md')).text(),
    ).toContain(planted.ana.memory)
  })
})

describe('the room talks, and every room model call is captured', () => {
  test('ana starts a room with bob; ana and then bob speak to Keith; each turn is answered', async () => {
    roomId = (await tokenClient('ana').rpc.rooms.start({ name: ROOM_NAME, invite: ['bob'] })).room
      .id
    await tokenClient('bob').rpc.rooms.accept({ roomId })

    await tokenClient('ana').rpc.rooms.say({ roomId, text: 'keith, hello from the room' })
    await until(
      'the first room turn answered',
      () => captured.length,
      (n) => n >= 1,
    )
    await until(
      'ana turn answer in the transcript',
      async () =>
        (await tokenClient('ana').rpc.rooms.events({ roomId, after: 0, limit: 200 })).events,
      (events) => events.some((e) => e.kind === 'keith'),
    )

    await tokenClient('bob').rpc.rooms.say({ roomId, text: 'keith, what is in this room?' })
    await until(
      'the second room turn answered',
      () => captured.length,
      (n) => n >= 2,
    )
    await until(
      'bob turn answer in the transcript',
      async () =>
        (await tokenClient('bob').rpc.rooms.events({ roomId, after: 0, limit: 200 })).events,
      (events) => events.filter((e) => e.kind === 'keith').length >= 2,
    )
  })
})

describe('no planted item reaches the room agent', () => {
  test('the captured contexts are real: each holds the room reminder, the speaker and the window lines', () => {
    expect(captured.length).toBeGreaterThanOrEqual(2)
    for (const prompt of captured) expect(prompt).toContain(ROOM_NAME)
    expect(captured[0]).toContain('The person speaking now is ana')
    expect(captured[0]).toContain('hello from the room')
    expect(captured.at(-1)).toContain('The person speaking now is bob')
    expect(captured.at(-1)).toContain('what is in this room?')
  })

  test('no planted string appears in any captured context (system, reminder, messages)', () => {
    const everything = captured.join('\n')
    for (const text of ALL_PLANTED) expect(everything).not.toContain(text)
  })

  test('the room agent offers only room tools: none of them could read a note, memory, agenda, reminder or node', () => {
    const calls = room.models.get('m')?.calls ?? []
    expect(calls.length).toBe(captured.length)
    const offered = [...new Set(calls.flatMap((c) => (c.tools ?? []).map((t) => t.name)))]
    expect(offered).toContain('room_say')
    // `datetime` is the clock plugin's tool: it reads the time only, no person's data
    expect(
      offered.filter((name) => !ROOM_AGENT_TOOL_NAMES.includes(name) && name !== 'datetime'),
    ).toEqual([])
    expect(offered.filter((name) => READER_TOOL.test(name))).toEqual([])
  })
})
