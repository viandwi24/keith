import { describe, expect, test } from 'bun:test'
import { ACTIVITY_RECORD_SCHEMAS } from './activity.ts'
import { AUDIT_SUBJECT_FIELDS } from './audit.ts'
import {
  CHAT_CONTEXT_CHANGED,
  CHAT_CONTEXT_COMPACT,
  CHAT_CONTEXT_NEW,
  CHAT_CONTEXT_REFUSAL_REASONS,
  CHAT_HISTORY_LIMIT_MAX,
  ChatCompactInputSchema,
  ChatContextAuditDetailSchema,
  ChatContextChangedRecordSchema,
  ChatContextRefusalDataSchema,
  ChatContextRefusalReasonSchema,
  ChatGenerationsOutputSchema,
  ChatHistoryInputSchema,
  ChatHistoryOutputSchema,
  ChatNewContextInputSchema,
  ChatNewContextOutputSchema,
} from './chat-context.ts'
import { keithContract } from './contract.ts'

describe('chat.newContext', () => {
  test('flush defaults to true', () => {
    const parsed = ChatNewContextInputSchema.parse({})
    expect(parsed.flush).toBe(true)
  })

  test('flush false is accepted; a non-boolean flush is refused', () => {
    expect(ChatNewContextInputSchema.parse({ flush: false }).flush).toBe(false)
    expect(ChatNewContextInputSchema.safeParse({ flush: 'yes' }).success).toBe(false)
    expect(ChatNewContextInputSchema.safeParse({ flush: 1 }).success).toBe(false)
    expect(ChatNewContextInputSchema.safeParse({ flush: null }).success).toBe(false)
  })

  test('the output is a generation and the flush flag', () => {
    expect(ChatNewContextOutputSchema.safeParse({ generation: 2, flushed: true }).success).toBe(
      true,
    )
    expect(ChatNewContextOutputSchema.safeParse({ generation: -1, flushed: true }).success).toBe(
      false,
    )
  })
})

describe('chat.compact', () => {
  test('keepLast 0 is refused; 1 is the smallest accepted value', () => {
    expect(ChatCompactInputSchema.safeParse({ keepLast: 0 }).success).toBe(false)
    expect(ChatCompactInputSchema.safeParse({ keepLast: 1 }).success).toBe(true)
  })

  test('keepLast must be an integer; it may be left out', () => {
    expect(ChatCompactInputSchema.safeParse({ keepLast: 2.5 }).success).toBe(false)
    expect(ChatCompactInputSchema.safeParse({}).success).toBe(true)
  })
})

describe('chat.generations and chat.history', () => {
  test('generations list the number, the start time, the message count and the compactions', () => {
    const ok = ChatGenerationsOutputSchema.safeParse([
      { generation: 0, startedAt: 1, messages: 4, compactions: 2 },
      { generation: 1, startedAt: 2, messages: 0, compactions: 0 },
    ])
    expect(ok.success).toBe(true)
    expect(
      ChatGenerationsOutputSchema.safeParse([
        { generation: 0, startedAt: 1, messages: -1, compactions: 0 },
      ]).success,
    ).toBe(false)
    // a row without the count is not a generation of this contract
    expect(
      ChatGenerationsOutputSchema.safeParse([{ generation: 0, startedAt: 1, messages: 4 }]).success,
    ).toBe(false)
  })

  test('history reads one generation, with a bounded limit', () => {
    expect(ChatHistoryInputSchema.safeParse({ generation: 0 }).success).toBe(true)
    expect(
      ChatHistoryInputSchema.safeParse({ generation: 1, limit: CHAT_HISTORY_LIMIT_MAX }).success,
    ).toBe(true)
    expect(
      ChatHistoryInputSchema.safeParse({ generation: 1, limit: CHAT_HISTORY_LIMIT_MAX + 1 })
        .success,
    ).toBe(false)
    expect(ChatHistoryInputSchema.safeParse({ generation: 1, limit: 0 }).success).toBe(false)
  })

  test('a history message has a closed role list and its text and time', () => {
    const message = { seq: 1, role: 'user', text: 'hello', at: 10 }
    expect(ChatHistoryOutputSchema.safeParse([message]).success).toBe(true)
    expect(ChatHistoryOutputSchema.safeParse([{ ...message, role: 'tool' }]).success).toBe(false)
  })
})

describe('refusal reasons', () => {
  test('the four reasons are the closed list of ADR-0030 §3', () => {
    expect([...CHAT_CONTEXT_REFUSAL_REASONS]).toEqual([
      'turn-running',
      'approval-pending',
      'task-running',
      'flush-failed',
    ])
  })

  test('an unknown reason is refused, a known one is accepted', () => {
    expect(ChatContextRefusalReasonSchema.safeParse('flush-failed').success).toBe(true)
    expect(ChatContextRefusalReasonSchema.safeParse('worker-running').success).toBe(false)
    expect(ChatContextRefusalDataSchema.safeParse({ reason: 'unknown' }).success).toBe(false)
    expect(ChatContextRefusalDataSchema.safeParse({ reason: 'turn-running' }).success).toBe(true)
  })
})

describe('audit and activity', () => {
  test('the two audit kinds name the subject only', () => {
    expect(CHAT_CONTEXT_NEW).toBe('chat.context.new')
    expect(CHAT_CONTEXT_COMPACT).toBe('chat.context.compact')
    expect(AUDIT_SUBJECT_FIELDS[CHAT_CONTEXT_NEW]).toEqual(['subject'])
    expect(AUDIT_SUBJECT_FIELDS[CHAT_CONTEXT_COMPACT]).toEqual(['subject'])
  })

  test('the audit detail holds the subject, the generation and the flag, and no text', () => {
    const detail = { subject: 'ana', generation: 1, flushed: false }
    expect(ChatContextAuditDetailSchema.safeParse(detail).success).toBe(true)
    expect(ChatContextAuditDetailSchema.safeParse({ ...detail, text: 'my secret' }).success).toBe(
      true,
    )
    expect(ChatContextAuditDetailSchema.parse({ ...detail, text: 'x' })).not.toHaveProperty('text')
    expect(ChatContextAuditDetailSchema.safeParse({ generation: 1, flushed: false }).success).toBe(
      false,
    )
  })

  test('the activity record carries the generation only, and is registered', () => {
    expect(CHAT_CONTEXT_CHANGED).toBe('chat.context.changed')
    expect(ChatContextChangedRecordSchema.safeParse({ generation: 1 }).success).toBe(true)
    expect(ChatContextChangedRecordSchema.safeParse({ generation: 0 }).success).toBe(false)
    expect(ACTIVITY_RECORD_SCHEMAS[CHAT_CONTEXT_CHANGED]).toBe(ChatContextChangedRecordSchema)
  })
})

describe('the chat area', () => {
  test('the four procedures are chat-capability calls with no step-up', () => {
    const chat = keithContract.chat
    for (const procedure of [chat.newContext, chat.compact, chat.generations, chat.history]) {
      const meta = procedure['~orpc'].meta as { capability?: string; stepUp?: boolean }
      expect(meta.capability).toBe('chat')
      expect(meta.stepUp).toBeUndefined()
    }
  })
})
