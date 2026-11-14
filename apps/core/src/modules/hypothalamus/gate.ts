// The trigger gate of an `event` protocol (docs/specs/hypothalamus.md, "Triggers"): the trigger's `guard` is read when a run
// first moves, which is at its wake time (or at once for a run without a delay). A run has not moved yet while it sits on its
// start step with no visit, so the driver reads that state and needs no flag of its own. Pure apart from the injected ports.
// `approval.pending` is special: it answers "pending, but due later" when the approval's current expiry moved (a TTL change),
// so the run waits again until `expiresAt - beforeMs`.
import type { Trigger } from '@keith/contracts'
import { type ConditionPorts, evaluateCondition, pendingApproval } from './conditions.ts'

export type GateVerdict = { kind: 'pass' } | { kind: 'skip' } | { kind: 'wait'; wakeAt: number }

export interface GateInput {
  trigger: Trigger
  viewer: string
  ports: ConditionPorts
  now: number
  /** The run's trigger ref: an `approval:<id>` ref names the approval an `approval.pending` guard reads. */
  triggerRef: string
}

export async function gateVerdict(input: GateInput): Promise<GateVerdict> {
  const { trigger, viewer, ports, now } = input
  if (trigger.kind !== 'event' || trigger.guard === undefined) return { kind: 'pass' }
  const guard = trigger.guard
  if (guard.kind === 'approval.pending') {
    const approvalId = guard.approvalId ?? approvalOfRef(input.triggerRef)
    if (approvalId === undefined) return { kind: 'skip' }
    const live = await pendingApproval(ports, approvalId, now)
    if (live === null) return { kind: 'skip' }
    const beforeMs = trigger.until?.beforeMs
    if (beforeMs !== undefined && live.expiresAt - beforeMs > now) {
      return { kind: 'wait', wakeAt: live.expiresAt - beforeMs }
    }
    return { kind: 'pass' }
  }
  return (await evaluateCondition(guard, { viewer, ports })) ? { kind: 'pass' } : { kind: 'skip' }
}

/** The trigger ref of an event that names an approval (`brain.amygdala.wait`): one run per approval. */
export const APPROVAL_REF = 'approval:'

export const approvalRef = (approvalId: string): string => `${APPROVAL_REF}${approvalId}`

/** The approval a trigger ref names, or undefined for any other ref. */
export function approvalOfRef(ref: string): string | undefined {
  return ref.startsWith(APPROVAL_REF) ? ref.slice(APPROVAL_REF.length) : undefined
}
