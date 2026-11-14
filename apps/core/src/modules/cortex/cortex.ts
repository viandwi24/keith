import type { HarnessAgent, HarnessPlugin, HarnessSession } from 'eharness'
import { reconcileBackgroundChildren, subagent } from 'eharness/subagent'
import {
  createWorker,
  WORKER_DESCRIPTIONS,
  WORKER_KEYS,
  type WorkerDeps,
  type WorkerKey,
} from './workers.ts'

export type CortexOptions = Omit<WorkerDeps, 'self'>

/** Background delegations stay under this wall clock; the plugin stops a worker after it. */
export const BACKGROUND_TIMEOUT_MS = 3_600_000
/** Workers running at once for one lead (P3 decisions). */
export const MAX_CONCURRENT_WORKERS = 3

export interface Cortex {
  /** The worker of a catalog key. */
  worker(key: string): HarnessAgent | undefined
  /** The lead's side of delegation: the `agent` tool (park mode, background by default). */
  leadPlugin(self: () => HarnessAgent): HarnessPlugin
  /**
   * Deny every approval a worker session is parked on, with `reason` (ADR-0027 §11). The continuation
   * never calls the model (`endTurn`), so the worker's turn ends without another step. Resolves with
   * the number of approvals denied.
   */
  cancelPending(childId: string, agent: string | undefined, reason: string): Promise<number>
  /** Reconcile the background children of a lead session (boot and timer; idempotent). */
  // biome-ignore lint/suspicious/noExplicitAny: any session of the lead agent
  reconcile(parent: HarnessSession<any, any>): ReturnType<typeof reconcileBackgroundChildren>
  close(): Promise<void>
}

/** The Cortex: both workers and the lead plugin that delegates to them. */
export function createCortex(options: CortexOptions): Cortex {
  const workers = new Map<WorkerKey, HarnessAgent>()
  const deps: WorkerDeps = { ...options, self: (key) => workers.get(key) as HarnessAgent }
  for (const key of WORKER_KEYS) workers.set(key, createWorker(key, deps))
  const byKey = (key: string): HarnessAgent | undefined => workers.get(key as WorkerKey)
  return {
    worker: byKey,
    leadPlugin: (self) =>
      subagent({
        agents: Object.fromEntries(
          WORKER_KEYS.map((key) => [
            key,
            { agent: workers.get(key) as HarnessAgent, description: WORKER_DESCRIPTIONS[key] },
          ]),
        ),
        selfAgent: self,
        approvals: 'park',
        background: { default: true, timeoutMs: BACKGROUND_TIMEOUT_MS },
        maxDepth: 1,
        maxConcurrent: MAX_CONCURRENT_WORKERS,
        outputTool: true,
        stopTool: true,
        // send_message (two-way talk with a worker) is deferred: Draft in eharness
        messageTool: false,
      }) as never,
    cancelPending: async (childId, agent, reason) => {
      const worker = byKey(agent ?? '')
      if (worker === undefined) return 0
      const pending = await worker.peek(childId).pending()
      const open = (pending?.approvals ?? []).filter(
        (a) => a.answer === undefined && a.granted !== true,
      )
      if (open.length === 0) return 0
      const run = worker
        .session(childId)
        .respond(
          { approvals: open.map((a) => ({ id: a.approvalId, approved: false, reason })) },
          { endTurn: 'after-answers' },
        )
      await run.result
      return open.length
    },
    reconcile: (parent) =>
      reconcileBackgroundChildren(parent, {
        openChild: (childId, info) => {
          const worker = byKey(info.agent ?? '')
          if (worker === undefined) throw new Error(`no worker "${info.agent}" for ${childId}`)
          return worker.session(childId)
        },
        timeoutMs: BACKGROUND_TIMEOUT_MS,
        stopOnTimeout: true,
        log: { warn: (message) => options.logger.warn(`cortex: ${message}`) },
      }),
    async close() {
      await Promise.all([...workers.values()].map((w) => w.close()))
    },
  }
}
