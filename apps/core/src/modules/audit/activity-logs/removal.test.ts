import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmCallRecord } from '@keith/contracts'
import {
  type ActivityCallInput,
  activityLogsRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import type { Audit } from '../audit.ts'
import { pack } from './pack.ts'
import { ACTIVITY_LOGS_FILE, activityLogsRemoval } from './removal.ts'

// The activity logs part of a removed person (ADR-0032 §7): keep moves nothing, export writes the person's rows, purge
// deletes them and audits counts only. Each runs on an in-memory database.

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
  upstreamProvider: null,
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

const session = (id: string, personId: string | null, roomId: string | null = null) => ({
  id,
  kind: (roomId === null ? 'chat' : 'room') as 'chat' | 'room',
  personId,
  roomId,
  app: roomId === null ? 'Front' : 'Room',
})

function seed(): Sqlite {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const repo = activityLogsRepo(sqlite)
  const body = (text: string) => ({
    request: pack({ prompt: text }),
    response: pack({ answer: `${text}-answer` }),
    output: null,
  })
  const batch: ActivityCallInput[] = [
    {
      session: session('front:ana', 'ana'),
      call: call('a1', 'front:ana', { startedAt: 1_000, costMicro: 100 }),
      bodies: body('ana-1'),
    },
    {
      session: session('front:ana', 'ana'),
      call: call('a2', 'front:ana', { startedAt: 2_000, costMicro: 200 }),
    },
    {
      session: session('front:bob', 'bob'),
      call: call('b1', 'front:bob', { startedAt: 3_000 }),
      bodies: body('bob-1'),
    },
    // a room turn: the session belongs to the room, the speaker is ana
    {
      session: session('room:r1:1', null, 'r1'),
      call: call('r1-a', 'room:r1:1', { startedAt: 4_000, speakerId: 'ana' }),
      bodies: body('room-ana'),
    },
    {
      session: session('room:r1:1', null, 'r1'),
      call: call('r1-b', 'room:r1:1', { startedAt: 5_000, speakerId: 'bob' }),
    },
  ]
  repo.insertCalls(batch)
  return sqlite
}

const counts = (sqlite: Sqlite) => {
  const n = (sql: string) => sqlite.query<{ n: number }, []>(sql).get()?.n ?? 0
  return {
    sessions: n('SELECT COUNT(*) AS n FROM llm_sessions'),
    calls: n('SELECT COUNT(*) AS n FROM llm_calls'),
    bodies: n('SELECT COUNT(*) AS n FROM llm_bodies'),
  }
}

function sinkOf(): {
  events: {
    kind: string
    actor: string
    via: string
    detail?: Record<string, unknown> | undefined
  }[]
  audit: Pick<Audit, 'record'>
} {
  const events: {
    kind: string
    actor: string
    via: string
    detail?: Record<string, unknown> | undefined
  }[] = []
  return {
    events,
    audit: {
      record: (event) => {
        events.push({ kind: event.kind, actor: event.actor, via: event.via, detail: event.detail })
      },
    },
  }
}

describe('activity logs removal part (ADR-0032 §7)', () => {
  test('keep moves nothing: the rows stay and nothing is audited', () => {
    const sqlite = seed()
    const sink = sinkOf()
    const part = activityLogsRemoval({ sqlite, audit: sink.audit })
    expect(part.keep('ana', '/unused')).toBeUndefined()
    expect(counts(sqlite)).toEqual({ sessions: 3, calls: 5, bodies: 3 })
    expect(sink.events).toEqual([])
  })

  test('export writes the person sessions and calls where they spoke, with the bodies decoded, and no other person', () => {
    const sqlite = seed()
    const dest = mkdtempSync(join(tmpdir(), 'keith-logs-export-'))
    try {
      activityLogsRemoval({ sqlite, audit: sinkOf().audit }).export('ana', dest)
      const data = JSON.parse(readFileSync(join(dest, ACTIVITY_LOGS_FILE), 'utf8'))
      expect(data.personId).toBe('ana')
      expect(data.sessions.map((s: { id: string }) => s.id)).toEqual(['front:ana'])
      expect(data.calls.map((c: { id: string }) => c.id).sort()).toEqual(['a1', 'a2', 'r1-a'])
      expect(data.bodies.map((b: { callId: string }) => b.callId).sort()).toEqual(['a1', 'r1-a'])
      const a1 = data.bodies.find((b: { callId: string }) => b.callId === 'a1')
      expect(a1.request).toEqual({ prompt: 'ana-1' })
      expect(a1.response).toEqual({ answer: 'ana-1-answer' })
      expect(a1.output).toBeNull()
      // bob's rows are not in ana's export
      expect(readFileSync(join(dest, ACTIVITY_LOGS_FILE), 'utf8')).not.toContain('bob')
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  test('export writes no file when the person has no rows', () => {
    const sqlite = seed()
    const dest = mkdtempSync(join(tmpdir(), 'keith-logs-empty-'))
    try {
      activityLogsRemoval({ sqlite, audit: sinkOf().audit }).export('carl', dest)
      expect(() => readFileSync(join(dest, ACTIVITY_LOGS_FILE))).toThrow()
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  test('purge deletes the person sessions, calls and bodies; a room keeps its calls without the speaker; counts audited, no ids', () => {
    const sqlite = seed()
    const sink = sinkOf()
    activityLogsRemoval({ sqlite, audit: sink.audit }).purge('ana', '/unused')
    // ana's own session and its body go; the room session stays with its calls and loses ana as speaker
    expect(counts(sqlite)).toEqual({ sessions: 2, calls: 3, bodies: 2 })
    const speakers = sqlite
      .query<{ id: string; speaker_id: string | null }, []>(
        "SELECT id, speaker_id FROM llm_calls WHERE session_id LIKE 'room:%' ORDER BY id",
      )
      .all()
    expect(speakers).toEqual([
      { id: 'r1-a', speaker_id: null },
      { id: 'r1-b', speaker_id: 'bob' },
    ])
    expect(sink.events).toEqual([
      {
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: { table: 'llm_bodies', count: 1 },
      },
      {
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: { table: 'llm_calls', count: 2 },
      },
      {
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: { table: 'llm_sessions', count: 1 },
      },
    ])
    expect(JSON.stringify(sink.events)).not.toContain('ana')
  })

  test('purge of a person with no rows audits nothing', () => {
    const sqlite = seed()
    const sink = sinkOf()
    activityLogsRemoval({ sqlite, audit: sink.audit }).purge('carl', '/unused')
    expect(sink.events).toEqual([])
    expect(counts(sqlite)).toEqual({ sessions: 3, calls: 5, bodies: 3 })
  })
})
