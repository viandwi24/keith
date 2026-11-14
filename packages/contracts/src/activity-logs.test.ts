import { describe, expect, test } from 'bun:test'
import {
  LlmCallRecordSchema,
  LlmSessionRecordSchema,
  LOGS_OWNER_READ,
  LOGS_PURGE,
  LOGS_SETTINGS,
  LogsCallOutputSchema,
  LogsOwnerReadAuditDetailSchema,
  LogsPurgeInputSchema,
  LogsSessionsInputSchema,
  LogsSettingsSchema,
  LogsSettingsSetSchema,
  MAX_RAW_WIRE_BYTES,
} from './activity-logs.ts'
import { AUDIT_SUBJECT_FIELDS } from './audit.ts'

const call = {
  id: '0190f2a4-7b1c-7d2e-8f3a-9b0c1d2e3f4a',
  sessionId: 'front:ana',
  kind: 'step',
  trigger: 'send',
  turnId: 'turn-1',
  stepIndex: 0,
  startedAt: Date.UTC(2026, 10, 11, 9),
  durationMs: 1200,
  firstChunkMs: 300,
  status: 'ok',
  finishReason: 'stop',
  modelId: 'model-a',
  provider: 'openrouter',
  upstreamProvider: null,
  tokensIn: 100,
  tokensOut: 20,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  costMicro: 1500,
  costSource: 'provider',
  fallbackNote: null,
  errorName: null,
  errorMessage: null,
  requestBytes: 900,
  responseBytes: 400,
  bodyState: 'stored',
  speakerId: null,
}

const session = {
  id: 'front:ana',
  kind: 'chat',
  personId: 'ana',
  roomId: null,
  app: 'Front',
  firstAt: Date.UTC(2026, 10, 11, 9),
  lastAt: Date.UTC(2026, 10, 11, 10),
  calls: 3,
  costMicro: 4200,
  primaryModel: 'model-a',
  primaryProvider: 'openrouter',
}

describe('call and session records', () => {
  test('a call and a session parse; an unknown field is refused (strict)', () => {
    expect(LlmCallRecordSchema.safeParse(call).success).toBe(true)
    expect(LlmCallRecordSchema.safeParse({ ...call, prompt: 'hi' }).success).toBe(false)
    expect(LlmSessionRecordSchema.safeParse(session).success).toBe(true)
    expect(LlmSessionRecordSchema.safeParse({ ...session, kind: 'node' }).success).toBe(false)
  })

  test('the closed sets: a call kind, a status and a body state outside the list are refused', () => {
    expect(LlmCallRecordSchema.safeParse({ ...call, kind: 'judge' }).success).toBe(false)
    expect(LlmCallRecordSchema.safeParse({ ...call, status: 'timeout' }).success).toBe(false)
    expect(LlmCallRecordSchema.safeParse({ ...call, bodyState: 'kept' }).success).toBe(false)
    expect(LlmCallRecordSchema.safeParse({ ...call, trigger: 'user' }).success).toBe(false)
  })

  test('cost is integer micro-dollars: a fraction is refused', () => {
    expect(LlmCallRecordSchema.safeParse({ ...call, costMicro: 1.5 }).success).toBe(false)
    expect(LlmCallRecordSchema.safeParse({ ...call, costMicro: -1 }).success).toBe(false)
  })
})

describe('filters with a cursor', () => {
  test('every filter is optional; the page is 1 to 100 rows; from is not after to', () => {
    expect(LogsSessionsInputSchema.safeParse({}).success).toBe(true)
    expect(
      LogsSessionsInputSchema.safeParse({ kind: 'room', cursor: 'abc', limit: 100 }).success,
    ).toBe(true)
    expect(LogsSessionsInputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(LogsSessionsInputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(LogsSessionsInputSchema.safeParse({ kind: 'judge' }).success).toBe(false)
    expect(LogsSessionsInputSchema.safeParse({ from: 10, to: 5 }).success).toBe(false)
    expect(LogsSessionsInputSchema.safeParse({ from: 5, to: 10 }).success).toBe(true)
    expect(LogsSessionsInputSchema.safeParse({ extra: 1 }).success).toBe(false)
  })
})

describe('settings', () => {
  test('defaults: bodies on for people, off for guests; 14 and 365 days; 512 KB per body', () => {
    const parsed = LogsSettingsSchema.parse({})
    expect(parsed).toEqual({
      captureBodies: true,
      guestBodies: false,
      bodyRetentionDays: 14,
      metaRetentionDays: 365,
      maxBodyBytes: 524288,
    })
  })

  test('the bounds hold; bodies never outlive the figures', () => {
    expect(LogsSettingsSchema.safeParse({ bodyRetentionDays: 0 }).success).toBe(false)
    expect(LogsSettingsSchema.safeParse({ bodyRetentionDays: 91 }).success).toBe(false)
    expect(LogsSettingsSchema.safeParse({ metaRetentionDays: 3651 }).success).toBe(false)
    expect(LogsSettingsSchema.safeParse({ maxBodyBytes: 1024 }).success).toBe(false)
    expect(LogsSettingsSchema.safeParse({ maxBodyBytes: 5 * 1024 * 1024 }).success).toBe(false)
    expect(
      LogsSettingsSchema.safeParse({ bodyRetentionDays: 30, metaRetentionDays: 10 }).success,
    ).toBe(false)
    expect(
      LogsSettingsSchema.safeParse({ bodyRetentionDays: 10, metaRetentionDays: 10 }).success,
    ).toBe(true)
  })

  test('a change names only the fields given; an empty change is refused; the rule holds for a change too', () => {
    expect(LogsSettingsSetSchema.parse({ captureBodies: false })).toEqual({ captureBodies: false })
    expect(LogsSettingsSetSchema.safeParse({}).success).toBe(false)
    expect(
      LogsSettingsSetSchema.safeParse({ bodyRetentionDays: 30, metaRetentionDays: 10 }).success,
    ).toBe(false)
    expect(LogsSettingsSetSchema.safeParse({ captureBodies: 'yes' }).success).toBe(false)
  })
})

describe('call detail, purge and the wire cap', () => {
  test('the detail carries the messages and no unknown field', () => {
    const detail = {
      call,
      messages: [{ role: 'user', text: 'hello' }],
      toolCalls: [],
      outputText: 'hi',
      reasoning: '',
      truncated: false,
    }
    expect(LogsCallOutputSchema.safeParse(detail).success).toBe(true)
    expect(LogsCallOutputSchema.safeParse({ ...detail, raw: {} }).success).toBe(false)
  })

  test('purge takes bodies or all, and an optional person', () => {
    expect(LogsPurgeInputSchema.safeParse({ mode: 'bodies' }).success).toBe(true)
    expect(LogsPurgeInputSchema.safeParse({ mode: 'all', person: 'ana' }).success).toBe(true)
    expect(LogsPurgeInputSchema.safeParse({ mode: 'figures' }).success).toBe(false)
  })

  test('the raw wire cap is 256 KB', () => {
    expect(MAX_RAW_WIRE_BYTES).toBe(256 * 1024)
  })
})

describe('audit (ADR-0032 §8)', () => {
  test('the owner-read and purge kinds name the subject; the settings kind names none', () => {
    expect(LOGS_OWNER_READ).toBe('logs.owner-read')
    expect(LOGS_PURGE).toBe('logs.purge')
    expect(LOGS_SETTINGS).toBe('logs.settings')
    expect(AUDIT_SUBJECT_FIELDS['logs.owner-read']).toEqual(['subject'])
    expect(AUDIT_SUBJECT_FIELDS['logs.purge']).toEqual(['subject'])
    expect(AUDIT_SUBJECT_FIELDS['logs.settings']).toEqual([])
  })

  test('an owner-read detail carries the scope and ids, never content', () => {
    expect(
      LogsOwnerReadAuditDetailSchema.safeParse({ subject: 'ana', scope: 'raw', callId: 'c1' })
        .success,
    ).toBe(true)
    expect(
      LogsOwnerReadAuditDetailSchema.safeParse({ subject: 'ana', scope: 'raw', text: 'secret' })
        .success,
    ).toBe(false)
    expect(
      LogsOwnerReadAuditDetailSchema.safeParse({ subject: 'ana', scope: 'dump' }).success,
    ).toBe(false)
  })
})
