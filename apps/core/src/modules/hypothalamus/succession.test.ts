import { describe, expect, test } from 'bun:test'
import { DAY, harness, OWNER, seedRun, T0 } from './succession-harness.ts'
import { SuccessionError } from './succession-shared.ts'

// The succession settings (docs/specs/succession.md, "Settings", "Audit", "Errors"): owner only, audited, and an heir
// who cannot sign in is refused. Real settings, succession and run repos; fake people and audit.

const refusal = async (
  call: () => Promise<unknown>,
): Promise<{ code: string; reason: string | null }> => {
  try {
    await call()
  } catch (error) {
    if (error instanceof SuccessionError) return { code: error.code, reason: error.reason }
    throw error
  }
  throw new Error('expected a refusal')
}

describe('succession settings: the heir', () => {
  test('the owner names an active member who can sign in and has a secret; the change is audited once', () => {
    const h = harness()
    return h.service.setHeir('ana', OWNER).then((settings) => {
      expect(settings).toEqual({ heir: 'ana', windowDays: 14, pausedUntil: null })
      expect(h.audits).toEqual([
        {
          kind: 'owner.heir.set',
          actor: 'vian',
          via: 'tcp',
          detail: { previousHeir: null, heir: 'ana', owner: 'vian' },
        },
      ])
      expect(h.onChanged.calls).toBe(1)
    })
  })

  test('a member and a delegate cannot name an heir, and nothing changes', async () => {
    const h = harness()
    const member = await refusal(() => h.service.setHeir('kim', { actor: 'ana', via: 'tcp' }))
    expect(member.code).toBe('FORBIDDEN')
    // a delegate holding people.manage is a member too: the service checks the owner role, not the grant
    expect((await refusal(() => h.service.clearHeir({ actor: 'bo', via: 'tcp' }))).code).toBe(
      'FORBIDDEN',
    )
    expect(h.settings.get('succession.heir')).toBeUndefined()
    expect(h.audits).toEqual([])
  })

  test('an heir who cannot be heir is refused with its reason and nothing is written', async () => {
    const h = harness()
    const cases: Array<[string, string, string]> = [
      ['vian', 'BAD_REQUEST', 'owner'],
      ['bo', 'BAD_REQUEST', 'no-secret'],
      ['cy', 'BAD_REQUEST', 'suspended'],
      ['dan', 'BAD_REQUEST', 'cannot-sign-in'],
    ]
    for (const [ref, code, reason] of cases) {
      const got = await refusal(() => h.service.setHeir(ref, OWNER))
      expect(got).toEqual({ code, reason })
    }
    expect((await refusal(() => h.service.setHeir('nobody', OWNER))).code).toBe('NOT_FOUND')
    expect(h.settings.get('succession.heir')).toBeUndefined()
    expect(h.audits).toEqual([])
  })

  test('naming the same heir again writes nothing; a new heir is audited with the previous one', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    await h.service.setHeir('ana', OWNER)
    expect(h.audits).toHaveLength(1)
    await h.service.setHeir('kim', OWNER)
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.heir.set',
      actor: 'vian',
      via: 'tcp',
      detail: { previousHeir: 'ana', heir: 'kim', owner: 'vian' },
    })
  })

  test('the owner clears the heir; clearing when there is none writes nothing', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    expect((await h.service.clearHeir(OWNER)).heir).toBeNull()
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.heir.clear',
      actor: 'vian',
      via: 'tcp',
      detail: { heir: 'ana', reason: 'owner', owner: 'vian' },
    })
    const count = h.audits.length
    await h.service.clearHeir(OWNER)
    expect(h.audits).toHaveLength(count)
  })

  test('a suspended or removed heir is cleared by the identity change, and that is audited', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    await h.service.heirGone('bo', 'suspend')
    expect(h.service.settings().heir).toBe('ana')
    await h.service.heirGone('ana', 'suspend')
    expect(h.service.settings().heir).toBeNull()
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.heir.clear',
      actor: 'system',
      via: 'local',
      detail: { heir: 'ana', reason: 'suspended', owner: 'vian' },
    })
    await h.service.setHeir('kim', OWNER)
    await h.service.heirGone('kim', 'remove')
    expect(h.audits.at(-1)?.detail).toEqual({ heir: 'kim', reason: 'removed', owner: 'vian' })
  })

  test('changing the heir while a run is active ends the run and audits the cancel', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    seedRun(h)
    h.sign.at = T0 - DAY
    await h.service.setHeir('kim', OWNER)
    expect(h.succession.get().state).toBe('idle')
    expect(h.runs.get('run_test')?.status).toBe('cancelled')
    expect(h.audits.map((a) => a.kind)).toContain('owner.succession.cancel')
    expect(h.audits.find((a) => a.kind === 'owner.succession.cancel')?.detail).toEqual({
      reason: 'heir-changed',
      sign: T0 - DAY,
      owner: 'vian',
      heir: 'ana',
    })
  })

  test('a removed heir during an active run ends the run with the heir-removed reason', async () => {
    const h = harness()
    await h.service.setHeir('ana', OWNER)
    seedRun(h)
    await h.service.heirGone('ana', 'remove')
    expect(h.succession.get().state).toBe('idle')
    expect(h.runs.get('run_test')?.status).toBe('cancelled')
    expect(h.audits.at(-1)?.detail).toMatchObject({ reason: 'heir-removed' })
  })

  test('a stored value that is not a valid heir reads as none', () => {
    const h = harness()
    h.settings.set('succession.heir', 42)
    expect(h.service.settings().heir).toBeNull()
  })
})

describe('succession settings: the window', () => {
  test('the default is 14 days; 7 and 90 are accepted; 6 and 91 are refused', async () => {
    const h = harness()
    expect(h.service.settings().windowDays).toBe(14)
    expect((await h.service.setWindow(7, OWNER)).windowDays).toBe(7)
    expect((await h.service.setWindow(90, OWNER)).windowDays).toBe(90)
    for (const days of [6, 91, 14.5]) {
      expect((await refusal(() => h.service.setWindow(days, OWNER))).code).toBe('BAD_REQUEST')
    }
    expect(h.audits.map((a) => a.detail)).toEqual([
      { from: 14, to: 7, owner: 'vian' },
      { from: 7, to: 90, owner: 'vian' },
    ])
  })

  test('a member cannot set the window, and a corrupt stored window reads as the default', async () => {
    const h = harness()
    expect((await refusal(() => h.service.setWindow(30, { actor: 'ana', via: 'tcp' }))).code).toBe(
      'FORBIDDEN',
    )
    h.settings.set('succession.windowDays', 3)
    expect(h.service.settings().windowDays).toBe(14)
  })
})

describe('succession settings: pause and resume', () => {
  test('a pause is audited and may last at most 180 days; 181 days and a past end are refused', async () => {
    const h = harness()
    const until = T0 + 10 * DAY
    expect((await h.service.pause(until, OWNER)).pausedUntil).toBe(until)
    expect(h.audits.at(-1)).toEqual({
      kind: 'owner.succession.pause',
      actor: 'vian',
      via: 'tcp',
      detail: { until, owner: 'vian' },
    })
    expect((await h.service.pause(T0 + 180 * DAY, OWNER)).pausedUntil).toBe(T0 + 180 * DAY)
    expect((await refusal(() => h.service.pause(T0 + 181 * DAY, OWNER))).reason).toBe(
      'pause-too-long',
    )
    expect((await refusal(() => h.service.pause(T0 - 1, OWNER))).reason).toBe('pause-past')
  })

  test('resume ends an early pause and is audited; resume with no pause writes nothing', async () => {
    const h = harness()
    await h.service.pause(T0 + 10 * DAY, OWNER)
    expect((await h.service.resume(OWNER)).pausedUntil).toBeNull()
    expect(h.audits.at(-1)?.kind).toBe('owner.succession.resume')
    const count = h.audits.length
    await h.service.resume(OWNER)
    expect(h.audits).toHaveLength(count)
  })

  test('a member cannot pause', async () => {
    const h = harness()
    expect(
      (await refusal(() => h.service.pause(T0 + DAY, { actor: 'ana', via: 'tcp' }))).code,
    ).toBe('FORBIDDEN')
  })
})
