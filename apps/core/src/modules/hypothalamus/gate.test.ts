import { describe, expect, test } from 'bun:test'
import type { Condition } from '@keith/contracts'
import { HOUR, harness, MINUTE, NOW, notify, protocol, started } from './engine-harness.ts'

// The trigger gate of an `event` protocol (docs/specs/hypothalamus.md, "Triggers"): the trigger's guard is read at the
// run's wake time. A false guard skips the run; `approval.pending` may answer "pending, but due later" and the run waits
// again until `expiresAt - beforeMs`. Fixtures: `engine-harness.ts` (the harness approval is pending until at + 1 h).

const eventTrigger = (guard: Condition, until?: { field: string; beforeMs: number }) => ({
  kind: 'event',
  type: 'brain.amygdala.wait',
  ...(until === undefined ? {} : { until }),
  guard,
})

describe('the trigger gate at wake time', () => {
  test('a false guard at the wake time ends the run skipped, with no step', async () => {
    const h = harness()
    const guard: Condition = { kind: 'presence', person: 'ana', in: ['busy'] }
    h.define(
      'p1',
      'gated',
      { ...protocol([notify('tell')]), trigger: eventTrigger(guard) },
      true,
      'ana',
    )
    const outcome = await h.engine.start({
      protocolId: 'p1',
      trigger: 'event',
      triggerRef: 'e1',
      startAt: NOW + 10 * MINUTE,
    })
    const run = started(outcome)
    expect(h.runs.get(run)?.status).toBe('waiting')
    h.set(NOW + 10 * MINUTE)
    await h.engine.tick()
    expect(h.runs.get(run)?.status).toBe('skipped')
    expect(h.calls.length).toBe(0)
    expect(h.journal.audits.some((row) => row.kind === 'protocol.run.end')).toBe(true)
  })

  test('a true guard lets the run continue to its first step', async () => {
    const h = harness()
    const guard: Condition = { kind: 'approval.pending', approvalId: 'ap1' }
    h.define(
      'p1',
      'gated',
      {
        ...protocol([notify('tell')]),
        trigger: eventTrigger(guard, { field: 'expiresAt', beforeMs: HOUR }),
      },
      true,
      'ana',
    )
    h.approvalPending.value = true
    const run = started(
      await h.engine.start({
        protocolId: 'p1',
        trigger: 'event',
        triggerRef: 'e1',
        startAt: NOW + 10 * MINUTE,
      }),
    )
    // expiresAt is at + 1 h at the wake time: expiresAt - 1 h is the wake time itself, so the ping goes now
    h.set(NOW + 10 * MINUTE)
    await h.engine.tick()
    expect(h.calls.map((c) => c.step)).toEqual(['tell'])
    expect(h.runs.get(run)?.status).toBe('done')
  })

  test('a pending approval whose expiry is still later waits again until expiresAt - beforeMs', async () => {
    const h = harness()
    const guard: Condition = { kind: 'approval.pending', approvalId: 'ap1' }
    h.define(
      'p1',
      'gated',
      {
        ...protocol([notify('tell')]),
        trigger: eventTrigger(guard, { field: 'expiresAt', beforeMs: 30 * MINUTE }),
      },
      true,
      'ana',
    )
    h.approvalPending.value = true
    const run = started(
      await h.engine.start({
        protocolId: 'p1',
        trigger: 'event',
        triggerRef: 'e1',
        startAt: NOW + 10 * MINUTE,
      }),
    )
    h.set(NOW + 10 * MINUTE)
    await h.engine.tick()
    // the harness expiry moved to now + 1 h, so the ping is due at now + 30 min, not at the first wake time
    expect(h.runs.get(run)?.status).toBe('waiting')
    expect(h.runs.get(run)?.wakeAt).toBe(NOW + 40 * MINUTE)
    expect(h.calls.length).toBe(0)
  })

  test('an approval no longer pending at the wake time skips the run', async () => {
    const h = harness()
    const guard: Condition = { kind: 'approval.pending', approvalId: 'ap1' }
    h.define(
      'p1',
      'gated',
      {
        ...protocol([notify('tell')]),
        trigger: eventTrigger(guard, { field: 'expiresAt', beforeMs: HOUR }),
      },
      true,
      'ana',
    )
    const run = started(
      await h.engine.start({
        protocolId: 'p1',
        trigger: 'event',
        triggerRef: 'e1',
        startAt: NOW + 10 * MINUTE,
      }),
    )
    h.set(NOW + 10 * MINUTE)
    await h.engine.tick()
    expect(h.runs.get(run)?.status).toBe('skipped')
  })
})
