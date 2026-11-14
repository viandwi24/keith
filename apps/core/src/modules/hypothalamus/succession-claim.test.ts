// The heir's claim and the lazy reconcile of a claimable state (docs/specs/succession.md, "The claim"; P29.3.2). The fakes of
// `succession-harness.ts` stand for the people directory and the sign of life; the swap is the fake `succeed`, which rolls
// the roles back when `inside` throws, the same way the real store does. Every refusal is checked for "changes nothing".
import { describe, expect, test } from 'bun:test'
import { DAY, type Harness, HOUR, harness, OWNER, seedRun, T0 } from './succession-harness.ts'
import {
  CLAIM_EXPIRY_MS,
  GRACE_MS,
  SUCCESSION_KEYS,
  type SuccessionCaller,
} from './succession-shared.ts'

const HEIR: SuccessionCaller = { actor: 'ana', via: 'tcp' }

/** The heir named, a run started, moved to `claimable` by the same moves the steps make (grace, then the claim opens). */
function toClaimable(h: Harness): void {
  h.settings.set(SUCCESSION_KEYS.heir, 'ana')
  seedRun(h, 'run_claim', 'ana')
  h.clock.at = T0 + 14 * DAY
  h.succession.move('check-in', 'grace', h.clock.at, { graceStartedAt: h.clock.at })
  h.clock.at += GRACE_MS
  h.succession.move('grace', 'claimable', h.clock.at, { claimableAt: h.clock.at })
}

async function refused(
  p: Promise<unknown>,
): Promise<{ code: string | undefined; reason: string | null | undefined }> {
  try {
    await p
  } catch (error) {
    const e = error as { code?: string; reason?: string | null }
    return { code: e.code, reason: e instanceof Error && 'reason' in e ? e.reason : null }
  }
  throw new Error('expected a refusal')
}

/** The owner is still the one who was owner, and the heir is still a member: nothing moved. */
async function unmoved(h: Harness): Promise<void> {
  expect((await h.deps.people.owner())?.id).toBe('vian')
  expect((await h.deps.people.get('ana')).role).toBe('member')
}

const owner = (h: Harness) => h.audits.filter((a) => a.kind === 'owner.succession')

describe('succession claim: a refusal changes nothing', () => {
  test('over the local socket the claim is FORBIDDEN, even for the heir', async () => {
    const h = harness()
    toClaimable(h)
    const r = await refused(h.service.claim({ actor: 'ana', via: 'local' }))
    expect(r.code).toBe('FORBIDDEN')
    expect(h.succession.get().state).toBe('claimable')
    await unmoved(h)
  })

  test('a person who is not the heir is FORBIDDEN, and the owner cannot claim', async () => {
    const h = harness()
    toClaimable(h)
    expect((await refused(h.service.claim({ actor: 'kim', via: 'tcp' }))).code).toBe('FORBIDDEN')
    expect((await refused(h.service.claim(OWNER))).code).toBe('FORBIDDEN')
    await unmoved(h)
  })

  test('no run yet: the state holds no heir, so the heir check refuses (FORBIDDEN)', async () => {
    const h = harness()
    h.settings.set(SUCCESSION_KEYS.heir, 'ana')
    expect((await refused(h.service.claim(HEIR))).code).toBe('FORBIDDEN')
    await unmoved(h)
  })

  test('check-in: the grace has not begun, grace-not-over', async () => {
    const h = harness()
    h.settings.set(SUCCESSION_KEYS.heir, 'ana')
    seedRun(h, 'run_checkin', 'ana')
    expect(await refused(h.service.claim(HEIR))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'grace-not-over',
    })
    expect(h.succession.get().state).toBe('check-in')
    await unmoved(h)
  })

  test('grace, one second before the end: grace-not-over and the state stays grace', async () => {
    const h = harness()
    h.settings.set(SUCCESSION_KEYS.heir, 'ana')
    seedRun(h, 'run_grace', 'ana')
    h.clock.at = T0 + 14 * DAY
    h.succession.move('check-in', 'grace', h.clock.at, { graceStartedAt: h.clock.at })
    h.clock.at += GRACE_MS - 1000
    expect(await refused(h.service.claim(HEIR))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'grace-not-over',
    })
    expect(h.succession.get().state).toBe('grace')
    await unmoved(h)
  })

  test('a run the owner cancelled (a pause): cancelled', async () => {
    const h = harness()
    toClaimable(h)
    // back to a run that was cancelled: the pause ends the run and the state goes idle
    h.succession.move('claimable', 'idle', h.clock.at)
    expect(await refused(h.service.claim(HEIR))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'cancelled',
    })
    await unmoved(h)
  })

  test('the heir can no longer sign in: heir-invalid', async () => {
    const h = harness()
    toClaimable(h)
    h.update('ana', { canLogin: false })
    expect(await refused(h.service.claim(HEIR))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      reason: 'heir-invalid',
    })
    await unmoved(h)
    expect(h.succession.get().state).toBe('claimable')
  })

  test('an owner sign after the claim opened ends the run first; the claim is refused and nothing moves', async () => {
    const h = harness()
    toClaimable(h)
    h.sign.at = (h.succession.get().claimableAt as number) + HOUR
    expect((await refused(h.service.claim(HEIR))).code).toBe('PRECONDITION_FAILED')
    expect(h.succession.get().state).toBe('idle')
    const cancel = h.audits.filter((a) => a.kind === 'owner.succession.cancel')
    expect(cancel).toHaveLength(1)
    expect(cancel[0]?.detail).toMatchObject({ reason: 'owner-sign' })
    await unmoved(h)
    expect(owner(h)).toHaveLength(0)
  })

  test('a sign that lands between the reconcile and the swap is refused inside the transaction (owner-returned)', async () => {
    const h = harness()
    toClaimable(h)
    // the owner's sign arrives after the reconcile read and before the swap: the swap rolls back
    h.hooks.beforeSwap = () => {
      h.sign.at = h.clock.at + 1
    }
    const r = await refused(h.service.claim(HEIR))
    expect(r).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'owner-returned' })
    expect(h.succession.get().state).toBe('idle')
    await unmoved(h)
    expect(owner(h)).toHaveLength(0)
    expect(h.audits.filter((a) => a.kind === 'owner.succession.cancel')).toHaveLength(1)
  })
})

describe('succession claim: the success', () => {
  test('one owner (the heir), the previous owner suspended, one owner.succession row, heir cleared, state claimed', async () => {
    const h = harness()
    toClaimable(h)
    const before = h.onChanged.calls
    const moved = await h.service.claim(HEIR)
    expect(moved.owner).toMatchObject({ id: 'ana', role: 'owner', status: 'active' })
    expect(moved.previousOwner).toMatchObject({ id: 'vian', role: 'member', status: 'suspended' })
    expect((await h.deps.people.owner())?.id).toBe('ana')
    expect(h.succession.get().state).toBe('claimed')
    expect(h.settings.get(SUCCESSION_KEYS.heir)).toBeUndefined()
    expect(h.onChanged.calls).toBeGreaterThan(before)
    expect(owner(h)).toHaveLength(1)
    expect(owner(h)[0]).toMatchObject({
      actor: 'ana',
      via: 'tcp',
      detail: { owner: 'vian', previousOwner: 'vian', heir: 'ana' },
    })
  })

  test('a second claim after success is CONFLICT', async () => {
    const h = harness()
    toClaimable(h)
    await h.service.claim(HEIR)
    expect((await refused(h.service.claim(HEIR))).code).toBe('CONFLICT')
    expect(owner(h)).toHaveLength(1)
  })
})

describe('succession reconcile of a claimable state', () => {
  test('a sign of the owner after the claim opened: the status reconcile ends the run (idle) with the cancel row', async () => {
    const h = harness()
    toClaimable(h)
    h.sign.at = h.clock.at + HOUR
    const status = await h.service.status()
    expect(status.run.state).toBe('idle')
    expect(h.audits.filter((a) => a.kind === 'owner.succession.cancel')[0]?.detail).toMatchObject({
      reason: 'owner-sign',
    })
  })

  test('a claimable state expires after 52 weeks with no claim: idle, cancel reason expired', async () => {
    const h = harness()
    toClaimable(h)
    h.clock.at += CLAIM_EXPIRY_MS - 1
    await h.service.reconcileClaimable()
    expect(h.succession.get().state).toBe('claimable')
    h.clock.at += 1
    await h.service.reconcileClaimable()
    expect(h.succession.get().state).toBe('idle')
    expect(h.audits.filter((a) => a.kind === 'owner.succession.cancel')[0]?.detail).toMatchObject({
      reason: 'expired',
    })
  })

  test('outside claimable the reconcile reads and writes nothing', async () => {
    const h = harness()
    h.settings.set(SUCCESSION_KEYS.heir, 'ana')
    seedRun(h, 'run_checkin', 'ana')
    h.sign.at = h.clock.at + DAY
    await h.service.reconcileClaimable()
    expect(h.succession.get().state).toBe('check-in')
    expect(h.audits.filter((a) => a.kind.startsWith('owner.succession'))).toHaveLength(0)
  })
})
