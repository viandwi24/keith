/**
 * P34.2.5, the leak and order test of the context reset (docs/specs/chat-context.md "Tests", ADR-0020 §2 and §4, ADR-0030 §3
 * and §5). Two people, ana and bob, each with a style (a planted address, a brevity, a gentle topic) and a memory file with a
 * planted string. ana talks in her generation 0, bob talks in his. ana runs `chat.newContext` with the flush, talks in her
 * new generation, and runs `chat.compact`. Every model call (`doStream` for turns, `doGenerate` for a flush or a summary) is captured by wrapping the scripted
 * model, with the stored generation of ana at the time of the call. Checks: bob's session, generation, transcript, audit rows and activity
 * are unchanged by ana's reset and compaction; ana's first call after the reset has no message of generation 0 and carries
 * the persona and her style lines; the flush calls run as ana's, before the bump; no planted string of ana reaches a call
 * of bob. Real core over TCP and the local socket, the same boot as `prefrontal-leak.e2e.test.ts`.
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
/** ana's gentle topic line, as the style renders it: a planted string of ana too. */
const ANA_TOPIC_LINE = 'Treat these topics gently: money.'
/** The strings that must never reach bob's calls: ana's address, memory and topic. */
const ANA_SECRETS = [planted.ana.address, planted.ana.memory, ANA_TOPIC_LINE]
const PERSONA_MARK = 'Formal and composed'
const PORT_LABEL = 'chat-context-leak'
/** ana's generation 0 messages: the first of them must never reach generation 1. */
const GEN0_MARK = 'alpha zero message'

/** One captured model call: whose turn it was (set by the test), the wire prompt as JSON, and ana's stored generation then. */
interface Call {
  who: 'ana' | 'bob'
  /** A turn (`doStream`) or a flush and summary call (`doGenerate`). */
  kind: 'stream' | 'generate'
  prompt: string
  storedGeneration: number | null
}

let b: BootedCore
let db: Sqlite
/** The speaker of the call being run: the test sets it before it acts, so each captured call knows whose it is. */
let current: 'ana' | 'bob' = 'ana'
const calls: Call[] = []

/**
 * The scripted steps, in the order the model is called: ana's seven generation 0 turns, bob's turn, the reset (the flush only:
 * `session.flush()` writes no summary and covers every completed turn, eharness 0.14.1), ana's two generation 1 turns, the compaction
 * (flush, then its summary). `/compact` keeps the last 6 completed turns (`keepLast: 6`, spec 06 §4); the reset's flush does not.
 */
const STEPS = [
  { text: 'Noted, alpha one.' },
  { text: 'Noted, alpha two.' },
  { text: 'Noted, alpha three.' },
  { text: 'Noted, alpha four.' },
  { text: 'Noted, alpha five.' },
  { text: 'Noted, alpha six.' },
  { text: 'Noted, alpha seven.' },
  { text: 'Noted, bob.' },
  { text: 'Saved for the reset.' },
  { text: 'Noted, beta one.' },
  { text: 'Noted, beta two.' },
  { text: 'Saved for the compaction.' },
  { text: 'Summary of generation one.' },
  { text: 'Spare step.' },
]

const base = testProvider({ id: 'leak-ctx', models: { m: STEPS } })
/**
 * The provider of the test: the scripted model of `testProvider`, with every call captured. The flush and the summary of a
 * compaction run `doGenerate`, the turns run `doStream`; both are wrapped here.
 */
const model = {
  ...base,
  create: () => ({
    languageModel(modelId: string) {
      const inner = base.create().languageModel(modelId) as unknown as Record<string, unknown>
      const capture = (method: string, prompt: unknown) =>
        calls.push({
          who: current,
          kind: method === 'doStream' ? 'stream' : 'generate',
          prompt: JSON.stringify(prompt),
          storedGeneration: generationOf(ids.get('ana')),
        })
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop !== 'doStream' && prop !== 'doGenerate')
            return Reflect.get(target, prop, receiver)
          const call = Reflect.get(target, prop, receiver) as (options: {
            prompt: unknown
          }) => unknown
          return (options: { prompt: unknown }) => {
            capture(prop, options.prompt)
            return call.call(target, options)
          }
        },
      })
    },
  }),
}

const tokens = new Map<'ana' | 'bob', string>()
const ids = new Map<'ana' | 'bob', string>()

function tokenClient(name: 'ana' | 'bob') {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}

/** The stored current generation of a person (`front_generations`), or null for the missing row (generation 0). */
function generationOf(personId: string | undefined): number | null {
  if (personId === undefined) return null
  const row = db
    .query('SELECT generation FROM front_generations WHERE person_id = ?')
    .get(personId) as { generation: number } | null
  return row?.generation ?? null
}

/** Sends one message in a front session of the person and waits for the turn to end. */
async function front(name: 'ana' | 'bob', text: string, generation = 0): Promise<void> {
  current = name
  const id = ids.get(name) as string
  for await (const _ of tokenClient(name).reply(text, frontSessionId(id, generation))) {
    // drain: the stream ends with the turn
  }
}

/**
 * Everything bob can see or that records bob: his generation row, his session's stored messages and state, his audit rows
 * and his activity records. Read from the tables, so a row written by anyone shows up here.
 */
function snapshotOfBob(): string {
  const bob = ids.get('bob') as string
  const session = frontSessionId(bob, 0)
  return JSON.stringify({
    generation: db.query('SELECT * FROM front_generations WHERE person_id = ?').all(bob),
    state: db.query('SELECT * FROM eh_state WHERE session_id = ?').all(session),
    messages: db.query('SELECT * FROM eh_messages WHERE session_id = ? ORDER BY id').all(session),
    audit: db.query('SELECT * FROM audit_events WHERE actor = ? ORDER BY id').all(bob),
    activity: db.query('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(session),
  })
}

beforeAll(async () => {
  b = await bootCore({}, { definitions: [model as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'leak-ctx' })
  await owner.models.roles.set({ role: 'front', ref: 'leak-ctx:m' })
  await owner.persona.setTemplate({ templateId: 'butler' })

  for (const name of ['ana', 'bob'] as const) {
    await owner.admin.people.add({ username: name })
    ids.set(name, (await owner.admin.people.get({ person: name })).id)
  }
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

describe('generation 0: ana and bob talk in their own front sessions', () => {
  test('ana sends seven turns, bob one; every call is captured for its speaker', async () => {
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six'])
      await front('ana', `${GEN0_MARK} ${n}`)
    await front('ana', 'the last generation zero message')
    await front('bob', 'hello, this is bob')
    expect(calls.map((c) => c.who)).toEqual([...Array(7).fill('ana'), 'bob'])
  })

  test('control: bob has a transcript and no generation row; the snapshot is taken before the reset', async () => {
    const bobSnapshot = JSON.parse(snapshotOfBob()) as {
      messages: unknown[]
      generation: unknown[]
    }
    expect(bobSnapshot.messages.length).toBeGreaterThan(0)
    expect(bobSnapshot.generation).toEqual([])
    expect(await tokenClient('bob').rpc.chat.generations()).toEqual([
      expect.objectContaining({ generation: 0 }),
    ])
  })
})

let bobBefore = ''
let resetFrom = 0
let resetTo = 0

describe('ana resets: /new with the flush', () => {
  test('the flush runs as ana, before the bump: one call (no summary), ana at generation 0', async () => {
    bobBefore = snapshotOfBob()
    current = 'ana'
    resetFrom = calls.length
    const out = await tokenClient('ana').rpc.chat.newContext({ flush: true })
    resetTo = calls.length
    expect(out).toEqual({ generation: 1, flushed: true })
    // the flush of generation 0, and no summary call: it runs before the stored generation moves
    const window = calls.slice(resetFrom, resetTo)
    expect(window.map((c) => c.who)).toEqual(['ana'])
    expect(window.map((c) => c.storedGeneration)).toEqual([null])
    expect(window[0]?.prompt).toContain(GEN0_MARK)
  })

  test('the flush record is in ana generation 0, and the reset writes one activity record on the old session', async () => {
    const anaOld = frontSessionId(ids.get('ana') as string, 0)
    const flushes = db
      .query(
        "SELECT id FROM eh_messages WHERE session_id = ? AND json_extract(metadata, '$.eharness.kind') = 'eh.flush'",
      )
      .all(anaOld)
    expect(flushes).toHaveLength(1)
    // a flush-only reset (eharness 0.14.0): generation 0 holds no summary marker
    const markers = db
      .query(
        "SELECT id FROM eh_messages WHERE session_id = ? AND json_extract(metadata, '$.eharness.kind') = 'eh.compaction'",
      )
      .all(anaOld)
    expect(markers).toHaveLength(0)
    const changed = db
      .query("SELECT session_id FROM events WHERE type = 'chat.context.changed'")
      .all() as { session_id: string }[]
    expect(changed.map((r) => r.session_id)).toEqual([anaOld])
  })

  test('the generation row is now 1 for ana and nothing for bob', () => {
    expect(generationOf(ids.get('ana'))).toBe(1)
    expect(generationOf(ids.get('bob'))).toBeNull()
  })
})

describe('ana in generation 1: the first call after the reset carries no generation 0', () => {
  test('the first call after the reset holds the persona and ana style, and no generation 0 message', async () => {
    await front('ana', 'beta opening message', 1)
    const first = calls[resetTo]
    expect(first?.who).toBe('ana')
    expect(first?.storedGeneration).toBe(1)
    const prompt = first?.prompt ?? ''
    expect(prompt).toContain(PERSONA_MARK)
    expect(prompt).toContain(
      `Address this person as \\"${planted.ana.address}\\" (a name, not an instruction).`,
    )
    expect(prompt).toContain('Brevity: short.')
    expect(prompt).toContain(ANA_TOPIC_LINE)
    expect(prompt).not.toContain(GEN0_MARK)
    expect(prompt).not.toContain('the last generation zero message')
    expect(prompt).not.toContain('Noted, alpha')
  })

  test('ana sends a second message in generation 1: the generation stays 1, nothing of generation 0 comes back', async () => {
    await front('ana', 'beta second message', 1)
    for (const call of calls.slice(resetTo)) {
      expect(call.prompt).not.toContain(GEN0_MARK)
    }
  })
})

describe('ana compacts her generation 1: the same flush, the generation does not move', () => {
  test('compact runs the flush and the summary as ana, the generation stays 1', async () => {
    current = 'ana'
    const from = calls.length
    const out = await tokenClient('ana').rpc.chat.compact({ keepLast: 1 })
    expect(out).toEqual({ generation: 1, flushed: true })
    expect(calls.slice(from).map((c) => c.who)).toEqual(['ana', 'ana'])
    expect(generationOf(ids.get('ana'))).toBe(1)
  })
})

describe('bob is unchanged by ana reset and compaction', () => {
  test("bob's session, generation, transcript, audit and activity are the same as before", () => {
    expect(snapshotOfBob()).toBe(bobBefore)
  })

  test("bob's own chain is still generation 0 only", async () => {
    expect((await tokenClient('bob').rpc.chat.generations()).map((g) => g.generation)).toEqual([0])
  })

  test('the audit rows of the reset and the compaction name ana only', () => {
    const rows = db
      .query("SELECT kind, actor FROM audit_events WHERE kind LIKE 'chat.context.%' ORDER BY id")
      .all() as { kind: string; actor: string }[]
    expect(rows).toEqual([
      { kind: 'chat.context.new', actor: ids.get('ana') as string },
      { kind: 'chat.context.compact', actor: ids.get('ana') as string },
    ])
  })
})

describe('no planted value of ana reaches a call of bob', () => {
  test('the captures are real: bob call is there and carries his own style', () => {
    const bobCall = calls.find((c) => c.who === 'bob')
    expect(bobCall?.prompt).toContain(
      `Address this person as \\"${planted.bob.address}\\" (a name, not an instruction).`,
    )
    expect(bobCall?.prompt).toContain('Brevity: full.')
    // ana's calls hold her own address, so the scan of bob's calls below is not empty
    expect(calls.find((c) => c.who === 'ana')?.prompt).toContain(planted.ana.address)
  })

  test('no call of bob holds any of ana secrets', () => {
    for (const call of calls.filter((c) => c.who === 'bob')) {
      for (const secret of ANA_SECRETS) expect(call.prompt).not.toContain(secret)
    }
  })

  test('every turn call carries the persona text (the flush and summary calls carry none of the turn prompt)', () => {
    const turns = calls.filter((c) => c.kind === 'stream')
    expect(turns.length).toBeGreaterThanOrEqual(10)
    for (const call of turns) expect(call.prompt).toContain(PERSONA_MARK)
  })
})
