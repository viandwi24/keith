// The sandbox driver: one container per `sandbox.run` call, run by Docker or Podman on this node
// (docs/specs/node-drivers.md, "Driver sandbox"). The driver never reads the core; it sees the call and its options.
import {
  type CapabilityCall,
  type CapabilityResult,
  type DriverContext,
  defineDriver,
} from '@keith/driver-sdk'
import { containerName, killArgv, runArgv } from './argv.ts'
import {
  type Parsed,
  parseRunInput,
  parseSandboxOptions,
  type RunRequest,
  type SandboxOptions,
} from './options.ts'
import { OutputCollector } from './output.ts'
import type { RuntimeProcess, SpawnFn } from './process.ts'
import { failed, ok } from './result.ts'
import { chooseRuntime, type RuntimeName, type WhichFn } from './runtime.ts'
import { runStaged } from './staged.ts'

export const DRIVER_NAME = 'sandbox'
export const DRIVER_VERSION = '0.1.0'
/** Announced at schema v2; v1 calls keep working (no files). */
export const SANDBOX_CAPABILITIES = [{ id: 'sandbox.run', schemaVersion: 2 }] as const

export interface SandboxDeps {
  readonly spawn: SpawnFn
  readonly which: WhichFn
}

interface Settings {
  readonly options: SandboxOptions
  readonly runtime: RuntimeName
  /** Calls running now on this node; the limit is `options.maxConcurrent`. */
  active: number
}

/** Reads a stream into a collector, decoding UTF-8 as it comes. */
async function drain(stream: ReadableStream<Uint8Array>, into: OutputCollector): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) into.push(decoder.decode(chunk, { stream: true }))
  into.push(decoder.decode())
}

export function createSandboxDriver({ spawn, which }: SandboxDeps) {
  let settings: Settings | undefined

  /** The stored settings, read once from the options and the runtime lookup; a refusal is the message. */
  function settle(raw: Readonly<Record<string, unknown>>): Parsed<Settings> {
    if (settings !== undefined) return { ok: true, value: settings }
    const parsed = parseSandboxOptions(raw)
    if (!parsed.ok) return parsed
    const runtime = chooseRuntime(parsed.value.runtime, which)
    if (!runtime.ok) return { ok: false, message: runtime.message }
    settings = { options: parsed.value, runtime: runtime.value, active: 0 }
    return { ok: true, value: settings }
  }

  /** Runs one container for a checked call. The container is killed by name on timeout or cancel. */
  async function runContainer(
    input: RunRequest,
    call: CapabilityCall,
    current: Settings,
    ctx: DriverContext,
  ): Promise<CapabilityResult> {
    const { runtime, options } = current
    const name = containerName(call.callId)
    const image = options.images[input.language]
    let proc: RuntimeProcess
    try {
      proc = spawn(
        runArgv({
          runtime,
          name,
          image,
          language: input.language,
          code: input.code,
          network: input.network,
          stdin: input.stdin !== undefined,
        }),
        { stdin: input.stdin },
      )
    } catch (error) {
      return failed(
        `cannot start ${runtime}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    let timedOut = false
    let cancelled = false
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        try {
          await spawn(killArgv(runtime, name), {}).exited
        } catch {
          // the container may not exist yet or already be gone; the client kill below still runs
        }
        proc.kill()
      })()
      return stopping
    }
    const limit = Math.min(input.timeoutMs, call.timeoutMs)
    const timer = setTimeout(() => {
      timedOut = true
      void stop()
    }, limit)
    const onAbort = () => {
      cancelled = true
      void stop()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const stdout = new OutputCollector()
    const stderr = new OutputCollector()
    try {
      const [exitCode] = await Promise.all([
        proc.exited,
        drain(proc.stdout, stdout),
        drain(proc.stderr, stderr),
      ])
      await stopping
      if (cancelled) return failed('the call was cancelled', 'cancelled')
      return ok(
        {
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode,
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
        },
        exitCode,
      )
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  async function run(call: CapabilityCall, ctx: DriverContext): Promise<CapabilityResult> {
    const parsed = parseRunInput(call.input, call.schemaVersion)
    if (!parsed.ok) return failed(`invalid input: ${parsed.message}`)
    const current = settle(ctx.options)
    if (!current.ok) return failed(current.message)
    if (parsed.value.network && !current.value.options.network) {
      return failed(
        'network is off on this node: the sandbox option network is false. Add the driver again with --network to allow it.',
        'refused-by-policy',
      )
    }
    const limit = current.value.options.maxConcurrent
    if (current.value.active >= limit) {
      return failed(`busy: ${limit} sandbox calls already run on this node`, 'busy')
    }
    current.value.active += 1
    try {
      const request = parsed.value
      if (request.files.length > 0 || request.outputFiles.length > 0) {
        return await runStaged({
          spawn,
          runtime: current.value.runtime,
          name: containerName(call.callId),
          image: current.value.options.images[request.language],
          network: request.network,
          language: request.language,
          code: request.code,
          ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
          timeoutMs: Math.min(request.timeoutMs, call.timeoutMs),
          files: request.files,
          outputFiles: request.outputFiles,
          signal: ctx.signal,
        })
      }
      return await runContainer(request, call, current.value, ctx)
    } finally {
      current.value.active -= 1
    }
  }

  return defineDriver({
    name: DRIVER_NAME,
    version: DRIVER_VERSION,
    capabilities: SANDBOX_CAPABILITIES,
    // The one capability is always offered: the `network` option refuses a call, it does not hide the capability.
    offered(_options: Readonly<Record<string, unknown>>) {
      return SANDBOX_CAPABILITIES
    },
    start(ctx: DriverContext) {
      const parsed = settle(ctx.options)
      if (!parsed.ok) throw new Error(parsed.message)
    },
    async invoke(call: CapabilityCall, ctx: DriverContext): Promise<CapabilityResult> {
      if (call.capability !== 'sandbox.run') return failed(`unknown capability ${call.capability}`)
      if (call.schemaVersion !== 1 && call.schemaVersion !== 2) {
        return failed(`sandbox.run schema version ${call.schemaVersion} is not handled`)
      }
      if (ctx.signal.aborted) return failed('the call was cancelled', 'cancelled')
      return run(call, ctx)
    },
  })
}
