import { describe, expect, test } from 'bun:test'
import { consentDecision } from './consent-table.ts'

// The consent table (ADR-0039 §3): effect × clean/tainted × where the targets came from.

const RUNS = { status: 'approved' } as const
const ASK = { status: 'user-approval', tier: 'conversation' } as const
const DEVICE = { status: 'user-approval', tier: 'device' } as const

describe('consent table', () => {
  test.each([
    // effect, reversible, clean, tainted
    ['none', false, RUNS, RUNS],
    ['local reversible', true, RUNS, RUNS],
    ['local', false, undefined, undefined],
    ['behavior', true, RUNS, ASK],
  ] as const)('%s: clean and tainted', (name, reversible, clean, tainted) => {
    const effect = name.split(' ')[0] as 'none' | 'local' | 'behavior'
    expect(consentDecision({ effect, reversible, context: 'clean' })).toEqual(clean)
    expect(consentDecision({ effect, reversible, context: 'tainted' })).toEqual(tainted)
  })

  test('egress runs when the person gave the targets or the turn is clean; asked otherwise', () => {
    expect(consentDecision({ effect: 'egress', reversible: false, context: 'clean' })).toEqual(RUNS)
    expect(consentDecision({ effect: 'egress', reversible: false, context: 'tainted' })).toEqual(
      ASK,
    )
    expect(
      consentDecision({
        effect: 'egress',
        reversible: false,
        context: 'tainted',
        fromPerson: true,
      }),
    ).toEqual(RUNS)
  })

  test('destructive runs when its targets are the person’s; else asked when clean, device when tainted', () => {
    expect(consentDecision({ effect: 'destructive', reversible: false, context: 'clean' })).toEqual(
      ASK,
    )
    expect(
      consentDecision({ effect: 'destructive', reversible: false, context: 'tainted' }),
    ).toEqual(DEVICE)
    expect(
      consentDecision({
        effect: 'destructive',
        reversible: false,
        context: 'tainted',
        fromPerson: true,
      }),
    ).toEqual(RUNS)
  })

  test('no effect: no opinion', () => {
    expect(
      consentDecision({ effect: undefined, reversible: false, context: 'tainted' }),
    ).toBeUndefined()
  })

  test('step-up sends a call to the device, except a clean reversible change and a call with no effect', () => {
    expect(
      consentDecision({ effect: 'behavior', reversible: true, context: 'clean', stepUp: true }),
    ).toEqual(RUNS)
    expect(
      consentDecision({ effect: 'behavior', reversible: true, context: 'tainted', stepUp: true }),
    ).toEqual(DEVICE)
    expect(
      consentDecision({ effect: 'destructive', reversible: false, context: 'clean', stepUp: true }),
    ).toEqual(DEVICE)
    expect(
      consentDecision({ effect: 'none', reversible: false, context: 'tainted', stepUp: true }),
    ).toEqual(RUNS)
  })

  test('taint never denies', () => {
    for (const effect of ['none', 'local', 'behavior', 'egress', 'destructive'] as const)
      for (const context of ['clean', 'tainted'] as const)
        expect(consentDecision({ effect, reversible: false, context })?.status).not.toBe('denied')
  })
})
