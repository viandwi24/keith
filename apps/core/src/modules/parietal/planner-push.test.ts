import { describe, expect, test } from 'bun:test'
import type { DeliveryNeeds, Presence, PresenceState } from '@keith/contracts'
import type { DeliveryRoute } from '../delivery/index.ts'
import { createPresencePlanner, pushWanted } from './planner.ts'

// The push routes in the reach ladder (ADR-0034 §6, docs/specs/parietal.md "Routing", docs/specs/push.md).

const front: DeliveryRoute = { id: 'front', send: async () => ({ ok: true }) }
const push: DeliveryRoute = { id: 'push', companion: true, send: async () => ({ ok: true }) }

function planner(state: PresenceState, where: Presence['where'], subscribed = true) {
  const asked: string[] = []
  const p = createPresencePlanner({
    front,
    parietal: {
      list: () => [],
      presence: () => ({ state, where, activeClient: null }) as Presence,
      callClient: async () => ({ ok: true }),
    },
    push: (person) => {
      asked.push(person)
      return subscribed ? [push] : []
    },
  })
  return { p, asked }
}

const needs = (urgency: 'normal' | 'high', extra: Partial<DeliveryNeeds> = {}): DeliveryNeeds => ({
  mode: 'wake',
  capabilities: [],
  fanout: 'best',
  urgency,
  ...extra,
})

const idsOf = async (
  state: PresenceState,
  where: Presence['where'],
  n: DeliveryNeeds,
  subscribed = true,
) => {
  const plan = await planner(state, where, subscribed).p.plan('ana', n)
  return Array.isArray(plan) ? plan.map((r) => r.id).join(',') : 'hold'
}

describe('pushWanted', () => {
  test('urgent always; notes never; away, offline, mobile and out otherwise', () => {
    expect(pushWanted({ state: 'active', where: 'desk' }, needs('high'))).toBe(true)
    expect(pushWanted({ state: 'away', where: 'unknown' }, needs('high', { mode: 'note' }))).toBe(
      true,
    )
    expect(pushWanted({ state: 'away', where: 'unknown' }, needs('normal', { mode: 'note' }))).toBe(
      false,
    )
    expect(pushWanted({ state: 'away', where: 'unknown' }, needs('normal'))).toBe(true)
    expect(pushWanted({ state: 'offline', where: 'unknown' }, needs('normal'))).toBe(true)
    expect(pushWanted({ state: 'idle', where: 'mobile' }, needs('normal'))).toBe(true)
    expect(pushWanted({ state: 'idle', where: 'out' }, needs('normal'))).toBe(true)
    expect(pushWanted({ state: 'active', where: 'desk' }, needs('normal'))).toBe(false)
    expect(pushWanted({ state: 'idle', where: 'unknown' }, needs('normal'))).toBe(false)
  })
})

describe('planner rows with push', () => {
  const rows: [PresenceState, Presence['where'], DeliveryNeeds, string][] = [
    ['active', 'desk', needs('normal'), 'front'],
    ['idle', 'unknown', needs('normal'), 'front'],
    ['active', 'desk', needs('high'), 'push,front'],
    ['idle', 'mobile', needs('normal'), 'push,front'],
    ['idle', 'out', needs('normal'), 'push,front'],
    ['busy', 'desk', needs('normal'), 'hold'],
    ['busy', 'desk', needs('high'), 'push,front'],
    ['busy', 'mobile', needs('normal', { mode: 'note' }), 'front'],
    ['busy', 'desk', needs('normal', { mode: 'note' }), 'front'],
    ['away', 'unknown', needs('normal'), 'hold'],
    ['away', 'unknown', needs('normal', { immediate: true }), 'push,front'],
    ['away', 'unknown', needs('normal', { mode: 'note' }), 'front'],
    ['away', 'unknown', needs('high'), 'push,front'],
    ['offline', 'unknown', needs('high'), 'push,front'],
    ['away', 'unknown', needs('high', { capabilities: ['open.view'] }), 'push,front'],
    ['away', 'unknown', needs('high', { capabilities: ['notify'] }), 'push,front'],
  ]
  for (const [state, where, n, expected] of rows)
    test(`${state}/${where}/${n.urgency}/${n.mode}${n.immediate ? '/immediate' : ''}/${n.capabilities.join('+') || 'none'} -> ${expected}`, async () => {
      expect(await idsOf(state, where, n)).toBe(expected)
    })

  test('a person with no subscription gets the plain ladder, and a desk person is never asked', async () => {
    expect(await idsOf('away', 'unknown', needs('high'), false)).toBe('front')
    const desk = planner('active', 'desk')
    await desk.p.plan('ana', needs('normal'))
    expect(desk.asked).toEqual([])
  })

  test('the front session is always last and the push route is a companion', async () => {
    const plan = await planner('idle', 'mobile').p.plan('ana', needs('normal'))
    if (!Array.isArray(plan)) throw new Error('hold')
    expect(plan.at(-1)?.id).toBe('front')
    expect(plan.find((r) => r.id === 'push')?.companion).toBe(true)
  })
})
