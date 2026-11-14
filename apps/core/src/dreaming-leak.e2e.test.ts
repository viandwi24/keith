/**
 * P35.6.4, the leak test of memory dreaming (docs/specs/dreaming.md "Tests", ADR-0031 §1, §3, §7, ADR-0020 §2). Two people, ana and
 * bob, each with a planted memory file and planted messages in their front session: a plain fact, a web-page paste (user text),
 * a tool result, a worker report (a kind message) and a worker session text. The judge is the real judge turn on the `cortex`
 * role, with a scripted model whose reply is a plan built from the candidates it reads (it keeps every candidate as a fact and
 * drops the web-page paste, as the judge's rules say). Both people run `dream.now` in `auto`, so the memory folders are written.
 *
 * Checks: every model call of each run is captured (the scripted model's prompts, tagged with the run's person). ana's run
 * sees ana's own user text and no string of bob's; bob's run sees no string of ana's; neither run sees a worker session text,
 * a worker report or a tool result of ana (the fetched-page sentinel). ana's memory and diary hold no fetched or worker
 * string. bob's folder, rows and diary are byte-equal after ana's run. The audit rows of the runs hold counts only. The judge's
 * model session is recorded under the person who ran it. Real core over TCP and the local socket, the boot of
 * `chat-context-leak.e2e.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DREAM_RUN, DreamRunAuditDetailSchema } from '@keith/contracts'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { frontSessionId } from './platform/sessions.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { testProvider } from './testing/scripted-providers.ts'

// Built at runtime, lower-case letters only: no digit and no mixed case, so the secret gate does not take a sentinel for a key.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const letters = (n: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => LETTERS[b % LETTERS.length]).join('')
const sentinel = (label: string): string => `zq${label}${letters(14)}`

/** The marker a pasted web page carries: the scripted judge drops such a candidate, as the judge's rules say. */
const PAGE_MARK = 'the text below was copied from a web page'

interface Sentinels {
  /** A fact the person states in a user message: the judge keeps it, so it reaches memory. */
  fact: string
  /** A web-page paste in a user message: user text, so the judge reads it (the scripted judge drops it). */
  page: string
  /** A tool result (a `tool` row and a tool part of an assistant turn): never collected. */
  tool: string
  fetched: string
  /** A worker report: an `eh.event` kind message in the front session: never collected. */
  report: string
  /** A worker session text: a session of the person's worker, never collected. */
  worker: string
  /** The memory file of the person: never sent to the judge by the code (the judge reads it only through its tool). */
  memory: string
}

const sentinelsOf = (label: string): Sentinels => ({
  fact: sentinel(`${label}fact`),
  page: sentinel(`${label}page`),
  tool: sentinel(`${label}tool`),
  fetched: sentinel(`${label}fetch`),
  report: sentinel(`${label}report`),
  worker: sentinel(`${label}worker`),
  memory: sentinel(`${label}memo`),
})

const planted = { ana: sentinelsOf('a'), bob: sentinelsOf('b') }
const ALL_SENTINELS = [...Object.values(planted.ana), ...Object.values(planted.bob)]
/** ana's strings that must never leave ana's run or reach bob's files: everything of ana except her own fact and page. */
const ANA_NEVER_IN_JUDGE = [
  planted.ana.tool,
  planted.ana.fetched,
  planted.ana.report,
  planted.ana.worker,
  planted.ana.memory,
]

/** One captured model call: whose run it was, and the whole prompt as JSON (every message, the system text included). */
interface Call {
  who: 'ana' | 'bob'
  prompt: string
}

let b: BootedCore
let db: Sqlite
/** The person whose run is in progress: set before each run, so every captured call knows whose it is. */
let current: 'ana' | 'bob' = 'ana'
const calls: Call[] = []
const tokens = new Map<'ana' | 'bob', string>()
const ids = new Map<'ana' | 'bob', string>()

/** The text of the user messages of a prompt (the candidates the judge reads). */
function userText(prompt: unknown): string {
  const messages = prompt as Array<{ role: string; content: unknown }>
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('\n'),
    )
    .join('\n')
}

/** One candidate line of the judge prompt: each field is a JSON string (`buildJudgePrompt`). */
const CANDIDATE_LINE = /^- id: (".*?"), day: ".*?", sourceMessageId: (".*?"), text: (".*")$/gm

/**
 * The scripted judge: a plan with one decision per candidate read from the prompt. A candidate with the web-page mark is dropped;
 * any other is kept as a short-term fact with its own text (cut to 100 characters, one line). The model is called once per run.
 */
const judgeStep = (call: { prompt: unknown }) => {
  const text = userText(call.prompt)
  calls.push({ who: current, prompt: JSON.stringify(call.prompt) })
  const candidates = [...text.matchAll(CANDIDATE_LINE)].map((m) => ({
    id: JSON.parse(m[1] as string) as string,
    sourceMessageId: JSON.parse(m[2] as string) as string,
    text: JSON.parse(m[3] as string) as string,
  }))
  const decisions = candidates.map((c) =>
    c.text.includes(PAGE_MARK)
      ? {
          id: c.id,
          action: 'drop',
          target: 'recent',
          text: 'a pasted web page',
          reason: 'a pasted page, not about the person',
          importance: 1,
          sourceMessageId: c.sourceMessageId,
        }
      : {
          id: c.id,
          action: 'keep-short-term',
          target: 'recent',
          text: c.text.replace(/\s+/g, ' ').slice(0, 100),
          reason: 'said today',
          importance: 3,
          sourceMessageId: c.sourceMessageId,
        },
  )
  return { text: JSON.stringify({ candidates: decisions }) }
}

const model = testProvider({
  id: 'leak-dream',
  models: { m: [judgeStep, judgeStep, judgeStep, judgeStep] },
})

function tokenClient(name: 'ana' | 'bob') {
  const token = tokens.get(name)
  if (token === undefined) throw new Error(`no token for ${name}`)
  return b.tcp(token)
}

/** The rows a person's front session and worker session hold, planted straight into eh_messages (the table eharness writes). */
function plantOf(name: 'ana' | 'bob'): void {
  const id = ids.get(name) as string
  const s = planted[name]
  const front = frontSessionId(id, 0)
  const stmt = db.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const at = Date.UTC(2026, 10, 10, 9)
  const meta = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ eharness: { v: 1, createdAt: at, ...extra } })
  const text = (value: string) => [{ type: 'text', text: value }]
  const rows: Array<[string, string, string, unknown, string]> = [
    [front, 'u001', 'user', text(`I prefer tea without sugar. Note: ${s.fact}`), meta()],
    [front, 'u002', 'user', text(`${PAGE_MARK}: ${s.page} and the rest of the article`), meta()],
    [front, 'u003', 'user', text('Remember this: my sister is called Rani'), meta()],
    [front, 'u004', 'user', text('Plain note four'), meta()],
    [front, 'u005', 'user', text('Plain note five'), meta()],
    [front, 'u006', 'user', text('Plain note six'), meta()],
    // a turn with a tool part: the user's request and the fetched result (a tool part) are not the person's conversation
    [front, 'u007', 'user', text('Look that up for me'), meta({ turnId: 't1' })],
    [
      front,
      'a001',
      'assistant',
      [
        { type: 'tool-fetch', state: 'output-available', output: { text: s.fetched } },
        ...text('Fetched it'),
      ],
      meta({ turnId: 't1' }),
    ],
    // a tool result stored as a role tool message
    [front, 'r001', 'tool', text(s.tool), meta()],
    // a worker report: an eh.event kind message of role user
    [
      front,
      'k001',
      'user',
      [{ type: 'data-eh.event', data: { text: s.report } }, ...text(s.report)],
      meta({ turnId: 't2', kind: 'eh.event' }),
    ],
  ]
  for (const [session, rowId, role, parts, metadata] of rows)
    stmt.run(session, rowId, role, JSON.stringify(parts), metadata, at)
  // a worker session of the person: `front:<id>:agent:<task>`, never read by the collector
  const worker = `${front}:agent:research`
  stmt.run(worker, 'w001', 'user', JSON.stringify(text(s.worker)), meta(), at)
  stmt.run(
    worker,
    'w002',
    'assistant',
    JSON.stringify(text(`Report: ${s.worker}`)),
    meta({ turnId: 'tw' }),
    at,
  )
  // the memory file of the person, in the person's own folder
  const memoryDir = join(b.dir, 'memory', id)
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'profile.md'), `Preference: ${s.memory}\n`)
}

/**
 * Everything of one person a run of the other person could change: the memory folder and the diary folder (every file, its
 * bytes), the person's dream settings and runs, the person's front messages and state, the person's audit rows and the
 * model sessions the person owns. Read from the disk and the tables.
 */
function snapshotOf(name: 'ana' | 'bob'): string {
  const id = ids.get(name) as string
  const files: Record<string, string> = {}
  for (const folder of [join(b.dir, 'memory', id), join(b.dir, 'dreams', id)]) {
    if (!existsSync(folder)) continue
    for (const rel of new Bun.Glob('**/*').scanSync({ cwd: folder, onlyFiles: true, dot: true }))
      files[`${folder.slice(b.dir.length)}/${rel}`] = readFileSync(join(folder, rel)).toString(
        'base64',
      )
  }
  return JSON.stringify({
    files,
    settings: db.query('SELECT * FROM dream_settings WHERE person_id = ?').all(id),
    runs: db.query('SELECT * FROM dream_runs WHERE person_id = ? ORDER BY id').all(id),
    messages: db
      .query('SELECT * FROM eh_messages WHERE session_id LIKE ? ORDER BY session_id, id')
      .all(`front:${id}%`),
    state: db
      .query('SELECT * FROM eh_state WHERE session_id LIKE ? ORDER BY session_id')
      .all(`front:${id}%`),
    audit: db.query('SELECT * FROM audit_events WHERE actor = ? ORDER BY id').all(id),
    sessions: db.query('SELECT * FROM llm_sessions WHERE person_id = ? ORDER BY id').all(id),
  })
}

/** The bytes of the memory folder and the diary of a person, as the files hold them now (for the write checks). */
function memoryTextOf(name: 'ana' | 'bob'): string {
  const snapshot = JSON.parse(snapshotOf(name)) as { files: Record<string, string> }
  return Object.values(snapshot.files)
    .map((base64) => Buffer.from(base64, 'base64').toString('utf8'))
    .join('\n')
}

/** The runs of the two people, with the calls each one made and the folders after. */
const runs: Partial<Record<'ana' | 'bob', { status: string; calls: Call[] }>> = {}
let bobBefore = ''
let bobAfterAnaRun = ''

beforeAll(async () => {
  b = await bootCore({}, { definitions: [model as never] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const owner = b.local.rpc
  await owner.providers.put({ providerId: 'leak-dream' })
  await owner.models.roles.set({ role: 'cortex', ref: 'leak-dream:m' })
  for (const name of ['ana', 'bob'] as const) {
    await owner.admin.people.add({ username: name })
    ids.set(name, (await owner.admin.people.get({ person: name })).id)
  }
  for (const name of ['ana', 'bob'] as const) {
    const { token } = await createCredential(credentialsRepo(db), {
      personId: ids.get(name) as string,
      kind: 'token',
      label: `${name}-dreaming-leak`,
    })
    tokens.set(name, token)
    // a member's dreaming is off until the member turns it on: `auto` writes the memory folder, so the writes are observed
    await tokenClient(name).rpc.dream.mode({ mode: 'auto' })
    plantOf(name)
  }

  // bob's run first, so bob's folder is in place; then bob's state is recorded and ana's run must leave it byte-equal
  current = 'bob'
  const bobStart = calls.length
  const bobRun = await tokenClient('bob').rpc.dream.now()
  runs.bob = { status: bobRun.status, calls: calls.slice(bobStart) }
  bobBefore = snapshotOf('bob')

  current = 'ana'
  const anaStart = calls.length
  const anaRun = await tokenClient('ana').rpc.dream.now()
  runs.ana = { status: anaRun.status, calls: calls.slice(anaStart) }
  bobAfterAnaRun = snapshotOf('bob')
})
afterAll(async () => {
  db.close()
  await b.stop()
})

describe('the runs happened: each person ran the real judge and wrote the memory', () => {
  test('control: both runs applied and each judge turn made a call', () => {
    expect(runs.ana?.status).toBe('applied')
    expect(runs.bob?.status).toBe('applied')
    expect(runs.ana?.calls.length).toBeGreaterThan(0)
    expect(runs.bob?.calls.length).toBeGreaterThan(0)
  })
  test("control: ana's own fact reached her judge and her memory", () => {
    expect(runs.ana?.calls.some((c) => c.prompt.includes(planted.ana.fact))).toBe(true)
    expect(memoryTextOf('ana')).toContain(planted.ana.fact)
  })
  test("control: bob's own fact reached his judge and his memory", () => {
    expect(runs.bob?.calls.some((c) => c.prompt.includes(planted.bob.fact))).toBe(true)
    expect(memoryTextOf('bob')).toContain(planted.bob.fact)
  })
})

describe('no string crosses between the two persons', () => {
  test("bob's planted strings appear in no call of ana's run", () => {
    for (const value of Object.values(planted.bob))
      expect(runs.ana?.calls.some((c) => c.prompt.includes(value))).toBe(false)
  })
  test("ana's planted strings appear in no call of bob's run", () => {
    for (const value of Object.values(planted.ana))
      expect(runs.bob?.calls.some((c) => c.prompt.includes(value))).toBe(false)
  })
  test("bob's folder, rows and diary are byte-equal after ana's run", () => {
    expect(bobAfterAnaRun).toBe(bobBefore)
  })
  test("ana's memory and diary hold none of bob's strings", () => {
    const text = memoryTextOf('ana')
    for (const value of Object.values(planted.bob)) expect(text).not.toContain(value)
  })
})

describe('fetched pages, tool results and worker text never reach the judge or memory', () => {
  test("ana's worker text, worker report, tool result and fetched page are in no call of her run", () => {
    for (const value of ANA_NEVER_IN_JUDGE)
      expect(runs.ana?.calls.some((c) => c.prompt.includes(value))).toBe(false)
  })
  test("a web-page paste is user text: it reaches ana's judge as data, and the judge drops it", () => {
    expect(runs.ana?.calls.some((c) => c.prompt.includes(planted.ana.page))).toBe(true)
    expect(memoryTextOf('ana')).not.toContain(planted.ana.page)
  })
  test("none of the never-read strings is in ana's memory or diary", () => {
    const text = memoryTextOf('ana')
    // her own memory file holds planted.ana.memory on purpose (the control that the file was read): every other value is absent
    for (const value of ANA_NEVER_IN_JUDGE.filter((v) => v !== planted.ana.memory))
      expect(text).not.toContain(value)
    expect(text).toContain(planted.ana.memory)
  })
  test("the same holds for bob's never-read strings in bob's run", () => {
    for (const value of [
      planted.bob.tool,
      planted.bob.fetched,
      planted.bob.report,
      planted.bob.worker,
      planted.bob.memory,
    ])
      expect(runs.bob?.calls.some((c) => c.prompt.includes(value))).toBe(false)
  })
})

describe('audit and principal', () => {
  test('the audit rows of the runs hold counts only: no planted string, only the counted keys', () => {
    // the run row is written by the system actor; the person is the detail's subject
    const rows = db
      .query('SELECT kind, actor, detail FROM audit_events WHERE kind = ? ORDER BY id')
      .all(DREAM_RUN) as Array<{ kind: string; actor: string; detail: string }>
    const subjects = rows.map((r) => (JSON.parse(r.detail) as { subject: string }).subject)
    expect(subjects.sort()).toEqual([ids.get('ana') as string, ids.get('bob') as string].sort())
    const allowed = new Set(Object.keys(DreamRunAuditDetailSchema.shape))
    for (const row of rows) {
      for (const value of ALL_SENTINELS) expect(row.detail).not.toContain(value)
      for (const key of Object.keys(JSON.parse(row.detail) as object))
        expect(allowed.has(key)).toBe(true)
    }
  })
  test("the judge's model session is recorded under the person who ran it, never the other", async () => {
    await b.core.activity.flush()
    const rows = db
      .query("SELECT id, person_id FROM llm_sessions WHERE id LIKE 'dream-judge:%'")
      .all() as Array<{ id: string; person_id: string | null }>
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.filter((r) => r.person_id === ids.get('ana')).length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.person_id === ids.get('bob')).length).toBeGreaterThan(0)
    expect(
      rows.every((r) => r.person_id === ids.get('ana') || r.person_id === ids.get('bob')),
    ).toBe(true)
  })
})
