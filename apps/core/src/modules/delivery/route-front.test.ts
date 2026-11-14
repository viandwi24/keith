import { describe, expect, test } from 'bun:test'
import type { DeliveryRequest } from '@keith/contracts'
import type { HarnessAgent } from 'eharness'
import { FRONT_TURN_BUDGET_USD } from '../budget/index.ts'
import { createFrontRoute, INJECT_KEY_MAX, injectKey } from './route-front.ts'

interface Injected {
  session: string
  name: string
  payload: unknown
  options: Record<string, unknown>
}

/** A lead agent that records every inject, per session (the options are what the route passes). */
function lead() {
  const injected: Injected[] = []
  const agent = {
    session: (id: string, options: Record<string, unknown>) => ({
      inject: async (name: string, payload: unknown, injectOptions: Record<string, unknown>) =>
        void injected.push({
          session: id,
          name,
          payload,
          options: { ...options, ...injectOptions },
        }),
    }),
  } as unknown as HarnessAgent
  return { agent, injected }
}

const request = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  id: 'reminder:r1:fire-1',
  source: 'plugin:reminders',
  to: 'ana',
  name: 'reminder',
  text: 'pay the rent',
  needs: { mode: 'wake', capabilities: [], fanout: 'best', urgency: 'normal' },
  ...overrides,
})

function route(
  overrides: { remainingUsd?: (id: string) => number | null; agent?: HarnessAgent } = {},
) {
  const l = lead()
  const front = createFrontRoute({
    generations: { current: () => 0 },
    lead: () => overrides.agent ?? l.agent,
    lock: {} as never,
    remainingUsd: overrides.remainingUsd ?? (() => null),
    warn: () => {},
  })
  return { front, injected: l.injected }
}

describe('front route', () => {
  test('a wake delivery injects into the front session with the run id as the inject key', async () => {
    const t = route()
    expect(await t.front.send(request(), { attempt: 1 })).toEqual({ ok: true })
    expect(t.injected).toHaveLength(1)
    expect(t.injected[0]).toMatchObject({
      session: 'front:ana',
      name: 'eh.event',
      payload: { name: 'reminder', text: 'pay the rent', data: undefined },
      options: {
        deliver: 'next-turn',
        wake: true,
        key: 'reminder:r1:fire-1',
        principal: { id: 'ana' },
      },
    })
  })

  test('a note delivery stores the message without a turn and without a budget check', async () => {
    const t = route({ remainingUsd: () => 0 })
    const note = request({
      needs: { mode: 'note', capabilities: [], fanout: 'best', urgency: 'normal' },
    })
    expect(await t.front.send(note, { attempt: 1 })).toEqual({ ok: true })
    expect(t.injected[0]?.options).toMatchObject({ wake: false })
  })

  test('the payer without enough left for one turn gets budget and no inject', async () => {
    const t = route({ remainingUsd: (id) => (id === 'owner' ? FRONT_TURN_BUDGET_USD / 2 : null) })
    expect(await t.front.send(request({ billTo: 'owner' }), { attempt: 1 })).toEqual({
      ok: false,
      reason: 'budget',
    })
    expect(t.injected).toHaveLength(0)
  })

  test('a billed turn names the payer in the principal and keeps the recipient as the actor', async () => {
    const t = route()
    await t.front.send(request({ billTo: 'owner' }), { attempt: 1 })
    expect(t.injected[0]?.options).toMatchObject({ principal: { id: 'ana', billTo: 'owner' } })
  })

  test('no front agent yet is unavailable (retried by the service)', async () => {
    const front = createFrontRoute({
      generations: { current: () => 0 },
      lead: () => undefined,
      lock: {} as never,
      remainingUsd: () => null,
      warn: () => {},
    })
    expect(await front.send(request(), { attempt: 1 })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  test('a throwing inject is unavailable and logged', async () => {
    const warnings: string[] = []
    const agent = {
      session: () => ({
        inject: async () => {
          throw new Error('boom')
        },
      }),
    } as unknown as HarnessAgent
    const front = createFrontRoute({
      generations: { current: () => 0 },
      lead: () => agent,
      lock: {} as never,
      remainingUsd: () => null,
      warn: (m) => warnings.push(m),
    })
    expect(await front.send(request(), { attempt: 1 })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(warnings).toEqual(['delivery failed: boom'])
  })
})

describe('injectKey', () => {
  test('a run id up to 200 characters is its own key', () => {
    expect(injectKey('x'.repeat(INJECT_KEY_MAX))).toBe('x'.repeat(INJECT_KEY_MAX))
  })

  test('a longer run id is replaced by its SHA-256 hex (64 characters, stable)', () => {
    const long = 'y'.repeat(INJECT_KEY_MAX + 1)
    const key = injectKey(long)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(injectKey(long)).toBe(key)
    expect(injectKey('y'.repeat(INJECT_KEY_MAX + 2))).not.toBe(key)
  })
})
