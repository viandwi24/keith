// The consent table (ADR-0036 §4): risk x clean/tainted. Taint never denies.
import { describe, expect, test } from 'bun:test'
import type { ConsentContext } from '@keith/contracts'
import type { ToolRisk } from 'eharness'
import { type ConsentDecision, consentDecision } from './consent-table.ts'

const APPROVED: ConsentDecision = { status: 'approved' }
const conversation: ConsentDecision = { status: 'user-approval', tier: 'conversation' }
const device: ConsentDecision = { status: 'user-approval', tier: 'device' }

const rows: Array<[ToolRisk | undefined, boolean, ConsentContext, ConsentDecision | undefined]> = [
  ['read', false, 'clean', APPROVED],
  ['read', false, 'tainted', APPROVED],
  ['write', true, 'clean', APPROVED],
  ['write', true, 'tainted', conversation],
  ['write', false, 'clean', undefined],
  ['write', false, 'tainted', conversation],
  ['destructive', false, 'clean', conversation],
  ['destructive', false, 'tainted', device],
  ['external', false, 'clean', conversation],
  ['external', false, 'tainted', device],
  ['external', true, 'clean', conversation],
  [undefined, false, 'clean', undefined],
  [undefined, true, 'tainted', undefined],
]

describe('consentDecision', () => {
  test.each(rows)('%s (reversible %s), %s', (risk, reversible, context, expected) => {
    expect(consentDecision({ risk, reversible, context })).toEqual(expected)
  })

  test('a clean reversible write runs even without a step-up (undo is its guard)', () => {
    expect(
      consentDecision({ risk: 'write', reversible: true, context: 'clean', stepUp: true }),
    ).toEqual(APPROVED)
  })

  test.each<[ToolRisk, boolean, ConsentContext]>([
    ['write', true, 'tainted'],
    ['write', false, 'tainted'],
    ['destructive', false, 'clean'],
  ])('step-up not done: %s (reversible %s), %s waits on a device', (risk, reversible, context) => {
    expect(consentDecision({ risk, reversible, context, stepUp: true })).toEqual(device)
  })

  test('step-up not done never turns "no opinion" or a read into a question', () => {
    expect(
      consentDecision({ risk: 'write', reversible: false, context: 'clean', stepUp: true }),
    ).toBeUndefined()
    expect(
      consentDecision({ risk: 'read', reversible: false, context: 'clean', stepUp: true }),
    ).toEqual(APPROVED)
  })

  test('no row answers denied', () => {
    for (const [risk, reversible, context] of rows) {
      const decision = consentDecision({ risk, reversible, context })
      expect(decision === undefined || decision.status !== ('denied' as string)).toBe(true)
    }
  })
})
