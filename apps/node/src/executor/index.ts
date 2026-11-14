// The node's executor: every invoke from core ends in exactly one `result`. The built-in drivers `system` and `shell`
// and the installed drivers are called through the same route table (docs/specs/node.md, Executor;
// docs/specs/node-drivers.md, Announcement and executor).
import {
  driverOf,
  type Invoke,
  PROTOCOL_VERSION,
  type Progress,
  type ToolResult,
} from '@keith/contracts'
import type {
  CapabilityCall,
  CapabilityResult,
  DriverContext,
  DriverDefinition,
  DriverLogger,
} from '@keith/driver-sdk'
import type { RunnableDriver } from '../drivers.ts'
import { createProgressCap } from './progress-cap.ts'
import { KILL_GRACE_MS, shellDriver } from './shell.ts'
import { systemDriver } from './system-info.ts'

export interface NodePolicy {
  allowShell: boolean
  workdir: string
}

export interface Executor {
  /** Run one invoke to its final result; progress goes through `emit`. Never rejects. */
  invoke(message: Invoke): Promise<ToolResult>
  /** Stop a running call; its `invoke` promise then resolves with `cancelled`. */
  cancel(callId: string): void
  /** Kill every running call (socket dropped). */
  killAll(): void
  readonly running: number
}

export interface ExecutorOptions {
  policy: NodePolicy
  /** The installed drivers that loaded and started (`prepareDrivers`); the built-ins are always added. */
  drivers?: readonly RunnableDriver[]
  /** Installed drivers that did not load, with the reason: a call to one of their capabilities is `driver-unavailable`. */
  unavailable?: readonly { readonly name: string; readonly message: string }[]
  emit(message: Progress): void
  killGraceMs?: number
}

/** Extra wait after an abort before a driver that ignores its signal is given up on. */
const DRIVER_GRACE_MS = 1_000

const quietLogger: DriverLogger = { info() {}, warn() {}, error() {} }

interface Route {
  readonly name: string
  readonly driver: DriverDefinition
  readonly options: Readonly<Record<string, unknown>>
  readonly logger: DriverLogger
  readonly schemaVersion: number
}

type ErrorCode = Extract<ToolResult, { ok: false }>['error']['code']

function failure(callId: string, code: ErrorCode, message: string): ToolResult {
  return { v: PROTOCOL_VERSION, type: 'result', callId, ok: false, error: { code, message } }
}

function isCapabilityResult(value: unknown): value is CapabilityResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

/**
 * Calls the driver and waits for its answer, or for the grace period after the call's signal aborted (a driver that
 * ignores its signal must not hold the node). Errors from `invoke` reject.
 */
async function runDriver(
  route: Route,
  call: CapabilityCall,
  ctx: DriverContext,
  signal: AbortSignal,
  graceMs: number,
): Promise<CapabilityResult> {
  let grace: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<CapabilityResult>((resolve) => {
    onAbort = () => {
      grace = setTimeout(() => {
        const timedOut = signal.reason === 'timeout'
        resolve({
          ok: false,
          code: timedOut ? 'timeout' : 'cancelled',
          message: timedOut ? `timed out after ${call.timeoutMs} ms` : 'cancelled',
        })
      }, graceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => route.driver.invoke(call, ctx)),
      stopped,
    ])
  } finally {
    clearTimeout(grace)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export function createExecutor(options: ExecutorOptions): Executor {
  const active = new Map<string, AbortController>()
  const { policy } = options
  const graceMs = (options.killGraceMs ?? KILL_GRACE_MS) + DRIVER_GRACE_MS

  const routes = new Map<string, Route>()
  const loaded: RunnableDriver[] = [
    { driver: systemDriver, options: {}, logger: quietLogger },
    { driver: shellDriver(policy, options.killGraceMs), options: {}, logger: quietLogger },
    ...(options.drivers ?? []),
  ]
  for (const item of loaded) {
    for (const capability of item.driver.capabilities) {
      routes.set(capability.id, {
        name: item.driver.name,
        driver: item.driver,
        options: item.options,
        logger: item.logger,
        schemaVersion: capability.schemaVersion,
      })
    }
  }

  async function dispatch(message: Invoke, controller: AbortController): Promise<ToolResult> {
    const { callId, capability } = message
    const route = routes.get(capability)
    if (route === undefined) {
      const owner = options.unavailable?.find((u) => u.name === driverOf(capability))
      if (owner !== undefined) {
        return failure(
          callId,
          'driver-unavailable',
          `driver ${owner.name} is not loaded on this node (${owner.message}): run keith-node driver list`,
        )
      }
      return failure(callId, 'unknown-capability', `unknown capability ${capability}`)
    }
    if (
      message.capabilityVersion !== undefined &&
      message.capabilityVersion !== route.schemaVersion
    ) {
      return failure(
        callId,
        'unsupported-version',
        `${capability} schema ${message.capabilityVersion} is not supported (this node runs schema ${route.schemaVersion})`,
      )
    }

    // progress of this call is capped (progress-cap.ts): the driver is never blocked, the excess is dropped with one marker
    const progress = createProgressCap({
      send: (chunk, stream) =>
        options.emit({ v: PROTOCOL_VERSION, type: 'progress', callId, chunk, stream }),
    })
    const ctx: DriverContext = {
      logger: route.logger,
      workdir: policy.workdir,
      options: route.options,
      signal: controller.signal,
      progress: (chunk, stream = 'stdout') => progress.push(chunk, stream),
    }
    const call: CapabilityCall = {
      callId,
      capability,
      schemaVersion: route.schemaVersion,
      input: message.input,
      timeoutMs: message.timeoutMs,
    }

    let answer: unknown
    try {
      answer = await runDriver(route, call, ctx, controller.signal, graceMs)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      route.logger.error(`${capability} (${callId}) crashed: ${why}`)
      return failure(callId, 'failed', `driver ${route.name} crashed: ${why}`)
    }
    if (!isCapabilityResult(answer)) {
      return failure(callId, 'failed', `driver ${route.name} returned no result`)
    }
    if (answer.ok) {
      return {
        v: PROTOCOL_VERSION,
        type: 'result',
        callId,
        ok: true,
        output: answer.output,
        ...(answer.exitCode === undefined ? {} : { exitCode: answer.exitCode }),
      }
    }
    // the node's own stop wins over the driver's word: a call stopped by its clock is `timeout`, by core `cancelled`
    if (controller.signal.aborted) {
      const code: ErrorCode = controller.signal.reason === 'timeout' ? 'timeout' : 'cancelled'
      return failure(callId, code, answer.message)
    }
    return failure(callId, answer.code, answer.message)
  }

  return {
    async invoke(message) {
      const controller = new AbortController()
      active.set(message.callId, controller)
      // the call's clock: the signal's reason tells the driver (and the shell) why it stopped
      const clock = setTimeout(() => controller.abort('timeout'), message.timeoutMs)
      try {
        return await dispatch(message, controller)
      } catch (error) {
        return failure(message.callId, 'failed', (error as Error).message)
      } finally {
        clearTimeout(clock)
        active.delete(message.callId)
      }
    },
    cancel(callId) {
      active.get(callId)?.abort('cancelled')
    },
    killAll() {
      for (const controller of active.values()) controller.abort('cancelled')
    },
    get running() {
      return active.size
    },
  }
}
