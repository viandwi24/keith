import { describe, expect, test } from 'bun:test'
import type { ProtocolStep } from '@keith/contracts'
import type { RunRecord } from '@keith/db'
import type { StepRunInput } from './ports.ts'
import { createSignOfLife } from './sign-of-life.ts'
import { DAY, type Harness, HOUR, harness, OWNER, seedRun, T0 } from './succession-harness.ts'
import { SuccessionError } from './succession-shared.ts'

// The pause for a trip (docs/specs/succession.md, "Pause", "Sign of life"): a pause is a sign of life until it ends, it
// ends an active run with the reason `paused`, a pause of more than 180 days is refused, and the count restarts from the
// end of the pause. The sign of life is the real adapter over the fake parietal sign and the service's pause port.

const signOfLifeOf = (h: Harness) =>
  createSignOfLife({
    lastSign: async () => h.sign.at,
    pausedUntil: (personId) => h.service.pausedUntil(personId),
  })

function stepOf(h: Harness, action: 'succession.begin-grace' | 'succession.open-claim') {
  const run = h.runs.get('run_test') as RunRecord
  const input: StepRunInput = {
    run,
    definition: {} as never,
    approvals: [],
    step: { id: 'sys', kind: 'system', action } as ProtocolStep,
    visit: 1,
    key: 'k',
    now: h.clock.at,
    ownerId: 'vian',
    protocolOwner: 'keith',
  }
  return h.steps(input)
}

describe('succession pause: the run', () => {
  test('a pause during the grace ends the run with the reason paused, and the state goes idle', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    seedRun(h)
    h.clock.at = T0 + 14 * DAY
    await stepOf(h, 'succession.begin-grace')
    h.sign.at = T0 + 13 * DAY

    await h.service.pause(T0 + 14 * DAY + 10 * DAY, OWNER)
    expect(h.succession.get().state).toBe('idle')
    expect(h.runs.get('run_test')?.status).toBe('cancelled')
    const kinds = h.audits.map((a) => a.kind)
    expect(kinds.slice(-2)).toEqual(['owner.succession.pause', 'owner.succession.cancel'])
    expect(h.audits.at(-1)?.detail).toEqual({
      reason: 'paused',
      sign: T0 + 13 * DAY,
      owner: 'vian',
      heir: 'ana',
    })
  })

  test('a pause during the check-in cancels it too; a pause with no run only sets the pause', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    await h.service.pause(T0 + 5 * DAY, OWNER)
    expect(h.audits.map((a) => a.kind)).toEqual(['owner.heir.set', 'owner.succession.pause'])

    seedRun(h, 'run_test')
    await h.service.pause(T0 + 6 * DAY, OWNER)
    expect(h.succession.get().state).toBe('idle')
    expect(h.runs.get('run_test')?.status).toBe('cancelled')
  })

  test('a member cannot pause, and nothing is cancelled', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    seedRun(h)
    await expect(h.service.pause(T0 + 5 * DAY, { actor: 'ana', via: 'tcp' })).rejects.toThrow(
      SuccessionError,
    )
    expect(h.succession.get().state).toBe('check-in')
    expect(h.runs.get('run_test')?.status).toBe('waiting')
  })

  test('a pause of 181 days is refused and changes nothing', async () => {
    const h = harness()
    await expect(h.service.pause(T0 + 181 * DAY, OWNER)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(h.service.settings().pausedUntil).toBeNull()
  })
})

describe('succession pause: the sign of life', () => {
  test('the owner is signed through the pause, and the pause counts only for the owner', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    h.sign.at = T0 - DAY
    const until = T0 + 10 * DAY
    await h.service.pause(until, OWNER)
    const sign = signOfLifeOf(h)
    expect(await sign.lastSign('vian')).toBe(until)
    expect(await sign.lastSign('ana')).toBe(T0 - DAY)
    expect(await h.service.pausedUntil('ana')).toBeNull()
  })

  test('a sign after the pause ends counts from it; the count restarts from the end of the pause', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    h.sign.at = T0 - DAY
    const until = T0 + 10 * DAY
    await h.service.pause(until, OWNER)
    const sign = signOfLifeOf(h)

    // 23 hours after the pause ended: still inside the first day of silence, no absence yet
    h.clock.at = until + 23 * HOUR
    expect(h.clock.at - ((await sign.lastSign('vian')) ?? 0)).toBe(23 * HOUR)
    // a full day after the end: the owner has been silent for a day from the end of the pause
    h.clock.at = until + DAY
    expect(h.clock.at - ((await sign.lastSign('vian')) ?? 0)).toBe(DAY)
  })

  test('a newer sign than the pause wins; resume gives the count back to the owner sign', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    h.sign.at = T0 - DAY
    const until = T0 + 10 * DAY
    await h.service.pause(until, OWNER)
    h.sign.at = until + 2 * HOUR
    expect(await signOfLifeOf(h).lastSign('vian')).toBe(until + 2 * HOUR)

    h.sign.at = T0 - DAY
    await h.service.resume(OWNER)
    expect(await signOfLifeOf(h).lastSign('vian')).toBe(T0 - DAY)
  })
})
