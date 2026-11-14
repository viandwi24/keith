// The `act` step (docs/specs/hypothalamus.md, "`act`"; docs/specs/motor.md for the risk table). A node capability runs
// through the node registry and a plugin operation through the plugin host as the owner. Anything above `read` runs only
// with a stored pre-approval of the exact operation and input (ADR-0024 §3): the SHA-256 of the canonical JSON of
// `{ operation, input }` must be recorded for this step in the version. A replayed `act` never reaches this file: the
// engine turns a `started` act row left by a crash into `unknown` (drive.ts, "Restart").
import {
  CAPABILITIES,
  type CapabilityId,
  capabilityRisk,
  type ProtocolStep,
} from '@keith/contracts'
import { REMOTE_TIMEOUT_MS } from '../motor/index.ts'
import type { NodeRegistry } from '../nodes/index.ts'
import { actApprovalHash, KEITH_OWNER } from './authoring.ts'
import { type FlatDetail, type StepResult, type StepRunInput, subjectOf } from './ports.ts'

/** The plugin host as an `act` sees it: the declared risk of an operation, and a call as the owner (its guard decides). */
export interface PluginCaller {
  /** The operation's declared risk (`read`, `write`, `dangerous`), or undefined for an operation that is not loaded. */
  risk(plugin: string, operation: string): 'read' | 'write' | 'dangerous' | undefined
  call(call: {
    plugin: string
    operation: string
    input: unknown
    /** The owner's person id: the operation runs with the owner's rights and the plugin's own checks. */
    actor: string
  }): Promise<{ ok: true } | { ok: false; code: string }>
}

export interface ActPorts {
  nodes: Pick<NodeRegistry, 'find' | 'invoke'>
  plugins: PluginCaller
  /**
   * Every execution that reaches its call writes one row through this (`protocol.act`): the run, the step, the node or
   * plugin, the capability or operation, and the hash of `{ operation, input }`. Never the input or the output.
   */
  audit?: (detail: FlatDetail) => void
}

type ActStep = Extract<ProtocolStep, { kind: 'act' }>

/** Whether the version holds the pre-approval of this step's exact operation and input. */
function preApproved(input: StepRunInput, step: ActStep): boolean {
  const hash = actApprovalHash(step.operation, step.input)
  return input.approvals.some((item) => item.step === step.id && item.hash === hash)
}

/** An outcome code as the step outcome grammar takes it: lower case words with dashes. */
const reasonOf = (code: string): string => code.toLowerCase().replace(/[^a-z-]/g, '-')

/**
 * Runs an `act` step. Returns the outcome: `ok`; `refused:pre-approval` (a risky operation without its approval),
 * `refused:risk` (an unknown capability, or shell on a node that keeps it off); `failed:<reason>` for an unknown node or
 * operation, invalid input, or a call that failed. The output of the call is never stored: the detail holds ids only.
 */
export function createAct(ports: ActPorts): (input: StepRunInput) => Promise<StepResult> {
  return async (input) => {
    const { step } = input
    if (step.kind !== 'act') return { kind: 'done', outcome: 'failed:not-an-act' }
    // ADR-0024 §3: an `act` belongs to a protocol the owner (or the self layer) owns, checked against the owner found at
    // this step; a member's protocol never runs one
    if (input.protocolOwner !== KEITH_OWNER && input.protocolOwner !== input.ownerId) {
      return { kind: 'done', outcome: 'refused:risk' }
    }
    if (step.operation.kind === 'node.capability') {
      return nodeCapability(input, step, step.operation, ports)
    }
    return pluginOperation(input, step, step.operation, ports)
  }
}

async function nodeCapability(
  input: StepRunInput,
  step: ActStep,
  operation: Extract<ActStep['operation'], { kind: 'node.capability' }>,
  ports: ActPorts,
): Promise<StepResult> {
  const { capability, node } = operation
  const risk = capabilityRisk(capability)
  if (risk === undefined) return { kind: 'done', outcome: 'refused:risk' }
  const target = ports.nodes.find(node)
  if (target === undefined) return { kind: 'done', outcome: 'failed:unknown-node' }
  // the same refusal as the motor's shell rule: a node that keeps shell off never runs `shell.exec`
  if (capability === 'shell.exec' && !target.allowShell) {
    return { kind: 'done', outcome: 'refused:risk' }
  }
  const checked = CAPABILITIES[capability as CapabilityId].input.safeParse(step.input)
  if (!checked.success) return { kind: 'done', outcome: 'failed:invalid-input' }
  if (risk !== 'read' && !preApproved(input, step)) {
    return { kind: 'done', outcome: 'refused:pre-approval' }
  }
  const asked = (checked.data as { timeoutMs?: number }).timeoutMs
  const timeoutMs = Math.min(asked ?? REMOTE_TIMEOUT_MS, REMOTE_TIMEOUT_MS)
  ports.audit?.({
    runId: input.run.id,
    step: step.id,
    ...subjectOf(input.run.person),
    node: target.name,
    capability,
    hash: actApprovalHash(step.operation, step.input),
  })
  const outcome = await ports.nodes.invoke(node, capability, checked.data, { timeoutMs })
  if (!outcome.ok) return { kind: 'done', outcome: `failed:${reasonOf(outcome.code)}` }
  const exit = outcome.exitCode
  return {
    kind: 'done',
    outcome: 'ok',
    detail: { node: target.name, capability, ...(exit === undefined ? {} : { exitCode: exit }) },
  }
}

async function pluginOperation(
  input: StepRunInput,
  step: ActStep,
  operation: Extract<ActStep['operation'], { kind: 'plugin.operation' }>,
  ports: ActPorts,
): Promise<StepResult> {
  const { plugin, operation: name } = operation
  const risk = ports.plugins.risk(plugin, name)
  if (risk === undefined) return { kind: 'done', outcome: 'failed:unknown-operation' }
  if (risk !== 'read' && !preApproved(input, step)) {
    return { kind: 'done', outcome: 'refused:pre-approval' }
  }
  ports.audit?.({
    runId: input.run.id,
    step: step.id,
    ...subjectOf(input.run.person),
    plugin,
    operation: name,
    hash: actApprovalHash(step.operation, step.input),
  })
  const result = await ports.plugins.call({
    plugin,
    operation: name,
    input: step.input,
    actor: input.ownerId,
  })
  if (!result.ok) return { kind: 'done', outcome: `failed:${reasonOf(result.code)}` }
  return { kind: 'done', outcome: 'ok', detail: { plugin, operation: name } }
}
