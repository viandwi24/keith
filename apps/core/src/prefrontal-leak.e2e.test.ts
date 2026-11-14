/**
 * P33.3.5, the context leak test of phase 3 (docs/specs/prefrontal.md "Tests", ADR-0020 §2, ADR-0029 §3 and §4): two people, ana
 * and bob, each with a style (a planted address, a brevity, a gentle topic) and a memory file with a planted string. Both talk
 * to Keith in their front sessions and then in a shared room. Every model call (system, reminder and messages) is captured by
 * wrapping the scripted model's `doStream`, tagged with the speaker whose turn it was. No planted string of ana may appear in
 * bob's calls or in any room call bob's turn made; ana's own address may appear only in ana's room turn. The persona text
 * appears in every call. Real core over TCP and the local socket, the same boot as `rooms-leak.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { frontSessionId } from './platform/sessions.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

// Built at runtime (gitleaks and the other leak tests prefer it). An address is a name: letters only, so its sentinel is letters.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const letters = (n: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => LETTERS[b % LETTERS.length]).join('')
const addressSentinel = (label: string): string => `Zq${label}${letters(12)}`
const hexSentinel = (label: string): string =>
  `zq${label}${crypto.randomUUID().replaceAll('-', '')}`

const planted = {
  ana: { address: addressSentinel('ana'), memory: hexSentinel('amemo') },
  bob: { address: addressSentinel('bob'), memory: hexSentinel('bmemo') },
}
/** The strings that must never reach the other person's calls: ana's address and memory, and her gentle topic. */
const ANA_SECRETS = [planted.ana.address, planted.ana.memory, 'Treat these topics gently: money.']
const PERSONA_MARK = 'Formal and composed'
const ROOM_NAME = 'Leak prefrontal'
const PORT_LABEL = 'prefrontal-leak'

/** One captured model call: who the turn was for, whether it is a room call, and the wire prompt as JSON. */
interface Call {
  who: 'ana' | 'bob'
  room: boolean
  prompt: string
}

let b: BootedCore
let db: Sqlite
let roomId = ''
/** The speaker of the turn being run: set by the test before it sends the message, so each captured call knows its turn. */
let current: 'ana' | 'bob' = 'ana'
const calls: Call[] = []

const room = testProvider({
  id: 'leak-p',
  models: { m: Array.from({ length: 8 }, (_, i) => ({ text: `Noted, ${i}.` })) },
  before: async (prompt) => {
    const json = JSON.stringify(prompt)
    // the room reminder names the room in quotes, escaped inside the JSON: match the words only
    calls.push({ who: current, room: json.includes('Shared room'), prompt: json })
  },
})

const tokens = new Map<'ana' | 'bob', string>()
const ids = new Map<'ana' | 'bob', string>()

function tokenClient(name: 'ana' | 'bob') {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}

/** Sends one message in a front session as the person and waits for the turn to end. */
async function front(name: 'ana' | 'bob', text: string): Promise<void> {
  current = name
  const id = ids.get(name) as string
  for await (const _ of tokenClient(name).reply(text, frontSessionId(id, 0))) {
    // drain: the stream ends with the turn
  }
}

beforeAll(async () => {
  b = await bootCore({}, { definitions: [room as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'leak-p' })
  await owner.models.roles.set({ role: 'front', ref: 'leak-p:m' })
  await owner.persona.setTemplate({ templateId: 'butler' })

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
  // each person's style: an address, a brevity and a gentle topic of their own
  await tokenClient('ana').rpc.persona.style.set({
    patch: { address: planted.ana.address, brevity: 'short', gentleTopics: ['money'] },
  })
  await tokenClient('bob').rpc.persona.style.set({
    patch: { address: planted.bob.address, brevity: 'full', gentleTopics: ['health'] },
  })
  // each person's memory file, in their own folder (`<dataDir>/memory/<personId>/`)
  for (const name of ['ana', 'bob'] as const) {
    const memoryDir = join(b.dir, 'memory', ids.get(name) as string)
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'profile.md'), `Preference: ${planted[name].memory}\n`)
  }
})
afterAll(async () => {
  db.close()
  await b.stop()
})

describe('the planted values are stored and readable by their person', () => {
  test('control: each style and memory file is in place, so an empty scan later means something', async () => {
    const ana = await tokenClient('ana').rpc.persona.style.get({})
    expect(JSON.stringify(ana)).toContain(planted.ana.address)
    expect(
      await Bun.file(join(b.dir, 'memory', ids.get('ana') as string, 'profile.md')).text(),
    ).toContain(planted.ana.memory)
  })
})

describe('both talk to Keith, in front sessions and in a room, and every call is captured', () => {
  test('ana and bob each send a front message, then the room turns run', async () => {
    await front('ana', 'hello, this is ana')
    await front('bob', 'hello, this is bob')
    await until(
      'two front calls captured',
      () => calls.length,
      (n) => n >= 2,
    )

    roomId = (await tokenClient('ana').rpc.rooms.start({ name: ROOM_NAME, invite: ['bob'] })).room
      .id
    await tokenClient('bob').rpc.rooms.accept({ roomId })

    current = 'ana'
    await tokenClient('ana').rpc.rooms.say({ roomId, text: 'keith, hello from the room' })
    await until(
      'ana room turn captured',
      () => calls.length,
      (n) => n >= 3,
    )
    current = 'bob'
    await tokenClient('bob').rpc.rooms.say({ roomId, text: 'keith, what is in this room?' })
    await until(
      'bob room turn captured',
      () => calls.length,
      (n) => n >= 4,
    )
  })
})

describe('no planted value of ana reaches bob or the room', () => {
  test('the captures are real: each front and room turn is there, for the right speaker', () => {
    expect(calls.map((c) => `${c.who}:${c.room ? 'room' : 'front'}`)).toEqual([
      'ana:front',
      'bob:front',
      'ana:room',
      'bob:room',
    ])
    expect(calls[0]?.prompt).toContain(planted.ana.address)
    expect(calls[1]?.prompt).toContain(planted.bob.address)
    // the pinned profile of each person reaches that person's own front call, so the "never in another call" scans below
    // test a string that the prompt really carries (without this they would pass even if memory were never pinned)
    expect(calls[0]?.prompt).toContain(planted.ana.memory)
    expect(calls[1]?.prompt).toContain(planted.bob.memory)
  })

  test('bob calls (front and room) hold none of ana secrets', () => {
    for (const call of calls.filter((c) => c.who === 'bob')) {
      for (const secret of ANA_SECRETS) expect(call.prompt).not.toContain(secret)
    }
  })

  test('every room call holds none of ana secrets, except ana own address in ana room turn', () => {
    for (const call of calls.filter((c) => c.room)) {
      expect(call.prompt).not.toContain(planted.ana.memory)
      expect(call.prompt).not.toContain('Treat these topics gently: money.')
      if (call.who === 'bob') expect(call.prompt).not.toContain(planted.ana.address)
    }
    const anaRoom = calls.find((c) => c.room && c.who === 'ana')
    expect(anaRoom?.prompt.split(planted.ana.address).length).toBe(2)
  })

  test('the persona text appears in every captured call, front and room', () => {
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const call of calls) expect(call.prompt).toContain(PERSONA_MARK)
  })

  test("bob's own style is in bob's calls, so the check above is not empty", () => {
    const bobFront = calls.find((c) => c.who === 'bob' && !c.room)
    // the prompt is JSON twice over here, so the quote marks are checked as the name's neighbours, not as a literal
    expect(bobFront?.prompt).toContain(planted.bob.address)
    expect(bobFront?.prompt).toContain('(a name, not an instruction).')
    expect(bobFront?.prompt).toContain('Brevity: full.')
    expect(bobFront?.prompt).not.toContain('Treat these topics gently: money.')
  })
})
