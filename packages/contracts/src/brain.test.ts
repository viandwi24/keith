import { describe, expect, test } from 'bun:test'
import {
  AmygdalaWaitPayloadSchema,
  BRAIN_EVENT_TYPES,
  BrainRegionSchema,
  BrocaEndPayloadSchema,
  HippocampusRecallPayloadSchema,
  HippocampusWritePayloadSchema,
  parseBrainEvent,
  ThalamusRoutedPayloadSchema,
} from './brain.ts'

describe('brain events', () => {
  test('regions cover the twelve brain regions, parietal, hypothalamus, corpus-callosum and prefrontal included', () => {
    expect(BrainRegionSchema.options).toHaveLength(12)
    expect(BrainRegionSchema.safeParse('prefrontal').success).toBe(true)
    expect(BrainRegionSchema.safeParse('corpus-callosum').success).toBe(true)
    expect(BrainRegionSchema.safeParse('parietal').success).toBe(true)
    expect(BrainRegionSchema.safeParse('hypothalamus').success).toBe(true)
    expect(BrainRegionSchema.safeParse('liver').success).toBe(false)
  })

  test('thalamus preview is capped at 120 characters', () => {
    const base = { region: 'thalamus', sessionId: 's1' }
    expect(
      ThalamusRoutedPayloadSchema.safeParse({ ...base, preview: 'a'.repeat(120) }).success,
    ).toBe(true)
    expect(
      ThalamusRoutedPayloadSchema.safeParse({ ...base, preview: 'a'.repeat(121) }).success,
    ).toBe(false)
  })

  test('broca end needs a stop reason', () => {
    expect(
      BrocaEndPayloadSchema.safeParse({ region: 'broca', turnId: 't', kind: 'send' }).success,
    ).toBe(false)
  })

  test('parseBrainEvent returns typed events', () => {
    const event = parseBrainEvent({
      type: 'brain.motor.act',
      payload: { region: 'motor', toolName: 'web_fetch', ok: true },
    })
    expect(event?.type).toBe('brain.motor.act')
    const ras = parseBrainEvent({
      type: 'brain.ras.deliver',
      payload: { region: 'ras', taskId: 'x' },
    })
    expect(ras?.payload).toEqual({ region: 'ras', taskId: 'x' })
  })

  test('parseBrainEvent never throws on unknown or malformed input', () => {
    expect(parseBrainEvent({ type: 'task-changed', payload: {} })).toBeUndefined()
    expect(
      parseBrainEvent({ type: 'brain.motor.act', payload: { region: 'motor' } }),
    ).toBeUndefined()
    expect(parseBrainEvent({ type: 'brain.motor.act', payload: null })).toBeUndefined()
    expect(parseBrainEvent({ type: 'brain.broca.end', payload: 'oops' })).toBeUndefined()
    expect(parseBrainEvent(undefined as never)).toBeUndefined()
  })

  test('every declared type parses a minimal payload', () => {
    const payloads: Record<string, unknown> = {
      'brain.thalamus.routed': { region: 'thalamus', sessionId: 's', preview: 'hi' },
      'brain.wernicke.start': { region: 'wernicke', turnId: 't', kind: 'send' },
      'brain.broca.start': { region: 'broca', turnId: 't', kind: 'send' },
      'brain.broca.end': { region: 'broca', turnId: 't', kind: 'send', stop: 'end' },
      'brain.cortex.start': {
        region: 'cortex',
        taskId: 'k',
        agent: 'cortex.research',
        description: 'd',
      },
      'brain.cortex.step': {
        region: 'cortex',
        taskId: 'k',
        agent: 'a',
        description: 'd',
        stepIndex: 0,
      },
      'brain.cortex.end': {
        region: 'cortex',
        taskId: 'k',
        agent: 'a',
        description: 'd',
        status: 'done',
        summary: 's',
      },
      'brain.motor.act': { region: 'motor', toolName: 'x', ok: false },
      'brain.amygdala.decide': { region: 'amygdala', toolName: 'x', approved: true, by: 'policy' },
      'brain.amygdala.wait': { region: 'amygdala', toolName: 'x', sessionId: 's', count: 1 },
      'brain.amygdala.expired': { region: 'amygdala', sessionId: 's', approvalId: 'a1' },
      'brain.ras.deliver': { region: 'ras', taskId: 'k', messageId: 'm' },
      'brain.hippocampus.write': { region: 'hippocampus', op: 'create', path: '/memories/a.md' },
      'brain.hippocampus.recall': { region: 'hippocampus', path: '/memories', taskId: 't' },
      'brain.parietal.presence': {
        region: 'parietal',
        personId: 'ana',
        state: 'busy',
        previous: null,
      },
      'brain.parietal.deliver': {
        region: 'parietal',
        clientId: '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
        deliveryId: 'reminder:r1:2026-11-10T09:00:00Z',
        capability: 'notify',
        name: 'reminder',
      },
      'brain.hypothalamus.fire': {
        region: 'hypothalamus',
        protocolId: 'p1',
        runId: 'r1',
        trigger: 'time',
      },
      'brain.hypothalamus.step': {
        region: 'hypothalamus',
        runId: 'r1',
        step: 'remind',
        kind: 'notify',
        outcome: 'ok',
      },
      'brain.hypothalamus.wait': { region: 'hypothalamus', runId: 'r1', wakeAt: 1_800_000_000_000 },
      'brain.hypothalamus.end': { region: 'hypothalamus', runId: 'r1', status: 'done' },
      'brain.corpus-callosum.invite': {
        region: 'corpus-callosum',
        roomId: '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
      },
      'brain.corpus-callosum.join': {
        region: 'corpus-callosum',
        roomId: '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
      },
      'brain.corpus-callosum.turn': {
        region: 'corpus-callosum',
        roomId: '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
        speakerId: 'ana',
        stop: 'end',
      },
      'brain.corpus-callosum.end': {
        region: 'corpus-callosum',
        roomId: '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
        reason: 'ended',
      },
      'brain.prefrontal.change': { region: 'prefrontal', version: 2, reason: 'edit' },
      'brain.prefrontal.style': {
        region: 'prefrontal',
        personId: 'ana',
        fields: ['address', 'brevity'],
      },
      'brain.hippocampus.dream': {
        region: 'hippocampus',
        runId: 'r1',
        trigger: 'schedule',
        candidates: 4,
        promoted: 1,
        merged: 0,
        superseded: 1,
        dropped: 2,
        applied: false,
      },
    }
    for (const type of BRAIN_EVENT_TYPES) {
      expect(parseBrainEvent({ type, payload: payloads[type] })?.type).toBe(type)
    }
  })

  test('the amygdala wait carries the approval id and its expiry; the expired event carries the approval id', () => {
    const wait = {
      type: 'brain.amygdala.wait',
      payload: {
        region: 'amygdala',
        toolName: 'motor_remote',
        sessionId: 'front:owner:agent:c1',
        count: 1,
        approvalId: 'a1',
        expiresAt: 1_700_000_000_000,
      },
    }
    expect(parseBrainEvent(wait)).toMatchObject({
      payload: { approvalId: 'a1', expiresAt: 1_700_000_000_000 },
    })
    // a row written before P24 has neither: still a valid wait
    expect(
      parseBrainEvent({ type: wait.type, payload: { ...wait.payload, approvalId: undefined } }),
    ).toBeDefined()
    expect(
      parseBrainEvent({
        type: 'brain.amygdala.expired',
        payload: { region: 'amygdala', sessionId: 's', approvalId: 'a1' },
      })?.type,
    ).toBe('brain.amygdala.expired')
    expect(
      parseBrainEvent({
        type: 'brain.amygdala.expired',
        payload: { region: 'amygdala', sessionId: 's' },
      }),
    ).toBeUndefined()
  })

  test('parietal events take a known state and a client capability id', () => {
    const presence = { region: 'parietal', personId: 'ana', state: 'active', previous: 'idle' }
    expect(parseBrainEvent({ type: 'brain.parietal.presence', payload: presence })?.type).toBe(
      'brain.parietal.presence',
    )
    expect(
      parseBrainEvent({
        type: 'brain.parietal.presence',
        payload: { ...presence, state: 'sleeping' },
      }),
    ).toBeUndefined()
    const deliver = {
      region: 'parietal',
      clientId: 'c1',
      deliveryId: 'd1',
      capability: 'open.view',
      name: 'protocol',
    }
    expect(parseBrainEvent({ type: 'brain.parietal.deliver', payload: deliver })?.type).toBe(
      'brain.parietal.deliver',
    )
    expect(
      parseBrainEvent({
        type: 'brain.parietal.deliver',
        payload: { ...deliver, capability: 'Notify' },
      }),
    ).toBeUndefined()
  })

  test('hypothalamus events take a trigger kind, a step outcome and a run status', () => {
    const fire = {
      region: 'hypothalamus',
      protocolId: 'p1',
      runId: 'r1',
      trigger: 'event',
    }
    expect(parseBrainEvent({ type: 'brain.hypothalamus.fire', payload: fire })?.type).toBe(
      'brain.hypothalamus.fire',
    )
    expect(
      parseBrainEvent({
        type: 'brain.hypothalamus.fire',
        payload: { ...fire, trigger: 'cron' },
      }),
    ).toBeUndefined()
    const step = { region: 'hypothalamus', runId: 'r1', step: 'ask', kind: 'ask', outcome: 'ok' }
    expect(parseBrainEvent({ type: 'brain.hypothalamus.step', payload: step })?.type).toBe(
      'brain.hypothalamus.step',
    )
    for (const outcome of [
      'answered:yes',
      'refused:budget',
      'failed:plugin',
      'timeout',
      'unknown',
    ]) {
      expect(
        parseBrainEvent({ type: 'brain.hypothalamus.step', payload: { ...step, outcome } })?.type,
      ).toBe('brain.hypothalamus.step')
    }
    expect(
      parseBrainEvent({
        type: 'brain.hypothalamus.step',
        payload: { ...step, outcome: 'Hello there' },
      }),
    ).toBeUndefined()
    expect(
      parseBrainEvent({
        type: 'brain.hypothalamus.end',
        payload: { region: 'hypothalamus', runId: 'r1', status: 'sleeping' },
      }),
    ).toBeUndefined()
    expect(
      parseBrainEvent({
        type: 'brain.hypothalamus.wait',
        payload: { region: 'hypothalamus', runId: 'r1', wakeAt: 1.5 },
      }),
    ).toBeUndefined()
  })

  test('amygdala wait needs a non-negative count', () => {
    const base = { region: 'amygdala', toolName: 'motor_remote', sessionId: 's' }
    expect(AmygdalaWaitPayloadSchema.safeParse({ ...base, count: 2 }).success).toBe(true)
    expect(AmygdalaWaitPayloadSchema.safeParse({ ...base, count: -1 }).success).toBe(false)
    expect(AmygdalaWaitPayloadSchema.safeParse(base).success).toBe(false)
  })

  test('hippocampus write takes a known op and an optional task', () => {
    const base = { region: 'hippocampus', path: '/memories/a.md' }
    for (const op of ['create', 'str_replace', 'insert', 'delete', 'rename']) {
      expect(HippocampusWritePayloadSchema.safeParse({ ...base, op }).success).toBe(true)
    }
    expect(HippocampusWritePayloadSchema.safeParse({ ...base, op: 'view' }).success).toBe(false)
    expect(
      HippocampusWritePayloadSchema.safeParse({ ...base, op: 'create', taskId: 't' }).success,
    ).toBe(true)
    expect(
      HippocampusWritePayloadSchema.safeParse({ region: 'hippocampus', op: 'create' }).success,
    ).toBe(false)
  })

  test('hippocampus recall needs a path', () => {
    expect(
      HippocampusRecallPayloadSchema.safeParse({ region: 'hippocampus', path: '/m' }).success,
    ).toBe(true)
    expect(HippocampusRecallPayloadSchema.safeParse({ region: 'hippocampus' }).success).toBe(false)
    expect(
      parseBrainEvent({
        type: 'brain.hippocampus.recall',
        payload: { region: 'motor', path: '/m' },
      }),
    ).toBeUndefined()
  })

  test('corpus-callosum events take a room id; the turn needs a speaker and the stop is optional', () => {
    const roomId = '5f1c1d6e-2a4b-4c8d-9e0f-1a2b3c4d5e6f'
    const turn = { region: 'corpus-callosum', roomId, speakerId: 'ana' }
    expect(parseBrainEvent({ type: 'brain.corpus-callosum.turn', payload: turn })?.type).toBe(
      'brain.corpus-callosum.turn',
    )
    expect(
      parseBrainEvent({
        type: 'brain.corpus-callosum.turn',
        payload: { ...turn, speakerId: undefined },
      }),
    ).toBeUndefined()
    expect(
      parseBrainEvent({
        type: 'brain.corpus-callosum.join',
        payload: { region: 'corpus-callosum', roomId: 'room-1' },
      }),
    ).toBeUndefined()
    expect(
      parseBrainEvent({
        type: 'brain.corpus-callosum.end',
        payload: { region: 'corpus-callosum', roomId, reason: '' },
      }),
    ).toBeUndefined()
  })

  test('prefrontal events name the version or the person and the changed fields, never a value', () => {
    expect(
      parseBrainEvent({
        type: 'brain.prefrontal.change',
        payload: { region: 'prefrontal', version: 3, reason: 'restore', tone: 'curt' },
      }),
    ).toEqual({
      type: 'brain.prefrontal.change',
      payload: { region: 'prefrontal', version: 3, reason: 'restore' },
    })
    expect(
      parseBrainEvent({
        type: 'brain.prefrontal.change',
        payload: { region: 'prefrontal', version: 0, reason: 'edit' },
      }),
    ).toBeUndefined()
    const style = { region: 'prefrontal' as const, personId: 'ana' }
    expect(
      parseBrainEvent({
        type: 'brain.prefrontal.style',
        payload: { ...style, fields: ['address'] },
      })?.type,
    ).toBe('brain.prefrontal.style')
    expect(
      parseBrainEvent({ type: 'brain.prefrontal.style', payload: { ...style, fields: [] } }),
    ).toBeUndefined()
    expect(
      parseBrainEvent({
        type: 'brain.prefrontal.style',
        payload: { ...style, fields: ['address'], address: 'Ana' },
      }),
    ).toEqual({
      type: 'brain.prefrontal.style',
      payload: { ...style, fields: ['address'] },
    })
  })
})
