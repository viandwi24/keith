import { describe, expect, test } from 'bun:test'
import type { ProtocolStep } from '@keith/contracts'
import type { RunRecord } from '@keith/db'
import type { StepRunInput } from './ports.ts'
import { runIdFor } from './steps.ts'
import { DAY, type Harness, harness, seedRun, T0 } from './succession-harness.ts'
import { OWNER_ABSENCE } from './succession-shared.ts'

// The system steps of the owner-absence protocol (docs/specs/succession.md, "States", "The protocol" steps 4, 7, 9): the
// state row moves by compare-and-set, every move is audited, and a replayed step answers ok again without a second row.

type Action = 'succession.begin-grace' | 'succession.open-claim' | 'succession.cancel'

function stepInput(h: Harness, action: Action, run: RunRecord): StepRunInput {
  return {
    run,
    definition: {} as never,
    approvals: [],
    step: { id: 'sys', kind: 'system', action } as ProtocolStep,
    visit: 1,
    key: `${run.id}:sys:1`,
    now: h.clock.at,
    ownerId: 'vian',
    protocolOwner: 'keith',
  }
}

const runOf = (h: Harness, id = 'run_test'): RunRecord => {
  const run = h.runs.get(id)
  if (run === undefined) throw new Error('no run')
  return run
}

const kinds = (h: Harness): string[] => h.audits.map((a) => a.kind)

describe('succession steps: begin-grace and open-claim', () => {
  test('check-in to grace to claimable, each once, each audited', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h)
    expect(h.succession.get().state).toBe('check-in')

    h.clock.at = T0 + 14 * DAY
    expect(await h.steps(stepInput(h, 'succession.begin-grace', runOf(h)))).toEqual({
      kind: 'done',
      outcome: 'ok',
    })
    expect(h.succession.get()).toMatchObject({ state: 'grace', graceStartedAt: T0 + 14 * DAY })
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.succession.start',
      actor: 'system',
      via: 'local',
      detail: {
        heir: 'ana',
        startedAt: T0,
        graceStartedAt: T0 + 14 * DAY,
        owner: 'vian',
      },
    })

    // a replay of the same step answers ok and writes nothing new
    const before = h.audits.length
    expect((await h.steps(stepInput(h, 'succession.begin-grace', runOf(h)))).outcome).toBe('ok')
    expect(h.audits).toHaveLength(before)

    // the grace is not over: the claim is refused and nothing moves
    h.clock.at = T0 + 14 * DAY + 7 * DAY - 1
    expect((await h.steps(stepInput(h, 'succession.open-claim', runOf(h)))).outcome).toBe(
      'failed:grace-not-over',
    )
    expect(h.succession.get().state).toBe('grace')

    h.clock.at = T0 + 14 * DAY + 7 * DAY
    expect((await h.steps(stepInput(h, 'succession.open-claim', runOf(h)))).outcome).toBe('ok')
    expect(h.succession.get()).toMatchObject({ state: 'claimable', claimableAt: h.clock.at })
    expect(h.audits.at(-1)).toMatchObject({
      kind: 'owner.succession.claimable',
      detail: { heir: 'ana', claimableAt: h.clock.at, owner: 'vian' },
    })
    expect((await h.steps(stepInput(h, 'succession.open-claim', runOf(h)))).outcome).toBe('ok')
    expect(kinds(h).filter((k) => k === 'owner.succession.claimable')).toHaveLength(1)
  })

  test('open-claim in idle fails and audits the refusal, and the state stays idle', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h)
    h.succession.move('check-in', 'idle', h.clock.at)
    expect((await h.steps(stepInput(h, 'succession.open-claim', runOf(h)))).outcome).toBe(
      'failed:not-in-grace',
    )
    expect(h.succession.get().state).toBe('idle')
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.succession.refused',
      actor: 'system',
      via: 'local',
      detail: { action: 'succession.open-claim', state: 'idle', reason: 'not-in-grace' },
    })
  })

  test('begin-grace from idle is refused; a step of another run is refused too', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h)
    h.succession.move('check-in', 'idle', h.clock.at)
    expect((await h.steps(stepInput(h, 'succession.begin-grace', runOf(h)))).outcome).toBe(
      'failed:not-check-in',
    )
    expect(h.succession.get().state).toBe('idle')

    const h2 = harness()
    await h2.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h2, 'run_other')
    const stranger = { ...runOf(h2, 'run_other'), id: 'run_stranger' }
    expect((await h2.steps(stepInput(h2, 'succession.begin-grace', stranger))).outcome).toBe(
      'failed:not-check-in',
    )
    expect(h2.succession.get().state).toBe('check-in')
  })
})

describe('succession steps: cancel', () => {
  test('a cancel from grace returns the state to idle and audits the owner sign', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h)
    h.clock.at = T0 + 15 * DAY
    await h.steps(stepInput(h, 'succession.begin-grace', runOf(h)))
    h.sign.at = T0 + 15 * DAY - 1000

    expect((await h.steps(stepInput(h, 'succession.cancel', runOf(h)))).outcome).toBe('ok')
    expect(h.succession.get().state).toBe('idle')
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.succession.cancel',
      actor: 'system',
      via: 'local',
      detail: {
        reason: 'owner-sign',
        sign: T0 + 15 * DAY - 1000,
        owner: 'vian',
        heir: 'ana',
      },
    })

    // a replay after the state went idle writes nothing new
    const count = h.audits.length
    expect((await h.steps(stepInput(h, 'succession.cancel', runOf(h)))).outcome).toBe('ok')
    expect(h.audits).toHaveLength(count)
  })

  test('a cancel while a pause is in force names the pause as the reason', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    seedRun(h)
    await h.service.pause(T0 + 10 * DAY, { actor: 'vian', via: 'tcp' })
    expect((await h.steps(stepInput(h, 'succession.cancel', runOf(h)))).outcome).toBe('ok')
    expect(h.audits.at(-1)?.detail).toMatchObject({ reason: 'paused' })
  })

  test('a cancel for a run that holds no active state writes nothing', async () => {
    const h = harness()
    seedRun(h)
    h.succession.move('check-in', 'idle', h.clock.at)
    expect((await h.steps(stepInput(h, 'succession.cancel', runOf(h)))).outcome).toBe('ok')
    expect(kinds(h).filter((k) => k === 'owner.succession.cancel')).toHaveLength(0)
  })
})

describe('succession steps: the run starts the check-in', () => {
  const protocolOf = (h: Harness, builtIn: string | null, id = 'proto_absence') =>
    h.protocols.create(
      { id, owner: 'keith', name: 'Owner absence', builtIn, definition: '{}', savedBy: 'vian' },
      h.clock.at,
    )

  test('a started owner-absence run enters check-in with the heir in force; a second start is refused', async () => {
    const h = harness()
    await h.service.setHeir('ana', { actor: 'vian', via: 'tcp' })
    protocolOf(h, OWNER_ABSENCE)
    await h.service.runStarted('proto_absence', 'absence:1')
    expect(h.succession.get()).toMatchObject({
      state: 'check-in',
      runId: runIdFor('proto_absence', 'absence:1'),
      heir: 'ana',
    })
    await h.service.runStarted('proto_absence', 'absence:2')
    expect(h.succession.get().runId).toBe(runIdFor('proto_absence', 'absence:1'))
  })

  test('another protocol, or no heir, starts nothing', async () => {
    const h = harness()
    protocolOf(h, null, 'proto_other')
    await h.service.runStarted('proto_other', 'x')
    expect(h.succession.get().state).toBe('idle')

    protocolOf(h, OWNER_ABSENCE)
    await h.service.runStarted('proto_absence', 'absence:1')
    expect(h.succession.get().state).toBe('idle')
  })

  test('a system step of a non-system kind fails', async () => {
    const h = harness()
    seedRun(h)
    const notSystem = {
      ...stepInput(h, 'succession.cancel', runOf(h)),
      step: { id: 'n', kind: 'wait', durationMs: 60_000 } as ProtocolStep,
    }
    expect((await h.steps(notSystem)).outcome).toBe('failed:not-system')
  })
})
