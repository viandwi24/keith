// Scheduler folder entry: builds lanes, tasks, commitments, deliveries and the plugin delivery sink
// (bootstrap step 6). See docs/architecture/core.md#scheduler.

import type { DeliverySink } from '@keith/sdk'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { RunLoop } from '../mind/types.ts'
import type { CoreAgentRegistry, PluginScoped } from '../plugins/types.ts'
import type { Clock, Ids, Logger } from '../shared/types.ts'
import type { Repositories } from '../storage/types.ts'
import { type CommitmentManager, createCommitmentService } from './commitments.ts'
import { createDeliveryQueue, createDeliverySinks } from './deliveries.ts'
import { createLaneScheduler, type LaneScheduler } from './lanes.ts'
import { createTaskService, type TaskManager } from './tasks.ts'
import type { DeliveryQueue } from './types.ts'

export type { CommitmentManager } from './commitments.ts'
export { MAIN_THREAD_SLUG } from './deliveries.ts'
export type { LaneScheduler } from './lanes.ts'
export { TASK_SUMMARY_MAX_CHARS, type TaskManager } from './tasks.ts'

export type SchedulingDeps = {
  config: Pick<KeithConfig, 'scheduler' | 'mind'>
  repos: Pick<Repositories, 'tasks' | 'commitments' | 'deliveries' | 'threads' | 'persons' | 'relationships'>
  runLoop: RunLoop
  agents: Pick<CoreAgentRegistry, 'get'>
  events: CoreEventBus
  ids: Ids
  clock: Clock
  log: Logger
}

export type Scheduling = {
  scheduler: LaneScheduler
  tasks: TaskManager
  commitments: CommitmentManager
  deliveries: DeliveryQueue
  /** Handed to the plugin host as `deliveries` (bootstrap step 11). */
  deliverySinks: PluginScoped<DeliverySink>
  /** Recovers tasks left over from the last run, subscribes commitment expiry to ticks, starts the tick timer. */
  start(): Promise<void>
  /** Stops the tick timer and aborts in-flight tasks, leaving them for the next boot's recovery. */
  stop(): Promise<void>
}

export function createScheduling(deps: SchedulingDeps): Scheduling {
  const { config, repos, runLoop, agents, events, ids, clock } = deps
  const log = deps.log.child({ area: 'scheduler' })
  const scheduler = createLaneScheduler({ config, clock, events, log })
  const commitments = createCommitmentService({ config, repos, events, ids, clock, log })
  const deliveries = createDeliveryQueue({ repos, events, ids, clock })
  const deliverySinks = createDeliverySinks({ queue: deliveries, repos })
  const tasks = createTaskService({
    config,
    repos,
    scheduler,
    runLoop,
    agents,
    commitments,
    deliveries,
    events,
    ids,
    clock,
    log,
  })
  let unsubscribe: (() => void) | null = null

  return {
    scheduler,
    tasks,
    commitments,
    deliveries,
    deliverySinks,
    async start() {
      await tasks.recover()
      unsubscribe ??= events.on('scheduler.ticked', async () => {
        await commitments.expireDue()
      })
      scheduler.startTicking()
    },
    async stop() {
      scheduler.stopTicking()
      unsubscribe?.()
      unsubscribe = null
      await tasks.shutdown()
    },
  }
}
