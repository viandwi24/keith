import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { CAPABILITIES, type ShellExecInput } from '@keith/contracts'
import type { CapabilityResult, DriverDefinition } from '@keith/driver-sdk'
import { NODE_VERSION } from '../manifest.ts'
import { shellEnv } from '../platform/config.ts'
import type { NodePolicy } from './index.ts'
import { OUTPUT_CAP, OutputCollector } from './output-cap.ts'

/** Hard ceiling for one command, whatever core asks for. */
export const MAX_TIMEOUT_MS = 120_000
/** Wait between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_000
/** How long to keep draining pipes after the shell itself exited. */
const DRAIN_MS = 1_000

export function fail(
  code: Extract<CapabilityResult, { ok: false }>['code'],
  message: string,
): CapabilityResult {
  return { ok: false, code, message }
}

/** Resolve `cwd` against the workdir; a path that leaves the workdir (even by symlink) is null. */
export async function resolveCwd(workdir: string, cwd: string | undefined): Promise<string | null> {
  const root = await realpath(workdir)
  const target = await realpath(resolve(workdir, cwd ?? '.'))
  return target === root || target.startsWith(root + sep) ? target : null
}

export interface ShellRunOptions {
  input: ShellExecInput
  cwd: string
  /** Timeout asked by core for this invoke. */
  invokeTimeoutMs: number
  signal: AbortSignal
  onProgress(chunk: string, stream: 'stdout' | 'stderr'): void
  killGraceMs?: number
}

/**
 * Run a command in its own process group (`detached` makes Bun call setsid, so pgid = pid).
 * Timeout and abort signal the whole group: SIGTERM, then SIGKILL after the grace period.
 */
export async function runShell(options: ShellRunOptions): Promise<CapabilityResult> {
  const { input, signal } = options
  const timeoutMs = Math.min(
    input.timeoutMs ?? MAX_TIMEOUT_MS,
    options.invokeTimeoutMs,
    MAX_TIMEOUT_MS,
  )
  if (signal.aborted) return fail('cancelled', 'cancelled before start')

  const proc = Bun.spawn(['/bin/sh', '-c', input.command], {
    cwd: options.cwd,
    env: shellEnv(),
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let outcome: 'timeout' | 'cancelled' | null = null
  const killGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid, sig)
    } catch {
      try {
        proc.kill(sig)
      } catch {
        // already gone
      }
    }
  }
  const terminate = (why: 'timeout' | 'cancelled'): void => {
    if (outcome) return
    outcome = why
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), options.killGraceMs ?? KILL_GRACE_MS)
  }
  const timer = setTimeout(() => terminate('timeout'), timeoutMs)
  // the executor aborts with reason `timeout` when the invoke's clock passes, `cancelled` otherwise
  const onAbort = (): void => terminate(signal.reason === 'timeout' ? 'timeout' : 'cancelled')
  signal.addEventListener('abort', onAbort, { once: true })

  const collector = new OutputCollector()
  let streamed = 0
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
  ): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      const chunk = decoder.decode(value, { stream: true })
      collector.push(chunk)
      if (streamed < OUTPUT_CAP) {
        const part = chunk.slice(0, OUTPUT_CAP - streamed)
        streamed += part.length
        options.onProgress(part, name)
      }
    }
  }
  const pumps = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])

  const exitCode = await proc.exited
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
  // A background child may keep the pipes open; do not wait for it forever.
  await Promise.race([pumps, Bun.sleep(DRAIN_MS)])

  if (outcome === 'timeout') return fail('timeout', `timed out after ${timeoutMs} ms`)
  if (outcome === 'cancelled') return fail('cancelled', 'cancelled')
  if (proc.signalCode) return fail('failed', `killed by ${proc.signalCode}`)
  return { ok: true, output: collector.text(), exitCode }
}

/**
 * The built-in driver `shell` (`shell.exec`). `allowShell` off refuses every call; the rest is
 * the same code as before the driver layer.
 */
export function shellDriver(policy: NodePolicy, killGraceMs?: number): DriverDefinition {
  return {
    name: 'shell',
    version: NODE_VERSION,
    capabilities: [{ id: 'shell.exec', schemaVersion: CAPABILITIES['shell.exec'].version }],
    async invoke(call, ctx) {
      if (!policy.allowShell) {
        return fail('refused-by-policy', 'shell.exec is disabled on this node (allowShell is off)')
      }
      const input = CAPABILITIES['shell.exec'].input.safeParse(call.input)
      if (!input.success) return fail('failed', `invalid input: ${input.error.message}`)

      let cwd: string | null
      try {
        cwd = await resolveCwd(policy.workdir, input.data.cwd)
      } catch (error) {
        return fail('failed', `cwd is not usable: ${(error as Error).message}`)
      }
      if (cwd === null) return fail('refused-by-policy', 'cwd is outside the node workdir')

      return runShell({
        input: input.data,
        cwd,
        invokeTimeoutMs: call.timeoutMs,
        signal: ctx.signal,
        ...(killGraceMs === undefined ? {} : { killGraceMs }),
        onProgress: (chunk, stream) => ctx.progress(chunk, stream),
      })
    },
  }
}
