import { driverOf, RISKS, type Risk } from '@keith/contracts'
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin, untrustedContent } from 'eharness'
import { z } from 'zod'
import { capHeadTail } from '../../platform/text.ts'
import {
  createNodeCapabilityRegistry,
  type InvokeOutcome,
  type NodeCapabilityRegistry,
  type NodeRegistry,
} from '../nodes/index.ts'
import { prepareCall, type SandboxFilesOptions } from './sandbox-files.ts'
import { NODE_CALL_LIMIT_DEFAULT, NODE_CALL_LIMIT_KEY } from './settings.ts'

export const MOTOR_REMOTE_TOOL = 'motor_remote'
/** Default wall clock of one remote call (P4 decisions). */
export const REMOTE_TIMEOUT_MS = 120_000
/** Longest output text handed to the model: the start and the end are kept. */
export const OUTPUT_MAX_CHARS = 30_000
/** Progress is streamed to the UI at most this often, and only this much of the tail. */
const PROGRESS_EVERY_MS = 500
const PROGRESS_CHARS = 2_000
const HOUR_MS = 3_600_000
/** An image a node returns is refused above this many decoded bytes (1 MB; docs/specs/node-drivers.md, Driver desktop). */
export const IMAGE_MAX_BYTES = 1_000_000
/** Bounds of the in-memory admissions (one per call that ran without asking). */
const ADMISSIONS_MAX = 5_000

/** The registry of the built-in capabilities: what a motor without an explicit registry knows. */
const BUILTIN_CAPABILITIES: NodeCapabilityRegistry = createNodeCapabilityRegistry()

/** The drivers the core ships with: their capabilities are listed without any node announcing them. */
const BUILTIN_DRIVERS: ReadonlySet<string> = new Set(['system', 'shell'])

/**
 * The drivers that online nodes announce now. An offline node announces nothing for the turn, so its drivers are not
 * offered to the model (docs/specs/motor.md, Instructions).
 */
export function announcedDrivers(nodes: NodeRegistry): Set<string> {
  const drivers = new Set<string>()
  for (const node of nodes.list()) {
    if (node.status !== 'online') continue
    for (const id of node.capabilities) drivers.add(driverOf(id))
  }
  return drivers
}

/** Added only when an online node announces `desktop.*` (docs/specs/node-drivers.md, Driver desktop). */
export const DESKTOP_INSTRUCTIONS = `Desktop (desktop.* on a node): work in an observe, act, observe loop. Start with desktop.screenshot. Coordinates for desktop.input are pixels of the latest screenshot, so take a new one after each batch before you aim again. Send one action batch at a time and read its result before the next. Stop and ask the person at any password, payment or two-factor prompt; never type a password, a card number or a code, whether you were given it or found it. desktop.input is refused unless the node allows input.`

/**
 * Added only when an online node announces `sandbox.run` (docs/specs/node-drivers.md, Driver sandbox). Code goes to the
 * sandbox, never to a real machine's shell.
 */
export const SANDBOX_INSTRUCTIONS = `Code (sandbox.run, a sandbox node is online): run code (Python, Node, Bun or a shell script) with sandbox.run, never with shell.exec on a real machine. The sandbox has no network. It sees only the files you name in files (paths in the person's workspace, copied in read-only under /work), and the files you name in outputFiles are saved in the person's sandbox folder; say which. network: true is asked of the owner. Read stdout, stderr and exitCode and report the result inline. Say plainly when the code timed out or the output was cut.`

/**
 * Added while no online node announces `sandbox.run`: the worker must not offer code it cannot run, and never runs code on
 * a machine or on the core instead (ADR-0021 §3).
 */
export const NO_SANDBOX_INSTRUCTIONS = `Code: no sandbox node is online, so code cannot run now. Say so plainly. Never run code with shell.exec on a node, and never offer to run it on the core: the core never runs code for a worker.`

/**
 * What the model is told about the machines: the capabilities of the built-in drivers and of the drivers that `announced`
 * names, with what each needs in the way of approval. Built from the specs, so a new capability is listed without editing
 * this text. The desktop instructions come with an announced `desktop` driver.
 */
export function motorInstructionsOf(
  capabilities: NodeCapabilityRegistry,
  announced: ReadonlySet<string> = new Set(),
): string {
  const listed = capabilities
    .list()
    .filter((spec) => BUILTIN_DRIVERS.has(spec.driver) || announced.has(spec.driver))
  const lines = listed.map((spec) => {
    const need =
      spec.risk === 'read' || spec.approval === 'never'
        ? spec.approval === 'never'
          ? 'runs without asking the owner for low-risk inputs; riskier inputs ask the owner'
          : 'needs no approval'
        : 'the owner is asked to approve every call'
    const keys = 'shape' in spec.input ? Object.keys((spec.input as { shape: object }).shape) : []
    const input = keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`
    return `${spec.id} (${spec.summary} Input ${input}; ${need})`
  })
  const desktop = announced.has('desktop') ? `\n${DESKTOP_INSTRUCTIONS}` : ''
  const code = announced.has('sandbox') ? SANDBOX_INSTRUCTIONS : NO_SANDBOX_INSTRUCTIONS
  return `Machines: ${MOTOR_REMOTE_TOOL} runs a capability on a node (a machine paired with Keith, or "core", the machine Keith runs on). Capabilities: ${lines.join('; ')}. A refusal means it did not run.
Use nodes_status to see the node names, whether they are online and what they allow. Say plainly when a node is offline, refuses, or a command is denied or times out; never claim output you did not get.${desktop}
${code}`
}

/** The instructions of the built-in capabilities (kept for callers that do not hold a registry). */
export const MOTOR_INSTRUCTIONS = motorInstructionsOf(BUILTIN_CAPABILITIES)

const InputSchema = z.object({
  node: z.string().min(1).describe('Name of the node, e.g. laptop-e, or "core"'),
  capability: z.string().min(1).describe('A capability id, e.g. system.info or shell.exec'),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Input of the capability, e.g. { "command": "df -h" } for shell.exec'),
})

/** What the model sees: always an object, failures included. */
export type MotorResult =
  | {
      ok: true
      node: string
      capability: string
      output: unknown
      exitCode?: number
      running?: boolean
    }
  | { ok: false; node: string; capability: string; code: string; error: string }

/**
 * An image result in the MCP shape eharness understands (`{ content: [...] }`, docs/specs/09-tools-and-mcp.md,
 * "Media offload"). Its image part is never cut by the text cap; the text part holds the outcome and the metadata.
 */
export type MotorImageResult = {
  content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }>
}

/** The model-facing form of a tool result (the AI SDK's `toModelOutput`, the subset Keith produces). */
export type ModelOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: never }
  | {
      type: 'content'
      value: Array<
        { type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string }
      >
    }

/**
 * What the model sees of a result (eharness, docs/specs/09-tools-and-mcp.md, "Media offload"). An image result (`{ content }`
 * without `ok`) becomes its image parts; an image offloaded to a file arrives with its bytes read back by eharness, and a
 * part that is still a reference has no bytes and is dropped (the text that names the file stays). Any other result keeps
 * the default mapping: a string is text, anything else JSON.
 */
export function modelOutputOf(output: unknown): ModelOutput {
  if (typeof output === 'string') return { type: 'text', value: output }
  const record = (output ?? {}) as { content?: unknown; ok?: unknown }
  if (!Array.isArray(record.content) || 'ok' in record)
    return { type: 'json', value: (output ?? null) as never }
  const value: Extract<ModelOutput, { type: 'content' }>['value'] = []
  for (const part of record.content as Array<Record<string, unknown>>) {
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
      value.push({ type: 'image-data', data: part.data, mediaType: part.mimeType })
    else if (part.type === 'text' && typeof part.text === 'string')
      value.push({ type: 'text', text: part.text })
  }
  return { type: 'content', value }
}

/**
 * What the model reads of a node's result (ADR-0036 §6): the platform facts (`ok`, `node`, `capability`, the code and message of a
 * refusal) stay outside the frame; the text the machine produced (`output`, the text parts of a content result) goes inside an
 * `untrusted-content` frame, so an instruction a file or a command prints is never read as one.
 */
export function framedModelOutputOf(output: unknown): ModelOutput {
  const base = modelOutputOf(output)
  const frame = (text: string, capability?: unknown) =>
    untrustedContent(text, {
      source: 'node',
      ...(typeof capability === 'string' ? { name: capability } : {}),
    })
  if (base.type === 'text') return { type: 'text', value: frame(base.value) }
  if (base.type === 'content')
    return {
      type: 'content',
      value: base.value.map((part) =>
        part.type === 'text' ? { ...part, text: frame(part.text) } : part,
      ),
    }
  const value = base.value as Record<string, unknown> | null
  if (value === null || typeof value !== 'object' || value.output === undefined) return base
  const text =
    typeof value.output === 'string' ? value.output : (JSON.stringify(value.output) ?? '')
  return { type: 'json', value: { ...value, output: frame(text, value.capability) } as never }
}

/** An output that is an image: base64 `data` and an `image/*` `mimeType` (desktop.screenshot). */
function imageOf(
  output: unknown,
): { data: string; mimeType: string; rest: Record<string, unknown> } | undefined {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined
  const { data, mimeType, ...rest } = output as Record<string, unknown>
  if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/'))
    return undefined
  return { data, mimeType, rest }
}

function capOutput(output: unknown): unknown {
  if (typeof output === 'string') return capHeadTail(output, OUTPUT_MAX_CHARS)
  const text = JSON.stringify(output) ?? ''
  return text.length <= OUTPUT_MAX_CHARS ? output : capHeadTail(text, OUTPUT_MAX_CHARS)
}

function resultOf(
  node: string,
  capability: string,
  outcome: InvokeOutcome,
): MotorResult | MotorImageResult {
  if (outcome.ok) {
    const image = imageOf(outcome.output)
    if (image !== undefined) {
      if (Math.floor((image.data.length * 3) / 4) > IMAGE_MAX_BYTES)
        return failure(node, capability, 'failed', 'screenshot too large')
      const meta = capHeadTail(
        JSON.stringify({ ok: true, node, capability, ...image.rest }),
        OUTPUT_MAX_CHARS,
      )
      return {
        content: [
          { type: 'image', data: image.data, mimeType: image.mimeType },
          { type: 'text', text: meta },
        ],
      }
    }
    return {
      ok: true,
      node,
      capability,
      output: capOutput(outcome.output),
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    }
  }
  const text =
    outcome.code === 'refused-by-policy'
      ? `refused by the node's policy: ${outcome.message}`
      : outcome.code === 'timeout'
        ? `timeout: ${outcome.message}`
        : outcome.code === 'busy'
          ? `busy, try again later: ${outcome.message}`
          : outcome.message
  return { ok: false, node, capability, code: outcome.code, error: text }
}

/** Why a node that keeps shell off cannot run `shell.exec`: what the owner should do about it. */
export const shellOffMessage = (node: string): string =>
  node === 'core'
    ? 'core does not allow shell; start core with KEITH_CORE_ALLOW_SHELL=true'
    : `node ${node} does not allow shell; rejoin with --allow-shell`

const failure = (node: string, capability: string, code: string, error: string): MotorResult => ({
  ok: false,
  node,
  capability,
  code,
  error,
})

/** One call as the model wrote it. Read from the input only: the static registry decides, never node state. */
export interface MotorCall {
  node: string
  capability: string
  input: unknown
}

/** The call of a `motor_remote` input, or undefined when it is not one (no node or no capability). */
export function callOf(input: unknown): MotorCall | undefined {
  const parsed = z
    .object({ node: z.string(), capability: z.string(), input: z.unknown().optional() })
    .safeParse(input)
  return parsed.success
    ? { node: parsed.data.node, capability: parsed.data.capability, input: parsed.data.input }
    : undefined
}

/**
 * The risk of a call under the registry: a fixed risk ignores the input; a risk function gets the input parsed by
 * the spec. Undefined for an unknown capability or an input the spec cannot parse.
 */
export function riskOf(
  capabilities: NodeCapabilityRegistry,
  capability: string,
  input: unknown,
): Risk | undefined {
  const spec = capabilities.get(capability)
  if (spec === undefined) return undefined
  if (typeof spec.risk !== 'function') return spec.risk
  const parsed = spec.input.safeParse(input ?? {})
  return parsed.success ? spec.risk(parsed.data) : undefined
}

/**
 * Whether a call runs without asking anyone: a `read` call always does; a call of a capability with
 * `approval: 'never'` does when its risk is `write` or below. Everything else asks the owner, or is denied.
 */
export function runsUnasked(
  capabilities: NodeCapabilityRegistry,
  capability: string,
  input: unknown,
): boolean {
  const spec = capabilities.get(capability)
  if (spec === undefined) return false
  const risk = riskOf(capabilities, capability, input)
  if (risk === undefined) return false
  if (risk === 'read') return true
  return spec.approval === 'never' && RISKS.indexOf(risk) <= RISKS.indexOf('write')
}

interface Admission {
  admitted: boolean
  limit: number
}

export interface MotorOptions {
  nodes: NodeRegistry
  /** The capability registry of the core (the one the nodes are accepted against). Default: the built-ins. */
  capabilities?: NodeCapabilityRegistry
  /** Calls per hour one person may make to a capability with `approval: 'never'` (`NODE_CALL_LIMIT_KEY`). */
  callsPerHour?: () => number
  now?: () => number
  /** Workspace files of a `sandbox.run` call (`sandbox-files.ts`). Without it a call with files is refused. */
  files?: SandboxFilesOptions
}

/**
 * Plugin of `motor_remote`. The capability is looked up in the registry; its risk and `approval` come from the spec
 * (`tool.approve` and `ownerAnswers` read the same registry). A call that runs without asking is counted per person
 * (`ctx.principal`) in memory: past the limit it is refused with `rate-limited`. A session grant (`remember`) is kept
 * by eharness (`grants: { by: 'principal', applyAt: 'now' }` on the worker agent), scoped by `tool.grantScope` to
 * `<node id>:<capability>`.
 */
export function motorRemote(options: MotorOptions): HarnessPlugin<'keith-motor'> {
  const { nodes } = options
  const capabilities = options.capabilities ?? BUILTIN_CAPABILITIES
  const callsPerHour = options.callsPerHour ?? (() => NODE_CALL_LIMIT_DEFAULT)
  const now = options.now ?? Date.now
  /** Calls per person in the last hour (timestamps). */
  const windows = new Map<string, number[]>()
  /**
   * The admission of each call that ran without asking, by tool call id. `tool.approve` runs again on
   * re-validation, so the first decision of a call id is the one kept (the count is not taken twice).
   */
  const admissions = new Map<string, Admission>()

  const admit = (person: string, callId: string | undefined): Admission => {
    const known = callId === undefined ? undefined : admissions.get(callId)
    if (known !== undefined) return known
    const limit = callsPerHour()
    const t = now()
    const recent = (windows.get(person) ?? []).filter((at) => t - at < HOUR_MS)
    const admitted = recent.length < limit
    if (admitted) recent.push(t)
    windows.set(person, recent)
    const admission = { admitted, limit }
    if (callId !== undefined) {
      admissions.set(callId, admission)
      if (admissions.size > ADMISSIONS_MAX)
        admissions.delete(admissions.keys().next().value as string)
    }
    return admission
  }

  // a factory: the person of the turn (`ctx.principal`) is read when the tool runs, for the files of a call
  const remote = (ctx: HarnessContext) =>
    tool({
      description:
        'Run a capability on a node: system.info (OS, CPU, memory) or shell.exec (a shell command). Capabilities that need approval wait for the owner.',
      inputSchema: InputSchema,
      // the node's output is text from a machine the person does not control: outside (ADR-0036 §3)
      metadata: { risk: 'external', source: 'outside' },
      toModelOutput: ({ output }) => framedModelOutputOf(output),
      async *execute({ node: ref, capability, input }, { abortSignal, toolCallId }) {
        const known = nodes.find(ref)
        const node = known?.name ?? ref
        if (known === undefined) {
          const names = nodes.list().map((n) => n.name)
          yield failure(
            ref,
            capability,
            'unknown-node',
            `no node "${ref}" (known: ${names.join(', ')})`,
          )
          return
        }
        const spec = capabilities.get(capability)
        if (spec === undefined) {
          const ids = capabilities
            .list()
            .map((s) => s.id)
            .join(', ')
          yield failure(
            node,
            capability,
            'unknown-capability',
            `unknown capability "${capability}" (known: ${ids})`,
          )
          return
        }
        if (spec.driver === 'shell' && !known.allowShell) {
          yield failure(node, capability, 'shell-off', shellOffMessage(node))
          return
        }
        const checked = spec.input.safeParse(input ?? {})
        if (!checked.success) {
          yield failure(
            node,
            capability,
            'invalid-input',
            `invalid input for ${capability}: ${checked.error.issues
              .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
              .join('; ')}`,
          )
          return
        }
        const prepared = prepareCall(options.files, ctx.principal?.id, capability, checked.data)
        if (!prepared.ok) {
          yield failure(node, capability, 'path-refused', prepared.message)
          return
        }
        const admission = toolCallId === undefined ? undefined : admissions.get(toolCallId)
        if (admission !== undefined && !admission.admitted) {
          yield failure(
            node,
            capability,
            'rate-limited',
            `rate-limited: ${capability} runs at most ${admission.limit} times per hour per person (setting ${NODE_CALL_LIMIT_KEY})`,
          )
          return
        }
        const asked = (checked.data as { timeoutMs?: number }).timeoutMs
        const timeoutMs =
          asked === undefined ? REMOTE_TIMEOUT_MS : Math.min(asked, REMOTE_TIMEOUT_MS)

        let seen = ''
        let changed = false
        let finished: InvokeOutcome | undefined
        let wake: (() => void) | undefined
        const poke = (): void => wake?.()
        nodes
          .invoke(node, capability, prepared.input, {
            timeoutMs,
            signal: abortSignal,
            onProgress: (chunk) => {
              seen = (seen + chunk).slice(-PROGRESS_CHARS)
              changed = true
              poke()
            },
          })
          .catch(
            (error: unknown): InvokeOutcome => ({
              ok: false,
              code: 'failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          )
          .then((outcome) => {
            finished = prepared.finish(outcome)
            poke()
          })
        let lastYield = 0
        while (finished === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve
            if (finished !== undefined || (changed && Date.now() - lastYield >= PROGRESS_EVERY_MS))
              resolve()
            else if (changed) setTimeout(resolve, PROGRESS_EVERY_MS - (Date.now() - lastYield))
          })
          if (finished === undefined && changed && Date.now() - lastYield >= PROGRESS_EVERY_MS) {
            changed = false
            lastYield = Date.now()
            yield { ok: true, node, capability, output: seen, running: true } satisfies MotorResult
          }
        }
        yield resultOf(node, capability, finished)
      },
    })

  return definePlugin({
    name: 'keith-motor',
    setup: () => ({
      // read per turn: a node that comes or goes changes which drivers the model is told about
      instructions: [
        {
          text: () => motorInstructionsOf(capabilities, announcedDrivers(nodes)),
          refresh: 'turn',
        },
      ],
      tools: { [MOTOR_REMOTE_TOOL]: remote },
      hooks: {
        'tool.approve': (ctx, e) => {
          if (e.toolName !== MOTOR_REMOTE_TOOL) return
          const call = callOf(e.input)
          if (call === undefined)
            return { type: 'denied', reason: 'motor_remote needs node and capability' }
          const spec = capabilities.get(call.capability)
          if (spec === undefined)
            return { type: 'denied', reason: `unknown capability ${call.capability}` }
          const risk = riskOf(capabilities, call.capability, call.input)
          if (risk === 'read') return 'approved'
          if (spec.approval === 'never' && runsUnasked(capabilities, call.capability, call.input)) {
            // the per-person limit: counted here, once per call id, and refused in `execute`
            admit(ctx.principal?.id ?? '', e.toolCallId)
            return 'approved'
          }
          // an input the spec cannot parse has no risk yet: the owner is asked, and `execute` refuses it
          // A node that said shell is off in its manifest is refused before anyone is asked. This
          // reads the registry, but a miss (unknown or renamed node) falls through to the ask:
          // it can only deny, never approve.
          const target = nodes.find(call.node)
          if (spec.driver === 'shell' && target !== undefined && !target.allowShell)
            return { type: 'denied', reason: shellOffMessage(target.name) }
          return { type: 'user-approval', reason: `${call.capability} on ${call.node}` }
        },
        // the grant eharness records for `remember: 'session'` is keyed by node id, not name: a
        // revoked node paired again under the same name is a new id and is asked again. A node
        // that is not in the registry cannot be remembered (null): the call asks.
        'tool.grantScope': (_ctx, e) => {
          if (e.toolName !== MOTOR_REMOTE_TOOL) return
          const call = callOf(e.input)
          const id = call === undefined ? undefined : nodes.find(call.node)?.id
          return call === undefined || id === undefined ? null : `${id}:${call.capability}`
        },
      },
    }),
  })
}
