// The consent table (ADR-0036 §4): risk × clean/tainted → an answer. Pure, so `tool.approve` stays deterministic.
import type { ConsentContext, ConsentTier } from '@keith/contracts'
import type { ToolRisk } from 'eharness'

/** What consent says about a call: run it, or wait as an approval whose tier says where it is confirmed. */
export type ConsentDecision =
  | { status: 'approved' }
  | { status: 'user-approval'; tier: ConsentTier }

/**
 * - `read`: runs.
 * - `write` marked reversible: runs when clean (with undo), asked in conversation when tainted.
 * - `destructive` and `external`: asked in conversation when clean, confirmed on a trusted device when tainted.
 * - any other `write`: no opinion when clean (the tool's own rules and the agent's policy decide, as before); asked in conversation
 *   when tainted.
 * - a tool with no risk: no opinion.
 * - `stepUp`: the call is a step-up tool (persona, model switch) and the client that asked has not stepped up: whatever would run or
 *   be asked in conversation waits for a trusted-device confirmation instead (the card asks for the step-up).
 * It never answers `denied` because of taint.
 */
export function consentDecision(input: {
  risk: ToolRisk | undefined
  reversible: boolean
  context: ConsentContext
  stepUp?: boolean
}): ConsentDecision | undefined {
  const decision = base(input)
  // a reversible change the person asked for in a clean conversation runs without a step-up: "undo" and the budget caps are its
  // guard, and a PIN session could not step up anyway (ADR-0036 §4). A shell command, or anything tainted, still binds.
  if (input.reversible && input.context === 'clean' && input.risk === 'write') return decision
  if (input.stepUp === true && decision !== undefined && input.risk !== 'read')
    return { status: 'user-approval', tier: 'device' }
  return decision
}

function base(input: {
  risk: ToolRisk | undefined
  reversible: boolean
  context: ConsentContext
}): ConsentDecision | undefined {
  const { risk, reversible, context } = input
  if (risk === 'read') return { status: 'approved' }
  if (risk === 'write') {
    if (context === 'clean') return reversible ? { status: 'approved' } : undefined
    return { status: 'user-approval', tier: 'conversation' }
  }
  if (risk === 'destructive' || risk === 'external')
    return { status: 'user-approval', tier: context === 'clean' ? 'conversation' : 'device' }
  return undefined
}
