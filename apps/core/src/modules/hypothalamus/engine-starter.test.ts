import { describe, expect, test } from 'bun:test'
import { createRunStarter } from './engine.ts'
import { HOUR, harness, MINUTE, NOW, notify, protocol } from './engine-harness.ts'

// The triggers' start port over the engine (docs/specs/hypothalamus.md, "Triggers"): the trigger's detail says what fired
// (`kind`) and, for an event with a delay, when the run's first step may start (`wakeAt`). The unique (protocol, ref) guard
// makes a repeated start `duplicate`.

describe('createRunStarter', () => {
  test('a time fire starts a run now, and the same ref is a duplicate', async () => {
    const h = harness()
    h.define('p1', 'ladder', protocol([notify('tell')]), true, 'ana')
    const starter = createRunStarter(h.engine)
    const input = {
      protocolId: 'p1',
      version: 1,
      ref: 'p1:1',
      at: NOW,
      detail: { kind: 'time' as const, scheduledAt: NOW, fireId: 'f1' },
    }
    expect(await starter.start(input)).toBe('started')
    expect(await starter.start(input)).toBe('duplicate')
    expect(h.calls.length).toBe(1)
  })

  test('an event with a delay creates the run waiting until wakeAt and calls no step yet', async () => {
    const h = harness()
    h.define('p1', 'later', protocol([notify('tell')]), true, 'ana')
    const starter = createRunStarter(h.engine)
    const outcome = await starter.start({
      protocolId: 'p1',
      version: 1,
      ref: 'delivery:d1',
      at: NOW,
      detail: { kind: 'event', seq: 7, type: 'delivery.failed', wakeAt: NOW + 15 * MINUTE },
    })
    expect(outcome).toBe('started')
    const run = h.runs.findByTrigger('p1', 'delivery:d1')
    expect(run?.status).toBe('waiting')
    expect(run?.wakeAt).toBe(NOW + 15 * MINUTE)
    expect(h.calls.length).toBe(0)
    h.advance(HOUR)
    await h.engine.tick()
    expect(h.calls.length).toBe(1)
  })

  test('a start of a missing or disabled protocol is refused, and a start without detail too', async () => {
    const h = harness()
    h.define('p1', 'off', protocol([notify('tell')]), false, 'ana')
    const starter = createRunStarter(h.engine)
    const base = { version: 1, at: NOW }
    expect(
      await starter.start({
        ...base,
        protocolId: 'p1',
        ref: 'x',
        detail: { kind: 'absence', personId: 'ana', since: NOW },
      }),
    ).toBe('refused')
    expect(await starter.start({ ...base, protocolId: 'nope', ref: 'x' })).toBe('refused')
  })
})
