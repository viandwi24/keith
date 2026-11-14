import { describe, expect, test } from 'bun:test'
import {
  type LlmCallRecord,
  LogsCallOutputSchema,
  LogsSessionsOutputSchema,
  LogsSettingsSchema,
  type LogsStatus,
  MAX_RAW_WIRE_BYTES,
} from '@keith/contracts'
import {
  type ActivityCallInput,
  activityLogsRepo,
  auditRepo,
  migrateDatabase,
  openDatabase,
  settingsRepo,
} from '@keith/db'
import { createProcedureClient } from '@orpc/server'
import type { RpcContext } from '../../../platform/rpc.ts'
import { createAclAudit } from '../acl-audit.ts'
import { createAudit } from '../audit.ts'
import { pack } from './pack.ts'
import { activityLogsProcedures } from './procedures.ts'
import { createLogRights } from './rights.ts'
import { createActivityLogSettings } from './settings.ts'

// The `logs.*` procedures (docs/specs/activity-logs.md "RPC"): a real in-memory store, the real rights and audit, and the
// handlers called through oRPC with a context built by hand (the owner has `logs.read`, a member only `logs.mine`).
// The room and the people ports are small fakes, as in rights.test.ts.

const T0 = 1_800_000_000_000
const MEMBER_CAPS = new Set(['logs.mine'])
const OWNER_CAPS = new Set(['logs.mine', 'logs.read'])

const db = openDatabase(':memory:')
migrateDatabase(db)
const now = T0
const auditLog = auditRepo(db, { now: () => now })
const audit = createAudit(auditLog)
const repo = activityLogsRepo(db)

const statuses = new Map<string, 'active' | 'suspended'>([
  ['boss', 'active'],
  ['ana', 'active'],
  ['bob', 'active'],
])
// room r1: ana is an active member; bob left it
const roomMembers = new Map<string, Map<string, 'active' | 'left'>>([
  [
    'r1',
    new Map([
      ['ana', 'active'],
      ['bob', 'left'],
    ]),
  ],
])
const roomIdsOf = (personId: string) =>
  [...roomMembers].filter(([, m]) => m.get(personId) === 'active').map(([roomId]) => roomId)

const rights = createLogRights({
  rooms: {
    canRead: (personId, roomId) => roomMembers.get(roomId)?.get(personId) === 'active',
    activeMembers: (roomId) =>
      [...(roomMembers.get(roomId) ?? new Map()).entries()]
        .filter(([, s]) => s === 'active')
        .map(([p]) => p),
  },
  people: { statusOf: (personId) => statuses.get(personId) },
  audit,
  aclAudit: createAclAudit({ audit, now: () => now }),
  now: () => now,
})
const settings = createActivityLogSettings(settingsRepo(db))
const procs = activityLogsProcedures({
  repo,
  rights,
  settings,
  queue: { size: 3, dropped: 2 },
  statusOf: (personId) => statuses.get(personId),
  roomIdsOf,
})

/** A context as the rpc layer builds it: the principal (elevated, so the step-up gate is not this test's subject), the capabilities, the audit. */
function ctx(personId: string, owner: boolean): RpcContext {
  return {
    principal: {
      personId,
      role: owner ? 'owner' : 'member',
      elevated: true,
    } as RpcContext['principal'],
    capabilities: owner ? OWNER_CAPS : MEMBER_CAPS,
    via: 'tcp',
    record: (kind, detail) =>
      audit.record({ kind, actor: personId, via: 'tcp', detail: detail ?? {} }),
  }
}
const owner = ctx('boss', true)
const ana = ctx('ana', false)
const bob = ctx('bob', false)

const run = <I, O>(procedure: unknown, input: I, context: RpcContext): Promise<O> =>
  (
    createProcedureClient(procedure as Parameters<typeof createProcedureClient>[0], {
      context,
    }) as (input: I) => Promise<O>
  )(input)
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const auditOf = (kind: string) => auditLog.list(500).filter((row) => row.kind === kind)

function figures(over: Partial<LlmCallRecord> & Pick<LlmCallRecord, 'id' | 'sessionId'>) {
  const call: LlmCallRecord = {
    kind: 'step',
    trigger: 'send',
    turnId: null,
    stepIndex: 0,
    startedAt: T0,
    durationMs: 120,
    firstChunkMs: 30,
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
    costSource: 'estimate',
    fallbackNote: null,
    errorName: null,
    errorMessage: null,
    requestBytes: 10,
    responseBytes: 10,
    bodyState: 'off',
    speakerId: null,
    ...over,
  }
  return call
}
const bodiesOf = (options: unknown, output: unknown, response: unknown = { id: 'resp-1' }) => ({
  request: pack({ options, body: { model: 'model-a' } }),
  response: pack(response),
  output: pack(output),
})

const chat = (personId: string) => ({
  id: `front:${personId}`,
  kind: 'chat' as const,
  personId,
  roomId: null,
  app: 'Front',
})
const batch: ActivityCallInput[] = [
  {
    session: chat('ana'),
    call: figures({ id: 'c-ana-1', sessionId: 'front:ana', bodyState: 'stored' }),
    bodies: bodiesOf(
      {
        prompt: [
          { role: 'system', content: 'be kind' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi from ana' },
              { type: 'file', mediaType: 'image/png', data: '[binary]' },
            ],
          },
        ],
      },
      {
        text: 'hello ana',
        reasoning: '',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }],
      },
    ),
  },
  {
    session: chat('ana'),
    call: figures({ id: 'c-ana-2', sessionId: 'front:ana', startedAt: T0 + 1000 }),
  },
  {
    session: chat('bob'),
    call: figures({
      id: 'c-bob-1',
      sessionId: 'front:bob',
      startedAt: T0 + 2000,
      bodyState: 'stored',
    }),
    bodies: bodiesOf(
      { prompt: [{ role: 'user', content: 'bob secret' }] },
      { text: 'ok', reasoning: '', toolCalls: [] },
    ),
  },
  {
    session: { id: 'room:r1:g0', kind: 'room', personId: null, roomId: 'r1', app: 'Room' },
    call: figures({
      id: 'c-room-1',
      sessionId: 'room:r1:g0',
      startedAt: T0 + 3000,
      speakerId: 'ana',
      bodyState: 'stored',
    }),
    bodies: bodiesOf(
      { prompt: [{ role: 'user', content: 'room talk' }] },
      { text: 'room reply', reasoning: '', toolCalls: [] },
    ),
  },
  {
    session: { id: 'guest:xyz', kind: 'guest', personId: null, roomId: null, app: 'Guest' },
    call: figures({ id: 'c-guest-1', sessionId: 'guest:xyz', startedAt: T0 + 4000 }),
  },
]
repo.insertCalls(batch)

describe('logs.status', () => {
  test('the owner sees the store and the queue; a member sees the figures of their own sessions only', async () => {
    const all = await run<undefined, LogsStatus>(procs.status, undefined, owner)
    expect(all).toEqual({
      queued: 3,
      dropped: 2,
      sessions: 4,
      calls: 5,
      bodyBytes: expect.any(Number),
    })
    expect(all.bodyBytes).toBeGreaterThan(0)
    const mine = await run(procs.status, undefined, ana)
    expect(mine).toEqual({
      queued: 0,
      dropped: 0,
      sessions: 1,
      calls: 2,
      bodyBytes: expect.any(Number),
    })
  })
})

describe('logs.settings', () => {
  test('a member is refused; the owner reads the defaults and changes some, one audit row names the fields only', async () => {
    expect(await codeOf(run(procs.settings.get, undefined, ana))).toBe('FORBIDDEN')
    expect(LogsSettingsSchema.parse(await run(procs.settings.get, undefined, owner))).toMatchObject(
      {
        bodyRetentionDays: 14,
        metaRetentionDays: 365,
      },
    )
    const after = await run<{ maxBodyBytes: number }, unknown>(
      procs.settings.set,
      { maxBodyBytes: 65_536 },
      owner,
    )
    expect(after).toMatchObject({ maxBodyBytes: 65_536 })
    const rows = auditOf('logs.settings')
    expect(rows.length).toBe(1)
    expect(rows[0]?.detail).toEqual({ changed: ['maxBodyBytes'] })
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('65536')
  })

  test('a change that breaks bodies-no-longer-than-figures is BAD_REQUEST and writes nothing', async () => {
    expect(await codeOf(run(procs.settings.set, { metaRetentionDays: 1 }, owner))).toBe(
      'BAD_REQUEST',
    )
    expect(
      (await run<unknown, { metaRetentionDays: number }>(procs.settings.get, undefined, owner))
        .metaRetentionDays,
    ).toBe(365)
    expect(await codeOf(run(procs.settings.set, { metaRetentionDays: 1 }, ana))).toBe('FORBIDDEN')
  })
})

describe('logs.sessions', () => {
  test('a member lists their own chat and the room sessions of rooms they are in, figures only', async () => {
    const page = await run<unknown, unknown>(procs.sessions, {}, ana)
    expect(LogsSessionsOutputSchema.parse(page).sessions.map((s) => s.id)).toEqual([
      'room:r1:g0',
      'front:ana',
    ])
    const bobs = await run<unknown, unknown>(procs.sessions, {}, bob)
    expect((bobs as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([
      'front:bob',
    ])
  })

  test('a member naming another person is FORBIDDEN, an unknown person is NOT_FOUND', async () => {
    expect(await codeOf(run(procs.sessions, { person: 'bob' }, ana))).toBe('FORBIDDEN')
    expect(await codeOf(run(procs.sessions, { person: 'nobody' }, ana))).toBe('NOT_FOUND')
    const own = await run<{ person: string }, { sessions: unknown[] }>(
      procs.sessions,
      { person: 'ana' },
      ana,
    )
    expect(own.sessions.length).toBe(2)
  })

  test('the owner lists everyone and each other person in it is an audited owner read; a person filter narrows it', async () => {
    const everyone = await run<{ person: string }, { sessions: { id: string }[] }>(
      procs.sessions,
      { person: 'everyone' },
      owner,
    )
    expect(everyone.sessions.map((s) => s.id).sort()).toEqual(
      ['front:ana', 'front:bob', 'guest:xyz', 'room:r1:g0'].sort(),
    )
    const reads = auditOf('logs.owner-read').filter(
      (r) => (r.detail as { scope?: string })?.scope === 'list',
    )
    expect(reads.map((r) => (r.detail as { subject?: string }).subject).sort()).toEqual(
      expect.arrayContaining(['ana', 'bob']),
    )
    const bobOnly = await run<{ person: string }, { sessions: { id: string }[] }>(
      procs.sessions,
      { person: 'bob' },
      owner,
    )
    expect(bobOnly.sessions.map((s) => s.id)).toEqual(['front:bob'])
    expect(await codeOf(run(procs.sessions, { person: 'nobody' }, owner))).toBe('NOT_FOUND')
  })

  test('the cursor pages through the rows without repeats', async () => {
    const first = await run<
      { person: string; limit: number },
      { sessions: { id: string }[]; nextCursor: string | null }
    >(procs.sessions, { person: 'everyone', limit: 2 }, owner)
    expect(first.sessions.length).toBe(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await run<
      { person: string; limit: number; cursor: string },
      { sessions: { id: string }[] }
    >(procs.sessions, { person: 'everyone', limit: 2, cursor: first.nextCursor as string }, owner)
    const ids = [...first.sessions, ...second.sessions].map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(4)
  })
})

describe('logs.session', () => {
  test('a member reads their own session with its generations; another person and a guest are NOT_FOUND', async () => {
    const detail = await run<
      { id: string },
      { generations: LlmCallRecord[]; more: boolean; session: { id: string } }
    >(procs.session, { id: 'front:ana' }, ana)
    expect(detail.session.id).toBe('front:ana')
    expect(detail.generations.map((c) => c.id)).toEqual(['c-ana-1', 'c-ana-2'])
    expect(detail.more).toBe(false)
    expect(await codeOf(run(procs.session, { id: 'front:bob' }, ana))).toBe('NOT_FOUND')
    expect(await codeOf(run(procs.session, { id: 'guest:xyz' }, ana))).toBe('NOT_FOUND')
    expect(await codeOf(run(procs.session, { id: 'front:missing' }, ana))).toBe('NOT_FOUND')
  })

  test('the owner reads another person session, and the read is audited with the person as subject', async () => {
    const detail = await run<{ id: string }, { session: { id: string } }>(
      procs.session,
      { id: 'front:bob' },
      owner,
    )
    expect(detail.session.id).toBe('front:bob')
    const rows = auditOf('logs.owner-read')
    expect(
      rows.some(
        (r) =>
          (r.detail as { subject?: string }).subject === 'bob' &&
          (r.detail as { scope?: string }).scope === 'session',
      ),
    ).toBe(true)
  })
})

describe('logs.call', () => {
  test('a member reads the messages sent, the tool calls and the output of their own call', async () => {
    const detail = await run<{ id: string }, unknown>(procs.call, { id: 'c-ana-1' }, ana)
    const out = LogsCallOutputSchema.parse(detail)
    expect(out.messages).toEqual([
      { role: 'system', text: 'be kind' },
      { role: 'user', text: 'hi from ana\n[file]' },
    ])
    expect(out.toolCalls).toEqual([{ toolCallId: 'tc1', toolName: 'search', input: '{"q":"x"}' }])
    expect(out.outputText).toBe('hello ana')
    expect(out.truncated).toBe(false)
  })

  test('another person call and an unknown call are NOT_FOUND for a member; the owner reads another call', async () => {
    expect(await codeOf(run(procs.call, { id: 'c-bob-1' }, ana))).toBe('NOT_FOUND')
    expect(await codeOf(run(procs.call, { id: 'c-missing' }, ana))).toBe('NOT_FOUND')
    const theirs = await run<{ id: string }, { messages: { text: string }[] }>(
      procs.call,
      { id: 'c-bob-1' },
      owner,
    )
    expect(theirs.messages[0]?.text).toBe('bob secret')
  })

  test('a call whose bodies were not kept has its figures and no messages', async () => {
    const detail = await run<{ id: string }, { call: LlmCallRecord; messages: unknown[] }>(
      procs.call,
      { id: 'c-ana-2' },
      ana,
    )
    expect(detail.call.bodyState).toBe('off')
    expect(detail.messages).toEqual([])
  })
})

describe('logs.raw', () => {
  test('a member reads the raw request and response of their own call', async () => {
    const raw = await run<
      { callId: string },
      { request: string; response: string; truncated: boolean }
    >(procs.raw, { callId: 'c-ana-1' }, ana)
    expect(JSON.parse(raw.request).options.prompt[0].content).toBe('be kind')
    expect(JSON.parse(raw.response)).toEqual({ id: 'resp-1' })
    expect(raw.truncated).toBe(false)
    expect(await codeOf(run(procs.raw, { callId: 'c-bob-1' }, ana))).toBe('NOT_FOUND')
  })

  test('every owner raw read is audited, never folded into a window', async () => {
    const before = auditOf('acl.owner-access').length
    await run(procs.raw, { callId: 'c-bob-1' }, owner)
    await run(procs.raw, { callId: 'c-bob-1' }, owner)
    expect(auditOf('acl.owner-access').length - before).toBeGreaterThanOrEqual(2)
    const rawReads = auditOf('logs.owner-read').filter(
      (r) => (r.detail as { scope?: string }).scope === 'raw',
    )
    expect(rawReads.length).toBe(2)
  })

  test('a raw body over the wire cap is cut and flagged', async () => {
    repo.insertCalls([
      {
        session: chat('ana'),
        call: figures({
          id: 'c-big',
          sessionId: 'front:ana',
          startedAt: T0 + 5000,
          bodyState: 'stored',
        }),
        bodies: bodiesOf(
          { prompt: [] },
          { text: '', reasoning: '', toolCalls: [] },
          { text: 'x'.repeat(MAX_RAW_WIRE_BYTES + 1000) },
        ),
      },
    ])
    const raw = await run<{ callId: string }, { response: string; truncated: boolean }>(
      procs.raw,
      { callId: 'c-big' },
      ana,
    )
    expect(raw.truncated).toBe(true)
    expect(Buffer.byteLength(raw.response)).toBeLessThanOrEqual(MAX_RAW_WIRE_BYTES)
  })
})

describe('logs.purge', () => {
  test('a member cannot purge another person; the owner purges a person and the rows go with one audit row', async () => {
    expect(await codeOf(run(procs.purge, { mode: 'all', person: 'bob' }, ana))).toBe('FORBIDDEN')
    expect(await codeOf(run(procs.purge, { mode: 'all', person: 'nobody' }, ana))).toBe('NOT_FOUND')
    const removed = await run<{ mode: 'all'; person: string }, { sessions: number; calls: number }>(
      procs.purge,
      { mode: 'all', person: 'bob' },
      owner,
    )
    expect(removed).toMatchObject({ sessions: 1, calls: 1 })
    expect(repo.getSession('front:bob')).toBeUndefined()
    const row = auditOf('logs.purge').find(
      (r) => (r.detail as { subject?: string }).subject === 'bob',
    )
    expect(row?.detail).toMatchObject({ mode: 'all', sessions: 1, calls: 1 })
  })

  test('a member purges their bodies: figures stay, the bodies go, the call is purged', async () => {
    const counts = await run<
      { mode: 'bodies' },
      { bodies: number; calls: number; sessions: number }
    >(procs.purge, { mode: 'bodies' }, ana)
    expect(counts.bodies).toBeGreaterThanOrEqual(2)
    expect(counts).toMatchObject({ calls: 0, sessions: 0 })
    const detail = await run<{ id: string }, { call: LlmCallRecord; messages: unknown[] }>(
      procs.call,
      { id: 'c-ana-1' },
      ana,
    )
    expect(detail.call.bodyState).toBe('purged')
    expect(detail.messages).toEqual([])
    const session = await run<{ id: string }, { session: { calls: number } }>(
      procs.session,
      { id: 'front:ana' },
      ana,
    )
    // three calls: the two of the chat and the one the raw-cap test added; the figures stay after the bodies went
    expect(session.session.calls).toBe(3)
  })
})
