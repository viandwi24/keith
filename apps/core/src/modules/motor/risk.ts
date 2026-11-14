import type { NodeCapabilityRegistry } from '../nodes/index.ts'
import { createNodeCapabilityRegistry } from '../nodes/index.ts'
import { callOf, MOTOR_REMOTE_TOOL, runsUnasked } from './remote.ts'

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
