/** Setup of the M3 gate tests: a core with scripted models and test nodes on a real socket. */
import type { AttentionItemWire } from 'eharness/http'
import type { Core, CoreOptions, CoreTiming } from '../compose.ts'
import { boot, connect, FAST, newDir, type Running, send } from './core-harness.ts'
import { createGate, testProvider } from './scripted-providers.ts'
import { manifestOf, pairNode, TestNode, type TestNodeOptions } from './test-node.ts'
import { until } from './wait.ts'

export const NODE_TIMING: Partial<CoreTiming> = {
  ...FAST,
  nodeHeartbeatMs: 100,
  nodeHeartbeatTimeoutMs: 600,
  nodeSweepEveryMs: 50,
  nodeTimeoutGraceMs: 100,
}

export type Booted = Running & { token: string }

export const baseUrl = (r: Running): string => r.server.url.origin
export const TASK_ID = 'front:owner:agent:c1'

/** A tool call of `cortex.general` on `motor_remote`. */
export const motorCall = (
  id: string,
  node: string,
  capability: string,
  input?: Record<string, unknown>,
) => ({
  toolName: 'motor_remote',
  toolCallId: id,
  input: { node, capability, ...(input === undefined ? {} : { input }) },
})

export const shell = (
  id: string,
  node: string,
  command: string,
  extra: Record<string, unknown> = {},
) => motorCall(id, node, 'shell.exec', { command, ...extra })

const spawnGeneral = (id: string) => ({
  toolName: 'agent',
  toolCallId: id,
  input: {
    subagent_type: 'cortex.general',
    description: 'machine task',
    prompt: 'Do the task on the machine.',
    run_in_background: true,
  },
})

export interface ScenarioOptions {
  /** Steps of the `cortex.general` model (one delegated task). */
  worker?: Parameters<typeof testProvider>[0]['models'][string]
  /** Steps of the front model; default: delegate, acknowledge, relay the report. */
  front?: Parameters<typeof testProvider>[0]['models'][string]
  nodes?: Array<Partial<TestNodeOptions> & { name: string }>
  env?: Record<string, string>
  /** Prices (USD per 1M tokens) and a context window for the front and worker models. */
  pricing?: { input: number; output: number }
  /** Context window of the front and worker models (default: unknown, 128k). */
  contextWindow?: number
  /** Hold the front model's calls: pass a released gate and `close()` it later to make the front session busy. */
  frontGate?: ReturnType<typeof createGate>
  /** Hold the worker's model calls until released (default: open). */
  workerGate?: ReturnType<typeof createGate>
  timing?: Partial<CoreTiming>
  /** Capability specs of a driver the core does not ship (`CoreOptions.nodeCapabilities`). */
  nodeCapabilities?: CoreOptions['nodeCapabilities']
}

export interface Scenario {
  r: Booted
  /** The data folder of the core. */
  dataDir: string
  core: Core
  nodes: Record<string, TestNode>
  worker: ReturnType<typeof testProvider>
  front: ReturnType<typeof testProvider>
  /** Messages the worker model got, as one string per call. */
  workerPrompts(): string[]
}

/** Boot a core with scripted front and worker models, pair and connect the given nodes. */
export async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const front = testProvider({
    id: 'front-p',
    ...(options.pricing === undefined && options.contextWindow === undefined
      ? {}
      : { info: { f: priced(options.pricing, options.contextWindow) } }),
    ...(options.frontGate === undefined ? {} : { gate: options.frontGate }),
    models: {
      f: options.front ?? [
        { toolCalls: [spawnGeneral('c1')] },
        { text: 'Okay, I will do it.' },
        { text: 'Done: machine report received.' },
      ],
    },
  })
  const worker = testProvider({
    id: 'cortex-p',
    ...(options.pricing === undefined && options.contextWindow === undefined
      ? {}
      : { info: { w: priced(options.pricing, options.contextWindow) } }),
    models: { w: options.worker ?? [{ text: 'No task.' }] },
    gate: options.workerGate ?? gateOpen(),
  })
  const config = newDir(options.env)
  const r = await boot(
    config,
    [front as never, worker as never],
    undefined,
    { ...NODE_TIMING, ...options.timing },
    undefined,
    options.nodeCapabilities === undefined ? {} : { nodeCapabilities: options.nodeCapabilities },
  )
  await connect(r.client)
  const nodes: Record<string, TestNode> = {}
  for (const spec of options.nodes ?? []) {
    nodes[spec.name] = await pairAndConnect(r, spec)
  }
  return {
    r,
    dataDir: config.dataDir,
    core: r.core,
    nodes,
    worker,
    front,
    workerPrompts: () => (worker.models.get('w')?.prompts ?? []).map((p) => JSON.stringify(p)),
  }
}

const priced = (pricing?: { input: number; output: number }, contextWindow = 200_000) => ({
  contextWindow,
  ...(pricing === undefined ? {} : { pricing }),
})

function gateOpen() {
  const gate = createGate()
  gate.release()
  return gate
}

export async function pairAndConnect(
  r: Booted,
  spec: Partial<TestNodeOptions> & { name: string },
): Promise<TestNode> {
  const { code } = await r.client.rpc.nodes.pair()
  const creds = await pairNode(baseUrl(r), code, manifestOf(spec.name, spec.allowShell ?? true))
  const node = new TestNode({ baseUrl: baseUrl(r), token: creds.token, ...spec })
  await node.connect()
  return node
}

export async function attentionItems(r: Booted): Promise<AttentionItemWire[]> {
  const response = await fetch(new URL('/attention', r.server.url), {
    headers: { authorization: `Bearer ${r.token}` },
  })
  if (!response.ok) throw new Error(`GET /attention: ${response.status}`)
  return ((await response.json()) as { items: AttentionItemWire[] }).items
}

/** Wait until `n` items wait for the owner. */
export const waitForAttention = (r: Booted, n = 1): Promise<AttentionItemWire[]> =>
  until(
    `${n} item(s) in /attention`,
    () => attentionItems(r),
    (items) => items.length >= n,
  )

export async function answerApproval(
  r: Booted,
  item: AttentionItemWire,
  answer: { approved: boolean; reason?: string; remember?: 'session' },
): Promise<{ status: string }> {
  const response = await fetch(new URL(`/attention/${item.id}/answer`, r.server.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: item.sessionId, answer: { kind: 'approval', ...answer } }),
  })
  if (!response.ok) throw new Error(`answer: ${response.status} ${await response.text()}`)
  return (await response.json()) as { status: string }
}

/** The owner asks; the front delegates; the worker starts. Returns once the front answered. */
export async function ask(r: Booted, text = 'check the machine'): Promise<void> {
  await send(r.client, text)
}
