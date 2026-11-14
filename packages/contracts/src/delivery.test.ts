import { describe, expect, test } from 'bun:test'
import {
  DELIVERY_ID_MAX,
  DeliveryFailedRecordSchema,
  DeliveryNeedsSchema,
  DeliveryOutcomeSchema,
  DeliveryRequestSchema,
} from './delivery.ts'

const request = {
  id: 'reminder:r1:2026-11-10T09:00:00Z',
  source: 'plugin:reminders',
  to: 'ana',
  name: 'reminder',
  text: 'pay the rent',
}

describe('delivery request', () => {
  test('needs default to one turn, best route, no capabilities', () => {
    const parsed = DeliveryRequestSchema.parse(request)
    expect(parsed.needs).toEqual({
      mode: 'wake',
      capabilities: [],
      fanout: 'best',
      urgency: 'normal',
    })
    expect(DeliveryNeedsSchema.parse({})).toEqual({
      mode: 'wake',
      capabilities: [],
      fanout: 'best',
      urgency: 'normal',
    })
  })

  test('the run id is at most 200 characters and never empty', () => {
    expect(
      DeliveryRequestSchema.safeParse({ ...request, id: 'x'.repeat(DELIVERY_ID_MAX) }).success,
    ).toBe(true)
    expect(
      DeliveryRequestSchema.safeParse({ ...request, id: 'x'.repeat(DELIVERY_ID_MAX + 1) }).success,
    ).toBe(false)
    expect(DeliveryRequestSchema.safeParse({ ...request, id: '' }).success).toBe(false)
  })

  test('capabilities hold at most five entries; mode and fanout are closed sets', () => {
    expect(
      DeliveryNeedsSchema.safeParse({ capabilities: ['a', 'b', 'c', 'd', 'e', 'f'] }).success,
    ).toBe(false)
    expect(DeliveryNeedsSchema.safeParse({ mode: 'note' }).success).toBe(true)
    expect(DeliveryNeedsSchema.safeParse({ mode: 'shout' }).success).toBe(false)
    expect(DeliveryNeedsSchema.safeParse({ fanout: 'all' }).success).toBe(true)
    expect(DeliveryNeedsSchema.safeParse({ fanout: 'some' }).success).toBe(false)
  })

  test('a failure notice names its creator, a text and a key (at most 120 characters)', () => {
    const ok = DeliveryRequestSchema.safeParse({
      ...request,
      onFailure: { to: 'owner', text: 'could not deliver', key: 'r1:2026-11-10' },
    })
    expect(ok.success).toBe(true)
    expect(
      DeliveryRequestSchema.safeParse({
        ...request,
        onFailure: { to: 'owner', text: 'x', key: 'k'.repeat(121) },
      }).success,
    ).toBe(false)
  })

  test('text is required and bounded', () => {
    expect(DeliveryRequestSchema.safeParse({ ...request, text: '' }).success).toBe(false)
    expect(DeliveryRequestSchema.safeParse({ ...request, text: 'x'.repeat(4001) }).success).toBe(
      false,
    )
  })
})

describe('delivery outcome', () => {
  test('delivered, queued and failed are the only statuses, with their fields', () => {
    expect(
      DeliveryOutcomeSchema.safeParse({ status: 'delivered', route: 'front', attempts: 1 }).success,
    ).toBe(true)
    expect(
      DeliveryOutcomeSchema.safeParse({
        status: 'queued',
        reason: 'unavailable',
        nextAttemptAt: 1,
      }).success,
    ).toBe(true)
    expect(
      DeliveryOutcomeSchema.safeParse({ status: 'failed', reason: 'budget', attempts: 1 }).success,
    ).toBe(true)
    expect(
      DeliveryOutcomeSchema.safeParse({ status: 'failed', reason: 'gone', attempts: 1 }).success,
    ).toBe(false)
    expect(
      DeliveryOutcomeSchema.safeParse({ status: 'queued', reason: 'budget', nextAttemptAt: 1 })
        .success,
    ).toBe(false)
  })
})

describe('delivery failed record', () => {
  test('names the person, the run, the source and the reason, and nothing else', () => {
    const record = {
      personId: 'ana',
      deliveryId: 'reminder:r1',
      source: 'plugin:reminders',
      reason: 'recipient-gone',
    } as const
    expect(DeliveryFailedRecordSchema.parse(record)).toEqual(record)
    expect(DeliveryFailedRecordSchema.safeParse({ ...record, text: 'pay the rent' }).success).toBe(
      true,
    )
    expect(DeliveryFailedRecordSchema.safeParse({ ...record, reason: 'lost' }).success).toBe(false)
  })
})
