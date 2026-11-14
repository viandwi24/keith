import { describe, expect, test } from 'bun:test'
import { type BrainEvent, parseBrainEvent } from '@keith/contracts'
import {
  describeEvent,
  initialBrain,
  lampOf,
  reduceBrain,
  resyncBrain,
  TRACE_LIMIT,
  viewKey,
  viewOf,
} from './brain-state.ts'

const event = (type: string, payload: unknown): BrainEvent => {
  const parsed = parseBrainEvent({ type, payload })
  if (parsed === undefined) throw new Error(`bad fixture ${type}`)
  return parsed
}
const routed = event('brain.thalamus.routed', {
  region: 'thalamus',
  sessionId: 'front:p1',
  preview: 'hello',
})
const cortex = (type: string, extra: object = {}) =>
  event(type, {
    region: 'cortex',
    taskId: 't1',
    agent: 'cortex.research',
    description: 'search',
    ...extra,
  })

describe('brain state', () => {
  test('a region is lit by its event and dims after the fade', () => {
    const state = reduceBrain(initialBrain, routed, 1000)
    expect(lampOf(state, 'thalamus', 1000, 1500)).toBe('lit')
    expect(lampOf(state, 'thalamus', 2499, 1500)).toBe('lit')
    expect(lampOf(state, 'thalamus', 2500, 1500)).toBe('idle')
    expect(lampOf(state, 'broca', 1000, 1500)).toBe('idle')
  })

  test('cortex counts active workers from start to end, across several tasks', () => {
    let s = reduceBrain(initialBrain, cortex('brain.cortex.start'), 0)
    s = reduceBrain(s, cortex('brain.cortex.start', { taskId: 't2' }), 1)
    s = reduceBrain(s, cortex('brain.cortex.step', { stepIndex: 0 }), 2)
    expect(viewOf(s, 10_000).find((r) => r.region === 'cortex')).toEqual({
      region: 'cortex',
      lamp: 'working',
      count: 2,
    })
    s = reduceBrain(s, cortex('brain.cortex.end', { status: 'done', summary: 'ok' }), 3)
    expect(s.cortexActive).toEqual(['t2'])
    s = reduceBrain(s, cortex('brain.cortex.end', { taskId: 't2', status: 'done', summary: '' }), 4)
    expect(lampOf(s, 'cortex', 10_000, 1500)).toBe('idle')
  })

  test('the last event is one line, and the trace keeps the newest 50', () => {
    expect(describeEvent(cortex('brain.cortex.step', { stepIndex: 3 }))).toBe(
      'cortex.research step 4',
    )
    let s = initialBrain
    for (let i = 0; i < TRACE_LIMIT + 5; i++) s = reduceBrain(s, routed, i)
    expect(s.trace).toHaveLength(TRACE_LIMIT)
    expect(s.trace[0]?.at).toBe(5)
    expect(s.last?.at).toBe(TRACE_LIMIT + 4)
  })

  test('parietal events read in one line, without client or delivery ids', () => {
    const presence = event('brain.parietal.presence', {
      region: 'parietal',
      personId: 'p1',
      state: 'busy',
      previous: 'active',
    })
    expect(describeEvent(presence)).toBe('parietal presence active → busy')
    const first = event('brain.parietal.presence', {
      region: 'parietal',
      personId: 'p1',
      state: 'idle',
      previous: null,
    })
    expect(describeEvent(first)).toBe('parietal presence idle')
    const deliver = event('brain.parietal.deliver', {
      region: 'parietal',
      clientId: 'c-secret-1',
      deliveryId: 'd-secret-2',
      capability: 'notify',
      name: 'reminder',
    })
    const line = describeEvent(deliver)
    expect(line).toBe('parietal delivers notify: reminder')
    expect(line).not.toContain('c-secret-1')
    expect(line).not.toContain('d-secret-2')
    const s = reduceBrain(initialBrain, deliver, 7)
    expect(lampOf(s, 'parietal', 8, 1500)).toBe('lit')
  })

  test('hypothalamus events read in one line, without protocol, run or step ids', () => {
    const fire = event('brain.hypothalamus.fire', {
      region: 'hypothalamus',
      protocolId: 'proto-secret-1',
      runId: 'run-secret-2',
      trigger: 'time',
    })
    const line = describeEvent(fire)
    expect(line).toBe('hypothalamus starts a time protocol')
    expect(line).not.toContain('proto-secret-1')
    expect(line).not.toContain('run-secret-2')
    expect(
      describeEvent(
        event('brain.hypothalamus.step', {
          region: 'hypothalamus',
          runId: 'run-secret-2',
          step: 'ask',
          kind: 'ask',
          outcome: 'answered:yes',
        }),
      ),
    ).toBe('hypothalamus ask step: answered:yes')
    expect(
      describeEvent(
        event('brain.hypothalamus.wait', {
          region: 'hypothalamus',
          runId: 'run-secret-2',
          wakeAt: 1_800_000_000_000,
        }),
      ),
    ).toBe('hypothalamus waits for a time')
    const end = event('brain.hypothalamus.end', {
      region: 'hypothalamus',
      runId: 'run-secret-2',
      status: 'done',
    })
    expect(describeEvent(end)).toBe('hypothalamus run done')
    const s = reduceBrain(initialBrain, end, 7)
    expect(lampOf(s, 'hypothalamus', 8, 1500)).toBe('lit')
  })

  test('corpus-callosum (rooms) events read in one line, without room, speaker or text', () => {
    const roomId = '6f1c2a4e-8b1d-4c7e-9a2f-3d5b7e9c1a20'
    expect(
      describeEvent(event('brain.corpus-callosum.join', { region: 'corpus-callosum', roomId })),
    ).toBe('rooms: someone joined a room')
    const turn = event('brain.corpus-callosum.turn', {
      region: 'corpus-callosum',
      roomId,
      speakerId: 'ana',
      stop: 'end_turn',
    })
    expect(describeEvent(turn)).toBe('rooms turn done (end_turn)')
    const refused = event('brain.corpus-callosum.turn', {
      region: 'corpus-callosum',
      roomId,
      speakerId: 'ana',
    })
    expect(describeEvent(refused)).toBe('rooms turn refused')
    const end = event('brain.corpus-callosum.end', {
      region: 'corpus-callosum',
      roomId,
      reason: 'ended',
    })
    expect(describeEvent(end)).toBe('rooms ended')
    const s = reduceBrain(initialBrain, end, 7)
    expect(lampOf(s, 'corpus-callosum', 8, 1500)).toBe('lit')
    expect(viewOf(s, 8).map((r) => r.region)).toContain('corpus-callosum')
  })

  test('the view key changes only when something visible changes', () => {
    const s = reduceBrain(initialBrain, routed, 1000)
    const lit = viewKey(viewOf(s, 1100), s.last)
    expect(viewKey(viewOf(s, 1200), s.last)).toBe(lit)
    expect(viewKey(viewOf(s, 3000), s.last)).not.toBe(lit)
  })
})

describe('a dream run on the brain panel', () => {
  const dream = (phase: 'start' | 'end' | undefined, counts = {}) =>
    event('brain.hippocampus.dream', {
      region: 'hippocampus',
      runId: 'run-1',
      ...(phase === undefined ? {} : { phase }),
      trigger: 'schedule',
      candidates: 3,
      promoted: 0,
      merged: 0,
      superseded: 0,
      dropped: 0,
      applied: false,
      ...counts,
    })

  test('the start reads dreaming…, never a count, and the hippocampus works until the end', () => {
    const start = dream('start')
    expect(describeEvent(start)).toBe('dreaming…')
    const running = reduceBrain(initialBrain, start, 1)
    expect(running.dreaming).toBe('run-1')
    expect(lampOf(running, 'hippocampus', 2, 1500)).toBe('working')
    expect(running.last?.text).not.toContain('promoted')
    const done = reduceBrain(running, dream('end', { promoted: 2, merged: 1, applied: true }), 3)
    expect(done.dreaming).toBeUndefined()
    expect(lampOf(done, 'hippocampus', 4, 1500)).toBe('lit')
    expect(done.last?.text).toBe('dream: 2 promoted, 1 merged')
  })

  test('a failed, refused or skipped end says its cause, never nothing to change', () => {
    expect(describeEvent(dream('end', { status: 'failed', reason: 'judge' }))).toBe(
      "dream failed · the model's plan was not valid",
    )
    expect(describeEvent(dream('end', { status: 'refused', reason: 'no-model' }))).toBe(
      'dream refused · no model for the cortex role',
    )
    expect(describeEvent(dream('end', { status: 'skipped', reason: 'budget-low' }))).toBe(
      'Skipped: your budget is nearly used up.',
    )
  })

  test('an end with no change reads nothing to change; the counts that are zero are left out', () => {
    expect(describeEvent(dream('end'))).toBe('dream: nothing to change')
    expect(describeEvent(dream('end', { superseded: 1, dropped: 2 }))).toBe(
      'dream: 1 superseded, 2 dropped',
    )
  })

  test('a record without a phase is an end', () => {
    expect(describeEvent(dream(undefined, { promoted: 1 }))).toBe('dream: 1 promoted')
    expect(reduceBrain(initialBrain, dream(undefined), 1).dreaming).toBeUndefined()
  })

  test('a resync forgets a run whose end was missed; a later start sets it again', () => {
    const running = reduceBrain(initialBrain, dream('start'), 1)
    expect(lampOf(running, 'hippocampus', 2, 1500)).toBe('working')
    // the end was lost while the link was down: the feed sends no history
    const resynced = resyncBrain(running)
    expect(resynced.dreaming).toBeUndefined()
    expect(lampOf(resynced, 'hippocampus', 2, 1500)).toBe('lit')
    expect(resynced.trace).toEqual(running.trace)
    expect(resyncBrain(initialBrain)).toBe(initialBrain)
    const again = reduceBrain(resynced, dream('start'), 3)
    expect(again.dreaming).toBe('run-1')
    expect(lampOf(again, 'hippocampus', 4, 1500)).toBe('working')
  })
})
