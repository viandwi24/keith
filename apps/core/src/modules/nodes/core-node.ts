import { realpath } from 'node:fs/promises'
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os'
import { resolve, sep } from 'node:path'
import { CAPABILITIES, type Node } from '@keith/contracts'
import { HeadTail } from '../../platform/text.ts'
import type { InvokeOutcome, LocalNode } from './types.ts'

/** Id and name of the in-process node. */
export const CORE_NODE_ID = 'core'
/** The core is not a daemon: it has the built-in drivers `system` and `shell` only, never `desktop` or `sandbox`. */
const CORE_CAPABILITIES = ['system.info', 'shell.exec'] as const
/** Wait between SIGTERM and SIGKILL of a process group. */
export const KILL_GRACE_MS = 2_000
/** Output kept of one command: the start and the end. */
const OUTPUT_HEAD = 20_000
const OUTPUT_TAIL = 10_000
const DEFAULT_TIMEOUT_MS = 120_000
/** How long to keep draining the pipes after the shell itself exited. */
const DRAIN_MS = 500

export interface CoreNodeOptions {
  /** `KEITH_CORE_ALLOW_SHELL`. */
  allowShell: boolean
  version: string
  /** Working directory of commands (default: the process folder). */
  workdir?: string
  /** Environment of commands: never Keith's own. */
  env: Record<string, string>
  killGraceMs?: number
  now?: () => number
}

const failed = (
  code: Extract<InvokeOutcome, { ok: false }>['code'],
  message: string,
): InvokeOutcome => ({
  ok: false,
  code,
  message,
})

/**
 * Resolve `cwd` against the workdir, the same rule a node applies (`apps/node/src/executor/shell.ts`):
 * the real path must be the workdir or inside it, so `..`, `/` and a symlink out are null.
 */
export async function resolveCwd(workdir: string, cwd: string | undefined): Promise<string | null> {
  const root = await realpath(workdir)
  const target = await realpath(resolve(workdir, cwd ?? '.'))
  return target === root || target.startsWith(root + sep) ? target : null
}

/**
 * The node `core`: the machine core runs on, reached through the same `motor_remote` path as any
 * node. `system.info` always works; `shell.exec` only with `allowShell`.
 */
export function createCoreNode(options: CoreNodeOptions): LocalNode {
  const now = options.now ?? Date.now
  const createdAt = now()
  const workdir = options.workdir ?? process.cwd()

  return {
    node(): Node {
      return {
        id: CORE_NODE_ID,
        name: CORE_NODE_ID,
        os: platform(),
        arch: arch(),
        version: options.version,
        capabilities: [...CORE_CAPABILITIES],
        drivers: [],
        refused: [],
        allowShell: options.allowShell,
        status: 'online',
        lastSeenAt: now(),
        createdAt,
      }
    },
    async run(capability, input, run) {
      if (capability === 'system.info') {
        return {
          ok: true,
          output: {
            hostname: hostname(),
            os: platform(),
            release: release(),
            arch: arch(),
            cpus: cpus().length,
            memoryTotalBytes: totalmem(),
            memoryFreeBytes: freemem(),
            uptimeSeconds: Math.round(uptime()),
            loadAverage: loadavg(),
          },
        }
      }
      if (capability !== 'shell.exec')
        return failed('unknown-capability', `unknown capability ${capability}`)
      if (!options.allowShell) {
        return failed(
          'refused-by-policy',
          'shell.exec is disabled on core (KEITH_CORE_ALLOW_SHELL)',
        )
      }
      const parsed = CAPABILITIES['shell.exec'].input.safeParse(input)
      if (!parsed.success) return failed('failed', `invalid input: ${parsed.error.message}`)
      let cwd: string | null
      try {
        cwd = await resolveCwd(workdir, parsed.data.cwd)
      } catch (error) {
        return failed('failed', `cwd is not usable: ${(error as Error).message}`)
      }
      if (cwd === null) return failed('refused-by-policy', 'cwd is outside the workdir')
      return runShell(parsed.data, {
        cwd,
        env: options.env,
        timeoutMs: Math.min(parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS, run.timeoutMs),
        signal: run.signal,
        killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
        ...(run.onProgress === undefined ? {} : { onProgress: run.onProgress }),
      })
    },
  }
}

interface ShellRun {
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
  killGraceMs: number
  onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

/** `/bin/sh -c` in its own process group; timeout and abort end the whole group. */
async function runShell(input: { command: string }, run: ShellRun): Promise<InvokeOutcome> {
  if (run.signal.aborted) return failed('cancelled', 'cancelled before start')
  const proc = Bun.spawn(['/bin/sh', '-c', input.command], {
    cwd: run.cwd,
    env: run.env,
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  let reason: 'timeout' | 'cancelled' | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const terminate = (why: 'timeout' | 'cancelled'): void => {
    if (reason !== undefined) return
    reason = why
    killGroup('SIGTERM')
    killTimer = setTimeout(() => killGroup('SIGKILL'), run.killGraceMs)
  }
  const timer = setTimeout(() => terminate('timeout'), run.timeoutMs)
  const onAbort = (): void => terminate('cancelled')
  run.signal.addEventListener('abort', onAbort, { once: true })

  const out = new HeadTail(OUTPUT_HEAD, OUTPUT_TAIL)
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
  ): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const bytes of stream) {
      const chunk = decoder.decode(bytes, { stream: true })
      out.push(chunk)
      run.onProgress?.(chunk, name)
    }
  }
  const pumps = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])
  const exitCode = await proc.exited
  clearTimeout(timer)
  run.signal.removeEventListener('abort', onAbort)
  // a background child may hold the pipes open: wait a moment, then end the whole group
  const drained = await Promise.race([
    pumps.then(() => true),
    new Promise<boolean>((done) => setTimeout(() => done(false), DRAIN_MS)),
  ])
  clearTimeout(killTimer)
  if (!drained) killGroup('SIGKILL')

  if (reason === 'timeout') return failed('timeout', `timed out after ${run.timeoutMs} ms`)
  if (reason === 'cancelled') return failed('cancelled', 'cancelled')
  return { ok: true, output: out.text(), exitCode }
}
