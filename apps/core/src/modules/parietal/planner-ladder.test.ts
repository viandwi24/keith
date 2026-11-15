import { describe, expect, test } from 'bun:test'
import type {
  ClientRecord,
  DeliveryHoldReason,
  DeliveryNeeds,
  DeliveryRequest,
  Presence,
  PresenceState,
} from '@keith/contracts'
import type { DeliveryRoute } from '../delivery/index.ts'
import { createPresencePlanner } from './planner.ts'

// The reach ladder (ADR-0034 §6, docs/specs/parietal.md "Routing"): state x where x urgency -> routes or hold.

const LAPTOP = '00000000-0000-4000-8000-00000000000a'
const laptop: ClientRecord = {
  id: LAPTOP,
  personId: 'ana',
  kind: 'tui',
  label: 'laptop',
  capabilities: ['chat', 'notify'],
  version: '0.1.0',
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastActiveAt: 1,
  online: true,
}

const sent: DeliveryRequest[] = []
const front: DeliveryRoute = {
  id: 'front',
  async send(r) {
    sent.push(r)
    return { ok: true }
  },
}

function planner(state: PresenceState, where: Presence['where'], until?: number) {
  return createPresencePlanner({
    front,
    parietal: {
      list: () => [laptop],
      presence: () =>
        ({
          state,
          where,
          activeClient: LAPTOP,
          ...(until === undefined ? {} : { until }),
        }) as Presence,
      callClient: async () => ({ ok: true }),
    },
  })
}

const needs = (urgency: 'normal' | 'high', capabilities: string[] = []): DeliveryNeeds => ({
  mode: 'wake',
  capabilities,
  fanout: 'best',
  urgency,
})

type Row = [
  PresenceState,
  Presence['where'],
  'normal' | 'high',
  string[],
  string | { reason: DeliveryHoldReason },
]

const TABLE: Row[] = [
  ['active', 'desk', 'normal', [], 'front'],
  ['active', 'desk', 'high', [], 'front'],
  ['idle', 'mobile', 'normal', [], 'front'],
  ['active', 'desk', 'normal', ['notify'], `client:${LAPTOP},front`],
  ['idle', 'desk', 'high', ['notify'], `client:${LAPTOP},front`],
  ['busy', 'desk', 'normal', [], { reason: 'busy' }],
  ['busy', 'desk', 'normal', ['notify'], { reason: 'busy' }],
  ['busy', 'desk', 'high', [], 'front'],
  ['busy', 'desk', 'high', ['notify'], `client:${LAPTOP},front`],
  ['away', 'unknown', 'normal', [], { reason: 'away' }],
  ['away', 'out', 'normal', [], { reason: 'out' }],
  ['away', 'out', 'high', [], 'front'],
  ['away', 'out', 'high', ['notify'], `client:${LAPTOP},front`],
  ['offline', 'unknown', 'normal', ['notify'], { reason: 'offline' }],
  ['offline', 'unknown', 'high', [], 'front'],
  ['offline', 'unknown', 'high', ['notify'], `client:${LAPTOP},front`],
]

describe('reach ladder', () => {
  for (const [state, where, urgency, capabilities, expected] of TABLE) {
    test(`${state} / ${where} / ${urgency} / [${capabilities}] -> ${typeof expected === 'string' ? expected : `hold ${expected.reason}`}`, async () => {
      const plan = await planner(state, where).plan('ana', needs(urgency, capabilities))
      if (typeof expected === 'string') {
        expect(Array.isArray(plan)).toBe(true)
        expect((plan as DeliveryRoute[]).map((r) => r.id).join(',')).toBe(expected)
      } else {
        expect(plan).toEqual({ hold: expected })
      }
    })
  }

  test('a hold carries the end of the stated status', async () => {
    expect(await planner('busy', 'desk', 5_000).plan('ana', needs('normal'))).toEqual({
      hold: { reason: 'busy', until: 5_000 },
    })
  })

  test('a delivery the person asked for just now (immediate) is never held', async () => {
    const plan = await planner('offline', 'unknown').plan('ana', {
      ...needs('normal'),
      immediate: true,
    })
    expect((plan as DeliveryRoute[]).map((r) => r.id)).toEqual(['front'])
  })

  test('a note is never held', async () => {
    const plan = await planner('away', 'out').plan('ana', { ...needs('normal'), mode: 'note' })
    expect((plan as DeliveryRoute[]).map((r) => r.id)).toEqual(['front'])
  })

  test('urgent while busy or out: the front route asks for the reason line; active does not', async () => {
    sent.length = 0
    const req = {
      id: 'u',
      source: 'x',
      to: 'ana',
      name: 'n',
      text: 'the pipe burst',
      needs: needs('high'),
    } as DeliveryRequest
    for (const [state, where] of [
      ['busy', 'desk'],
      ['away', 'out'],
      ['active', 'desk'],
    ] as const) {
      const plan = (await planner(state, where).plan('ana', needs('high'))) as DeliveryRoute[]
      await plan[0]?.send(req, { attempt: 1 })
    }
    expect(sent[0]?.text).toContain('the person is busy')
    expect(sent[1]?.text).toContain('the person is out')
    expect(sent[2]?.text).toBe('the pipe burst')
  })
})
