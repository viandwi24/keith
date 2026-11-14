import { describe, expect, test } from 'bun:test'
import type { ProtocolDefinition, ProtocolStep } from '@keith/contracts'
import type { RunRecord } from '@keith/db'
import type { NodeRegistry } from '../nodes/index.ts'
import { type ActPorts, createAct, type PluginCaller } from './act.ts'
import { type ActApproval, actApprovalHash } from './authoring.ts'
import { harness, protocol, started } from './engine-harness.ts'
import type { StepRunInput } from './ports.ts'
import { createStepRunner } from './steps.ts'

// The `act` step (docs/specs/hypothalamus.md, "`act`"; docs/specs/motor.md): the static risk table decides which operation
// needs a pre-approval of its exact input; a changed input or an unknown name is refused or failed before any call; a node
// that keeps shell off never runs `shell.exec`; a plugin operation runs as the owner through the plugin's own guard; the
// output of a call never reaches the detail. The node registry and the plugin host are fakes.

type NodeCall = { ref: string; capability: string; input: unknown }
type PluginCall = { plugin: string; operation: string; input: unknown; actor: string }

function fakePorts(options: { invoke?: () => unknown; code?: string } = {}) {
  const nodeCalls: NodeCall[] = []
  const pluginCalls: PluginCall[] = []
  const nodes: Pick<NodeRegistry, 'find' | 'invoke'> = {
    find: (ref) =>
      ref === 'laptop' || ref === 'quiet'
        ? ({ id: `id-${ref}`, name: ref, allowShell: ref === 'laptop' } as never)
        : undefined,
    invoke: async (ref, capability, input) => {
      nodeCalls.push({ ref, capability, input })
      if (options.code !== undefined) {
        return { ok: false, code: options.code as never, message: 'nope' }
      }
      return { ok: true, output: options.invoke?.() ?? 'secret output', exitCode: 0 }
    },
  }
  const risks: Record<string, 'read' | 'write' | 'dangerous'> = {
    'notes.list': 'read',
    'notes.purge': 'dangerous',
  }
  const plugins: PluginCaller = {
    risk: (plugin, operation) => (plugin === 'notes' ? risks[operation] : undefined),
    call: async (call) => {
      pluginCalls.push(call)
      return call.operation === 'notes.purge' && options.code !== undefined
        ? { ok: false, code: options.code }
        : { ok: true }
    },
  }
  const ports: ActPorts = { nodes, plugins }
  return { ports, nodeCalls, pluginCalls }
}

const nodeStep = (
  node: string,
  capability: string,
  input: unknown,
): Extract<ProtocolStep, { kind: 'act' }> =>
  ({
    id: 'run',
    kind: 'act',
    operation: { kind: 'node.capability', node, capability },
    input,
  }) as Extract<ProtocolStep, { kind: 'act' }>

const pluginStep = (operation: string, input: unknown): Extract<ProtocolStep, { kind: 'act' }> =>
  ({
    id: 'run',
    kind: 'act',
    operation: { kind: 'plugin.operation', plugin: 'notes', operation },
    input,
  }) as Extract<ProtocolStep, { kind: 'act' }>

/**
 * The input an `act` runs with: the step, its approvals, the protocol's owner as stored (`keith` or a person id) and the
 * owner found at the step (`vian`). A `keith`-owned run acts for the owner found at its start (the same person here).
 */
function inputFor(
  step: ProtocolStep,
  approvals: ActApproval[] = [],
  protocolOwner = 'vian',
): StepRunInput {
  const person = protocolOwner === 'keith' ? 'vian' : protocolOwner
  return {
    run: { id: 'run-1', protocolId: 'p1', person } as RunRecord,
    definition: {} as ProtocolDefinition,
    approvals,
    step,
    visit: 1,
    key: 'run-1:run:1',
    now: 0,
    ownerId: 'vian',
    protocolOwner,
  }
}

/** The approval a version holds for a step: the hash of the exact operation and input. */
function approvalFor(step: Extract<ProtocolStep, { kind: 'act' }>): ActApproval[] {
  return [
    {
      step: step.id,
      hash: actApprovalHash(step.operation, step.input),
      approvedBy: 'vian',
      approvedAt: 0,
    },
  ]
}

describe('node capabilities', () => {
  test('a read capability runs without an approval', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('laptop', 'system.info', {})
    const result = await createAct(ports)(inputFor(step))
    expect(result).toMatchObject({ kind: 'done', outcome: 'ok', detail: { node: 'laptop' } })
    expect(nodeCalls).toHaveLength(1)
  })

  test('shell.exec without its pre-approval is refused and never reaches the node', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('laptop', 'shell.exec', { command: 'df -h' })
    expect(await createAct(ports)(inputFor(step))).toEqual({
      kind: 'done',
      outcome: 'refused:pre-approval',
    })
    expect(nodeCalls).toHaveLength(0)
  })

  test('shell.exec with the pre-approval of the exact input runs', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('laptop', 'shell.exec', { command: 'df -h' })
    const result = await createAct(ports)(inputFor(step, approvalFor(step)))
    expect(result).toMatchObject({ kind: 'done', outcome: 'ok' })
    expect(nodeCalls).toEqual([
      { ref: 'laptop', capability: 'shell.exec', input: { command: 'df -h' } },
    ])
  })

  test('a changed input is a different hash: the old approval does not cover it', async () => {
    const { ports, nodeCalls } = fakePorts()
    const approved = nodeStep('laptop', 'shell.exec', { command: 'df -h' })
    const changed = nodeStep('laptop', 'shell.exec', { command: 'rm -rf /tmp/x' })
    const result = await createAct(ports)(inputFor(changed, approvalFor(approved)))
    expect(result).toEqual({ kind: 'done', outcome: 'refused:pre-approval' })
    expect(nodeCalls).toHaveLength(0)
  })

  test('shell on a node that keeps shell off is refused even with an approval', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('quiet', 'shell.exec', { command: 'df -h' })
    const result = await createAct(ports)(inputFor(step, approvalFor(step)))
    expect(result).toEqual({ kind: 'done', outcome: 'refused:risk' })
    expect(nodeCalls).toHaveLength(0)
  })

  test('an unknown capability, an unknown node and invalid input never reach a node', async () => {
    const { ports, nodeCalls } = fakePorts()
    const act = createAct(ports)
    expect(await act(inputFor(nodeStep('laptop', 'mail.send', {})))).toEqual({
      kind: 'done',
      outcome: 'refused:risk',
    })
    expect(await act(inputFor(nodeStep('ghost', 'system.info', {})))).toEqual({
      kind: 'done',
      outcome: 'failed:unknown-node',
    })
    const bad = nodeStep('laptop', 'shell.exec', { command: '' })
    expect(await act(inputFor(bad, approvalFor(bad)))).toEqual({
      kind: 'done',
      outcome: 'failed:invalid-input',
    })
    expect(nodeCalls).toHaveLength(0)
  })

  test('a failed call is failed with the node error code; its output is never in the detail', async () => {
    const offline = fakePorts({ code: 'offline' })
    expect(await createAct(offline.ports)(inputFor(nodeStep('laptop', 'system.info', {})))).toEqual(
      {
        kind: 'done',
        outcome: 'failed:offline',
      },
    )
    const loud = fakePorts({ invoke: () => 'token-value-in-output' })
    const result = await createAct(loud.ports)(inputFor(nodeStep('laptop', 'system.info', {})))
    expect(JSON.stringify(result)).not.toContain('token-value-in-output')
  })
})

describe('plugin operations', () => {
  test('a read operation runs as the owner, without an approval', async () => {
    const { ports, pluginCalls } = fakePorts()
    const result = await createAct(ports)(inputFor(pluginStep('notes.list', { limit: 5 })))
    expect(result).toMatchObject({ kind: 'done', outcome: 'ok', detail: { plugin: 'notes' } })
    expect(pluginCalls).toEqual([
      { plugin: 'notes', operation: 'notes.list', input: { limit: 5 }, actor: 'vian' },
    ])
  })

  test('a dangerous operation needs its pre-approval; with it, the guard decides', async () => {
    const { ports, pluginCalls } = fakePorts({ code: 'FORBIDDEN' })
    const act = createAct(ports)
    const step = pluginStep('notes.purge', { older: 30 })
    expect(await act(inputFor(step))).toEqual({ kind: 'done', outcome: 'refused:pre-approval' })
    expect(pluginCalls).toHaveLength(0)
    expect(await act(inputFor(step, approvalFor(step)))).toEqual({
      kind: 'done',
      outcome: 'failed:forbidden',
    })
    expect(pluginCalls).toHaveLength(1)
  })

  test('an operation that is not loaded fails before any call', async () => {
    const { ports, pluginCalls } = fakePorts()
    expect(await createAct(ports)(inputFor(pluginStep('notes.absent', {})))).toEqual({
      kind: 'done',
      outcome: 'failed:unknown-operation',
    })
    expect(pluginCalls).toHaveLength(0)
  })
})

describe('an act inside a run', () => {
  test('a dangerous act with its approval runs once in the run, and the run is done', async () => {
    const { ports, pluginCalls } = fakePorts()
    const step = pluginStep('notes.purge', { older: 30 })
    const h = harness(
      undefined,
      createStepRunner({
        deliver: { deliver: async () => ({ status: 'delivered', route: 'front', attempts: 1 }) },
        people: { isActive: async () => true },
        budget: { remaining: async () => 1 },
        act: createAct(ports),
      }),
    )
    h.protocols.create(
      {
        id: 'p1',
        owner: 'vian',
        name: 'purge',
        definition: JSON.stringify(protocol([step])),
        approvals: JSON.stringify(approvalFor(step)),
        savedBy: 'vian',
      },
      h.now(),
    )
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'a' }))
    expect(h.runs.get(id)?.status).toBe('done')
    expect(pluginCalls).toHaveLength(1)
  })

  test('a started act left by a crash is unknown: no second call, the owner is told', async () => {
    const { ports, nodeCalls } = fakePorts()
    const sent: Array<{ id: string; to: string }> = []
    const h = harness(
      undefined,
      createStepRunner({
        deliver: {
          deliver: async (request) => {
            sent.push({ id: request.id, to: request.to })
            return { status: 'delivered', route: 'front', attempts: 1 }
          },
        },
        people: { isActive: async () => true },
        budget: { remaining: async () => 1 },
        act: createAct(ports),
      }),
    )
    h.define('p1', 'read', protocol([nodeStep('laptop', 'system.info', {})]), true, 'vian')
    const id = started(await h.engine.start({ protocolId: 'p1', trigger: 'time', triggerRef: 'b' }))
    expect(h.runs.get(id)?.status).toBe('done')
    expect(nodeCalls).toHaveLength(1)
    // the crash: the act row is `started` and the run was claimed again
    h.sqlite.run(
      "UPDATE protocol_runs SET status = 'waiting', wake_at = ?, step = 'run' WHERE id = ?",
      [h.now(), id],
    )
    h.sqlite.run(
      "INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at) VALUES (?, 'run', 'act', 'started', ?)",
      [id, h.now()],
    )
    await h.engine.tick()
    expect(nodeCalls).toHaveLength(1)
    expect(h.runs.get(id)?.status).toBe('failed')
    expect(h.runs.steps(id).at(-1)?.outcome).toBe('unknown')
    expect(sent).toEqual([{ id: `${id}:unknown`, to: 'vian' }])
  })
})

describe('who may run an act and what is written', () => {
  test('a member-owned protocol never runs an act, even a read one, and nothing is called', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('laptop', 'system.info', {})
    const result = await createAct(ports)(inputFor(step, [], 'ana'))
    expect(result).toEqual({ kind: 'done', outcome: 'refused:risk' })
    expect(nodeCalls.length).toBe(0)
  })

  test('a keith-owned protocol runs an act of its own', async () => {
    const { ports, nodeCalls } = fakePorts()
    const step = nodeStep('laptop', 'system.info', {})
    const result = await createAct(ports)(inputFor(step, [], 'keith'))
    expect(result).toMatchObject({ kind: 'done', outcome: 'ok' })
    expect(nodeCalls.length).toBe(1)
  })

  test('every execution that reaches its call writes one protocol.act row with the hash, never the input', async () => {
    const { ports } = fakePorts()
    const rows: Array<Record<string, unknown>> = []
    const step = nodeStep('laptop', 'shell.exec', { command: 'df -h' })
    await createAct({ ...ports, audit: (detail) => rows.push(detail) })(
      inputFor(step, approvalFor(step)),
    )
    expect(rows).toEqual([
      {
        runId: 'run-1',
        step: 'run',
        subject: 'vian',
        node: 'laptop',
        capability: 'shell.exec',
        hash: actApprovalHash(step.operation, step.input),
      },
    ])
    expect(JSON.stringify(rows)).not.toContain('df -h')
  })

  test('a refused act writes no row: nothing was executed', async () => {
    const { ports } = fakePorts()
    const rows: Array<Record<string, unknown>> = []
    const step = nodeStep('laptop', 'shell.exec', { command: 'df -h' })
    const result = await createAct({ ...ports, audit: (d) => rows.push(d) })(inputFor(step))
    expect(result).toEqual({ kind: 'done', outcome: 'refused:pre-approval' })
    expect(rows).toEqual([])
  })
})
