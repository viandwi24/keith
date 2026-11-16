// The consent table (ADR-0039 §3, amending ADR-0036 §4): effect × clean/tainted × where the targets came from → an answer. Pure, so
// `tool.approve` stays deterministic.
import type { ConsentContext, ConsentTier, ToolEffect } from '@keith/contracts'

/** What consent says about a call: run it, or wait as an approval whose tier says where it is confirmed. */
export type ConsentDecision =
  | { status: 'approved' }
  | { status: 'user-approval'; tier: ConsentTier }

/**
 * - `none`: runs.
 * - `local`: runs when reversible (with undo); otherwise no opinion (the tool's own rules and the agent's policy decide), clean or tainted.
 * - `behavior`: runs when clean (with undo); asked in conversation when tainted.
 * - `egress`: runs when its targets are the person's or the turn is clean; asked in conversation otherwise.
 * - `destructive`: runs when its targets are in the person's newest message; otherwise asked in conversation when clean and confirmed
 *   on a trusted device when tainted.
 * - no effect: no opinion.
 * - `stepUp`: the call is a step-up tool (persona, model switch) or a shell call and the client that asked has not stepped up: whatever
 *   would run or be asked in conversation waits on a trusted device instead (the card asks for the step-up), except a clean reversible
 *   change (undo and the budget caps are its guard; ADR-0036 §4).
 * It never answers `denied`.
 */
export function consentDecision(input: {
  effect: ToolEffect | undefined
  reversible: boolean
  context: ConsentContext
  /** Every target of the call came from the person's own messages (ADR-0039 §2). */
  fromPerson?: boolean
  stepUp?: boolean
}): ConsentDecision | undefined {
  const decision = base(input)
  if (
    input.reversible &&
    input.context === 'clean' &&
    (input.effect === 'local' || input.effect === 'behavior')
  )
    return decision
  if (input.stepUp === true && decision !== undefined && input.effect !== 'none')
    return { status: 'user-approval', tier: 'device' }
  return decision
}

function base(input: {
  effect: ToolEffect | undefined
  reversible: boolean
  context: ConsentContext
  fromPerson?: boolean
}): ConsentDecision | undefined {
  const { effect, reversible, context } = input
  const fromPerson = input.fromPerson === true
  const clean = context === 'clean'
  switch (effect) {
    case 'none':
      return { status: 'approved' }
    case 'local':
      return reversible ? { status: 'approved' } : undefined
    case 'behavior':
      return clean ? { status: 'approved' } : { status: 'user-approval', tier: 'conversation' }
    case 'egress':
      return fromPerson || clean
        ? { status: 'approved' }
        : { status: 'user-approval', tier: 'conversation' }
    case 'destructive':
      if (fromPerson) return { status: 'approved' }
      return { status: 'user-approval', tier: clean ? 'conversation' : 'device' }
    default:
      return undefined
  }
}
