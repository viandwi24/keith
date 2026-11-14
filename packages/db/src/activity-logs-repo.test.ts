import { describe, expect, test } from 'bun:test'
import type { LlmCallRecord } from '@keith/contracts'
import {
  type ActivityCallInput,
  type ActivitySessionInput,
  activityLogsRepo,
} from './activity-logs-repo.ts'
import { migrateDatabase, openDatabase } from './connection.ts'
import type { Sqlite } from './eh/sql.ts'

// The activity logs store (docs/specs/activity-logs.md, ADR-0032 §3, P36.2.1): a round trip of calls and bodies, session totals that
// equal the sum of their calls, the CHECKs on the closed sets, stable paging, and the purge variants.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const text = (value: Uint8Array | null | undefined): string | null =>
  value ? new TextDecoder().decode(value) : null

const chat = (id = 'front:ana', personId: string | null = 'ana'): ActivitySessionInput => ({
  id,
  kind: 'chat',
  personId,
  roomId: null,
  app: 'Front',
})

const room = (id: string, roomId = 'r1'): ActivitySessionInput => ({
  id,
  kind: 'room',
  personId: null,
  roomId,
  app: 'Room',
})

const call = (id: string, sessionId: string, over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  id,
  sessionId,
  kind: 'step',
  trigger: 'send',
  turnId: 'turn-1',
  stepIndex: 0,
  startedAt: 1_000,
  durationMs: 50,
  firstChunkMs: 10,
  status: 'ok',
  finishReason: 'stop',
  modelId: 'model-a',
  provider: 'openrouter',
  upstreamProvider: 'upstream-x',
  tokensIn: 10,
  tokensOut: 5,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  costMicro: 100,
  costSource: 'provider',
  fallbackNote: null,
  errorName: null,
  errorMessage: null,
  requestBytes: 20,
  responseBytes: 30,
  bodyState: 'stored',
  speakerId: null,
  ...over,
})

const item = (
  session: ActivitySessionInput,
  record: LlmCallRecord,
  withBodies = true,
): ActivityCallInput => ({
  session,
  call: record,
  ...(withBodies
    ? {
        bodies: {
          request: bytes(`{"messages":"req ${record.id}"}`),
          response: bytes(`{"text":"res ${record.id}"}`),
          output: bytes(`out ${record.id}`),
        },
      }
    : {}),
})

const count = (sqlite: Sqlite, table: string): number =>
  sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0

describe('activityLogsRepo: round trip', () => {
  test('a call and its bodies read back as written; the session row holds the totals', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    const record = call('c1', 'front:ana', { speakerId: null, cacheRead: 4 })
    expect(repo.insertCalls([item(chat(), record)])).toBe(1)

    expect(repo.getCall('c1')).toEqual(record)
    expect(repo.listCalls('front:ana')).toEqual([record])
    const bodies = repo.getBodies('c1')
    expect(text(bodies?.request)).toBe('{"messages":"req c1"}')
    expect(text(bodies?.response)).toBe('{"text":"res c1"}')
    expect(text(bodies?.output)).toBe('out c1')

    expect(repo.getSession('front:ana')).toEqual({
      id: 'front:ana',
      kind: 'chat',
      personId: 'ana',
      roomId: null,
      app: 'Front',
      firstAt: 1_000,
      lastAt: 1_000,
      calls: 1,
      costMicro: 100,
      primaryModel: 'model-a',
      primaryProvider: 'openrouter',
    })
    expect(repo.getCall('missing')).toBeUndefined()
    expect(repo.getBodies('missing')).toBeUndefined()
    sqlite.close()
  })

  test('a call without bodies stores no body row', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    repo.insertCalls([item(chat(), call('c1', 'front:ana', { bodyState: 'off' }), false)])
    expect(repo.getBodies('c1')).toBeUndefined()
    expect(count(sqlite, 'llm_bodies')).toBe(0)
    sqlite.close()
  })

  test('a batch of calls is one write: an error on one call writes none', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    expect(() =>
      repo.insertCalls([
        item(chat(), call('c1', 'front:ana')),
        item(chat(), call('c1', 'front:ana')),
      ]),
    ).toThrow()
    expect(count(sqlite, 'llm_calls')).toBe(0)
    expect(count(sqlite, 'llm_sessions')).toBe(0)
    sqlite.close()
  })
})

describe('activityLogsRepo: session totals', () => {
  test('calls, cost, time range and primary model equal the sum and the most used of its calls', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    const session = chat()
    repo.insertCalls([
      item(
        session,
        call('c1', 'front:ana', { startedAt: 1_000, costMicro: 100, modelId: 'model-a' }),
      ),
      item(
        session,
        call('c2', 'front:ana', {
          startedAt: 2_000,
          costMicro: null,
          modelId: 'model-b',
          provider: 'direct',
        }),
      ),
    ])
    repo.insertCalls([
      item(
        session,
        call('c3', 'front:ana', {
          startedAt: 3_000,
          costMicro: 250,
          modelId: 'model-b',
          provider: 'direct',
        }),
      ),
    ])

    const all = repo.listCalls('front:ana')
    const row = repo.getSession('front:ana')
    expect(row?.calls).toBe(all.length)
    expect(row?.costMicro).toBe(all.reduce((sum, c) => sum + (c.costMicro ?? 0), 0))
    expect(row?.firstAt).toBe(Math.min(...all.map((c) => c.startedAt)))
    expect(row?.lastAt).toBe(Math.max(...all.map((c) => c.startedAt)))
    expect(row?.primaryModel).toBe('model-b')
    expect(row?.primaryProvider).toBe('direct')
    sqlite.close()
  })

  test('a session holds the bodies flag: off when no call of it kept a body', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    repo.insertCalls([item(chat(), call('c1', 'front:ana'), false)])
    expect(
      sqlite.query<{ bodies_off: number }, []>('SELECT bodies_off FROM llm_sessions').get()
        ?.bodies_off,
    ).toBe(1)
    repo.insertCalls([item(chat(), call('c2', 'front:ana', { startedAt: 2_000 }))])
    expect(
      sqlite.query<{ bodies_off: number }, []>('SELECT bodies_off FROM llm_sessions').get()
        ?.bodies_off,
    ).toBe(0)
    sqlite.close()
  })
})

describe('activityLogsRepo: CHECK constraints', () => {
  test('an unknown session kind is refused by the database, and the repo refuses a bad call kind', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    expect(() =>
      sqlite.exec(
        `INSERT INTO llm_sessions (id, kind, app, first_at, last_at) VALUES ('x', 'bogus', 'Nope', 1, 1)`,
      ),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      repo.insertCalls([item(chat(), call('c1', 'front:ana', { kind: 'telepathy' as never }))]),
    ).toThrow(/CHECK constraint failed/)
    expect(count(sqlite, 'llm_sessions')).toBe(0)
    sqlite.close()
  })

  test('an unknown body state and an unknown trigger are refused', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    expect(() =>
      repo.insertCalls([item(chat(), call('c1', 'front:ana', { bodyState: 'kept' as never }))]),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      repo.insertCalls([item(chat(), call('c2', 'front:ana', { trigger: 'poke' as never }))]),
    ).toThrow(/CHECK constraint failed/)
    sqlite.close()
  })
})

describe('activityLogsRepo: listing and paging', () => {
  test('sessions list newest first, paging by last_at then id is stable across equal times', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    const names = ['front:a', 'front:b', 'front:c', 'front:d', 'front:e']
    const times = [5_000, 1_000, 5_000, 3_000, 5_000]
    repo.insertCalls(
      names.map((name, i) =>
        item(chat(name, 'ana'), call(`c${i}`, name, { startedAt: times[i] ?? 0 }), false),
      ),
    )

    const everything = repo.listSessions({}, { limit: 100 }).sessions.map((s) => s.id)
    expect(everything).toEqual(['front:e', 'front:c', 'front:a', 'front:d', 'front:b'])

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = repo.listSessions({}, { limit: 2, cursor })
      seen.push(...page.sessions.map((s) => s.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor !== undefined)
    expect(seen).toEqual(everything)
    expect(pages).toBe(3)
    sqlite.close()
  })

  test('filters: kind, person, room, model, time range and id text', () => {
    const sqlite = db()
    const repo = activityLogsRepo(sqlite)
    repo.insertCalls([
      item(
        chat('front:ana', 'ana'),
        call('c1', 'front:ana', { startedAt: 1_000, modelId: 'model-a' }),
        false,
      ),
      item(
        { ...chat('front:ana:agent:r', 'ana'), kind: 'task', app: 'Worker' },
        call('c2', 'front:ana:agent:r', { startedAt: 2_000, modelId: 'model-b', kind: 'other' }),
        false,
      ),
      item(
        room('room:r1:g0'),
        call('c3', 'room:r1:g0', { startedAt: 3_000, modelId: 'model-b', speakerId: 'ana' }),
        false,
      ),
    ])
    const ids = (filter: Parameters<ReturnType<typeof activityLogsRepo>['listSessions']>[0]) =>
      repo.listSessions(filter).sessions.map((s) => s.id)

    expect(ids({ kind: 'room' })).toEqual(['room:r1:g0'])
    expect(ids({ personId: 'ana', kind: 'chat' })).toEqual(['front:ana'])
    expect(ids({ roomId: 'r1' })).toEqual(['room:r1:g0'])
    expect(ids({ model: 'model-b' })).toEqual(['room:r1:g0', 'front:ana:agent:r'])
    expect(ids({ from: 1_500, to: 2_500 })).toEqual(['front:ana:agent:r'])
    expect(ids({ q: 'front:ana:' })).toEqual(['front:ana:agent:r'])
    expect(ids({ q: 'nothing' })).toEqual([])
    sqlite.close()
  })

  test('a bad cursor is refused', () => {
    const repo = activityLogsRepo(db())
    expect(() => repo.listSessions({}, { cursor: 'garbage' })).toThrow(
      'invalid activity-log cursor',
    )
  })
})

describe('activityLogsRepo: purges', () => {
  const seed = (sqlite: Sqlite) => {
    const repo = activityLogsRepo(sqlite)
    repo.insertCalls([
      item(
        chat('front:ana', 'ana'),
        call('old', 'front:ana', { startedAt: 1_000, costMicro: 100 }),
      ),
      item(chat('front:ana', 'ana'), call('new', 'front:ana', { startedAt: 9_000, costMicro: 40 })),
      item(
        room('room:r1:g0'),
        call('room-old', 'room:r1:g0', { startedAt: 1_000, speakerId: 'ana' }),
      ),
      item(chat('front:bo', 'bo'), call('bo-old', 'front:bo', { startedAt: 1_000 })),
    ])
    return repo
  }

  test('purgeBodiesBefore deletes old bodies, marks them purged and keeps every figure', () => {
    const sqlite = db()
    const repo = seed(sqlite)
    expect(repo.purgeBodiesBefore(5_000)).toEqual({ bodies: 3 })
    expect(repo.getBodies('old')).toBeUndefined()
    expect(repo.getBodies('new')).toBeDefined()
    expect(repo.getCall('old')?.bodyState).toBe('purged')
    expect(repo.getCall('old')?.costMicro).toBe(100)
    expect(repo.getCall('new')?.bodyState).toBe('stored')
    expect(repo.getSession('front:ana')?.calls).toBe(2)
    expect(
      sqlite
        .query<{ bodies_off: number }, [string]>('SELECT bodies_off FROM llm_sessions WHERE id = ?')
        .get('front:bo')?.bodies_off,
    ).toBe(1)
    expect(
      sqlite
        .query<{ bodies_off: number }, [string]>('SELECT bodies_off FROM llm_sessions WHERE id = ?')
        .get('front:ana')?.bodies_off,
    ).toBe(0)
    sqlite.close()
  })

  test('purgeBefore deletes old calls and bodies, keeps sessions that still hold calls with their totals recomputed', () => {
    const sqlite = db()
    const repo = seed(sqlite)
    expect(repo.purgeBefore(5_000)).toEqual({ calls: 3, bodies: 3, sessions: 2 })
    expect(repo.getCall('old')).toBeUndefined()
    expect(repo.getBodies('old')).toBeUndefined()
    const ana = repo.getSession('front:ana')
    expect(ana?.calls).toBe(1)
    expect(ana?.costMicro).toBe(40)
    expect(ana?.firstAt).toBe(9_000)
    expect(repo.getSession('room:r1:g0')).toBeUndefined()
    expect(repo.getSession('front:bo')).toBeUndefined()
    expect(count(sqlite, 'llm_calls')).toBe(1)
    sqlite.close()
  })

  test('purgePerson deletes the person sessions, their calls and bodies; a room keeps its calls without the speaker', () => {
    const sqlite = db()
    const repo = seed(sqlite)
    expect(repo.purgePerson('ana')).toEqual({ sessions: 1, calls: 2, bodies: 2 })
    expect(repo.getSession('front:ana')).toBeUndefined()
    expect(repo.getCall('new')).toBeUndefined()
    expect(repo.getSession('front:bo')).toBeDefined()
    expect(repo.getSession('room:r1:g0')).toBeDefined()
    expect(repo.getCall('room-old')?.speakerId).toBeNull()
    sqlite.close()
  })

  test('exportPerson returns the person sessions, their calls, the room calls they spoke in, and the stored bodies', () => {
    const sqlite = db()
    const repo = seed(sqlite)
    const out = repo.exportPerson('ana')
    expect(out.sessions.map((s) => s.id)).toEqual(['front:ana'])
    expect(out.calls.map((c) => c.id)).toEqual(['old', 'room-old', 'new'])
    expect(out.bodies.map((b) => b.callId).sort()).toEqual(['new', 'old', 'room-old'])
    expect(repo.exportPerson('nobody')).toEqual({ sessions: [], calls: [], bodies: [] })
    sqlite.close()
  })

  test('status counts rows and the stored bytes', () => {
    const sqlite = db()
    const repo = seed(sqlite)
    const status = repo.status()
    expect(status).toMatchObject({ sessions: 3, calls: 4, bodies: 4 })
    expect(status.bodyBytes).toBeGreaterThan(0)
    sqlite.close()
  })
})
