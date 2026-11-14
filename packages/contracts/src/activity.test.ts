import { describe, expect, test } from 'bun:test'
import {
  ACTIVITY_RECORD_SCHEMAS,
  BUDGET_CHANGED,
  BudgetChangedRecordSchema,
  IDENTITY_CHANGED,
  ROOM_EVENT,
  ROOM_INDICATOR,
  RoomEventRecordSchema,
  RoomIndicatorRecordSchema,
} from './activity.ts'
import { CHAT_CONTEXT_CHANGED, CHAT_CONTEXT_PENDING } from './chat-context.ts'
import { DELIVERY_FAILED } from './delivery.ts'
import { NODE_CHANGED } from './nodes.ts'
import { PERSONA_CHANGED } from './persona.ts'
import { TASK_CHANGED } from './tasks.ts'

const status = {
  scope: 'owner',
  limitUsd: 20,
  spentUsd: 1.5,
  reservedUsd: 0,
  remainingUsd: 18.5,
  periodStart: 1_000,
  periodEnd: 2_000,
  unpriced: [],
}

const node = {
  id: 'node-1',
  name: 'laptop',
  os: 'darwin',
  arch: 'arm64',
  version: '0.1.0',
  capabilities: [],
  allowShell: false,
  status: 'online',
  lastSeenAt: 1_500,
  createdAt: 1_000,
}

describe('activity record contracts', () => {
  test('the table has one schema for each contracted record type', () => {
    expect(Object.keys(ACTIVITY_RECORD_SCHEMAS).sort()).toEqual(
      [
        NODE_CHANGED,
        BUDGET_CHANGED,
        TASK_CHANGED,
        IDENTITY_CHANGED,
        DELIVERY_FAILED,
        ROOM_EVENT,
        ROOM_INDICATOR,
        PERSONA_CHANGED,
        CHAT_CONTEXT_CHANGED,
        CHAT_CONTEXT_PENDING,
      ].sort(),
    )
  })

  test('budget-changed: the global record has no personId, a person cap stamps it', () => {
    expect(BudgetChangedRecordSchema.safeParse({ status }).success).toBe(true)
    expect(BudgetChangedRecordSchema.safeParse({ status, personId: 'p1' }).success).toBe(true)
    expect(BudgetChangedRecordSchema.safeParse({ limitUsd: 20 }).success).toBe(false)
  })

  test('node-changed parses the node the emitter writes', () => {
    const schema = ACTIVITY_RECORD_SCHEMAS[NODE_CHANGED]
    expect(schema.safeParse({ node }).success).toBe(true)
    expect(schema.safeParse({ node: { id: 'x' } }).success).toBe(false)
  })

  test('room.indicator carries the recipient and the room, and neither the indicator nor text', () => {
    const schema = ACTIVITY_RECORD_SCHEMAS[ROOM_INDICATOR]
    const roomId = '0b6f9a2e-6d1c-4f0e-9a55-2f1d3c4b5a6e'
    expect(schema.safeParse({ to: 'ana', roomId }).success).toBe(true)
    expect(RoomIndicatorRecordSchema.safeParse({ to: '', roomId }).success).toBe(false)
    expect(RoomIndicatorRecordSchema.safeParse({ to: 'ana', roomId: 'room-1' }).success).toBe(false)
    expect(
      RoomIndicatorRecordSchema.parse({ to: 'ana', roomId, kind: 'thinking', text: 'hi' }),
    ).toEqual({ to: 'ana', roomId })
  })

  test('room.event carries the recipient, the room and the position, and no text', () => {
    const schema = ACTIVITY_RECORD_SCHEMAS[ROOM_EVENT]
    const roomId = '0b6f9a2e-6d1c-4f0e-9a55-2f1d3c4b5a6e'
    expect(schema.safeParse({ to: 'ana', roomId, seq: 3 }).success).toBe(true)
    expect(RoomEventRecordSchema.safeParse({ to: 'ana', roomId, seq: 0 }).success).toBe(false)
    expect(RoomEventRecordSchema.safeParse({ to: 'ana', roomId: 'room-1', seq: 3 }).success).toBe(
      false,
    )
    expect(
      RoomEventRecordSchema.parse({ to: 'ana', roomId, seq: 3, text: 'hi' }),
    ).not.toHaveProperty('text')
  })
})
