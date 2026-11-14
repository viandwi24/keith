import { describe, expect, test } from 'bun:test'
import {
  keithContract,
  SuccessionClaimInputSchema,
  SuccessionPauseInputSchema,
  SuccessionSetWindowInputSchema,
  SuccessionViewSchema,
} from './index.ts'

const DAY_MS = 86_400_000

describe('succession inputs (docs/specs/succession.md, "Settings" and "RPC")', () => {
  test('the window takes 7 to 90 days, whole days only', () => {
    expect(SuccessionSetWindowInputSchema.safeParse({ days: 7 }).success).toBe(true)
    expect(SuccessionSetWindowInputSchema.safeParse({ days: 90 }).success).toBe(true)
    expect(SuccessionSetWindowInputSchema.safeParse({ days: 6 }).success).toBe(false)
    expect(SuccessionSetWindowInputSchema.safeParse({ days: 91 }).success).toBe(false)
    expect(SuccessionSetWindowInputSchema.safeParse({ days: 14.5 }).success).toBe(false)
  })

  test('a pause ends in the future and at most 180 days ahead', () => {
    const now = Date.now()
    expect(SuccessionPauseInputSchema.safeParse({ until: now + 10 * DAY_MS }).success).toBe(true)
    expect(SuccessionPauseInputSchema.safeParse({ until: now + 179 * DAY_MS }).success).toBe(true)
    expect(SuccessionPauseInputSchema.safeParse({ until: now + 181 * DAY_MS }).success).toBe(false)
    expect(SuccessionPauseInputSchema.safeParse({ until: now - DAY_MS }).success).toBe(false)
  })

  test('the claim takes no field', () => {
    expect(SuccessionClaimInputSchema.safeParse({}).success).toBe(true)
    expect(SuccessionClaimInputSchema.safeParse({ heir: 'ana' }).success).toBe(false)
    expect(SuccessionClaimInputSchema.safeParse({ password: 'x' }).success).toBe(false)
  })

  test('the heir view carries only the state, the claim date and when the claim opens', () => {
    const heir = SuccessionViewSchema.parse({
      role: 'heir',
      state: 'grace',
      claimableAt: null,
      claimOpensAt: Date.now(),
    })
    expect(Object.keys(heir).sort()).toEqual(['claimOpensAt', 'claimableAt', 'role', 'state'])
    expect(
      SuccessionViewSchema.safeParse({
        role: 'heir',
        state: 'nope',
        claimableAt: null,
        claimOpensAt: null,
      }).success,
    ).toBe(false)
    expect(
      SuccessionViewSchema.safeParse({ role: 'heir', state: 'grace', claimableAt: null }).success,
    ).toBe(false)
  })
})

describe('admin.succession procedures (capability metadata)', () => {
  const meta = (path: string) => {
    let node: unknown = keithContract
    for (const part of ['admin', 'succession', ...path.split('.')]) {
      node = (node as Record<string, unknown>)[part]
    }
    return ((node as { '~orpc'?: { meta?: object } })['~orpc']?.meta ?? {}) as {
      capability?: string
      stepUp?: boolean
    }
  }

  test('every change is succession.manage with a step-up', () => {
    for (const name of ['setHeir', 'clearHeir', 'setWindow', 'pause', 'resume']) {
      expect(meta(name).capability, name).toBe('succession.manage')
      expect(meta(name).stepUp, name).toBe(true)
    }
  })

  test('get is decided in the handler, and claim needs a step-up', () => {
    expect(meta('get').capability).toBe('authenticated')
    expect(meta('get').stepUp).toBeUndefined()
    expect(meta('claim').capability).toBe('authenticated')
    expect(meta('claim').stepUp).toBe(true)
  })
})
