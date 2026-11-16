import type { ConsentCallEffect } from '@keith/contracts'
import type { NodeCapabilityRegistry } from '../nodes/index.ts'
import { createNodeCapabilityRegistry } from '../nodes/index.ts'
import { callOf, MOTOR_REMOTE_TOOL, riskOf, runsUnasked } from './remote.ts'

/** What an approval for a machine action shows the person who answers (never node state). */
export interface MotorAsk {
  node: string
  capability: string
  /** The shell command, for `shell.exec`. */
  command?: string
}

/** Read the call of a `motor_remote` approval from its input; undefined when it is not one. */
export function motorAskOf(toolName: string, input: unknown): MotorAsk | undefined {
  if (toolName !== MOTOR_REMOTE_TOOL) return undefined
  const call = (input ?? {}) as { node?: unknown; capability?: unknown; input?: unknown }
  const command = (call.input as { command?: unknown } | undefined)?.command
  return {
    node: typeof call.node === 'string' ? call.node : '?',
    capability: typeof call.capability === 'string' ? call.capability : '?',
    ...(typeof command === 'string' ? { command } : {}),
  }
}

const BUILTIN_CAPABILITIES: NodeCapabilityRegistry = createNodeCapabilityRegistry()

/**
 * Whether the OWNER answers this approval, even in a member's session (docs/specs/motor.md). A pure function of the
 * tool, its input and the capability registry: a call that runs without asking is never routed; anything that still
 * asks (a risky input, a capability with `approval: 'by-risk'`) is routed to the owner, and so is a call whose
 * capability is unknown or unreadable (it is denied before it is asked, but a stored item must never be answerable
 * by a member by accident).
 */
export function ownerAnswers(
  toolName: string,
  input: unknown,
  capabilities: NodeCapabilityRegistry = BUILTIN_CAPABILITIES,
): boolean {
  const ask = motorAskOf(toolName, input)
  if (ask === undefined) return false
  const call = callOf(input)
  return !runsUnasked(capabilities, ask.capability, call?.input)
}

/**
 * The risk consent reads for a `motor_remote` call (ADR-0036 §4, `amygdala/consent.ts`): the tool is `external` as a whole, but a call
 * that runs unasked (`system.info`, a read capability) is a `read`, and a capability whose risk for this input is `destructive` is
 * `destructive`. Every other call, an unknown capability or an unreadable input included, is `external`. Any other tool: undefined.
 * Pure over the registry; `motorRemote`'s own `tool.approve` keeps deciding who is asked and what is denied (most restrictive wins).
 */
export function motorConsentRisk(
  capabilities: NodeCapabilityRegistry = BUILTIN_CAPABILITIES,
): (toolName: string, input: unknown) => 'read' | 'destructive' | 'external' | undefined {
  return (toolName, input) => {
    if (toolName !== MOTOR_REMOTE_TOOL) return undefined
    const call = callOf(input)
    if (call === undefined) return 'external'
    if (runsUnasked(capabilities, call.capability, call.input)) return 'read'
    return riskOf(capabilities, call.capability, call.input) === 'destructive'
      ? 'destructive'
      : 'external'
  }
}

/**
 * The consent effect of a `motor_remote` call (ADR-0039 §1): a call that runs unasked (`system.info`, a read capability) is `none`;
 * every other call runs code or changes a machine, so it is `destructive`. No targets: `motor_remote` runs in a worker, whose transcript
 * never holds the person's own words, and its own `tool.approve` asks the owner for every such call anyway (motor.md); consent only sets
 * the tier (conversation when the delegating turn was clean, device when tainted). Any other tool: undefined.
 */
export function motorConsentEffect(
  capabilities: NodeCapabilityRegistry = BUILTIN_CAPABILITIES,
): (toolName: string, input: unknown) => ConsentCallEffect | undefined {
  return (toolName, input) => {
    if (toolName !== MOTOR_REMOTE_TOOL) return undefined
    const call = callOf(input)
    if (call !== undefined && runsUnasked(capabilities, call.capability, call.input))
      return { effect: 'none' }
    return { effect: 'destructive' }
  }
}
