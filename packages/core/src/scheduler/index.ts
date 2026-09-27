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
import { createReminderService } from './reminders.ts'
import { createTaskService, type TaskManager } from './tasks.ts'
import type { DeliveryQueue, ReminderService } from './types.ts'

export type { CommitmentManager } from './commitments.ts'
export { MAIN_THREAD_SLUG } from './deliveries.ts'
export type { LaneScheduler } from './lanes.ts'
export { createReminderService, type ReminderServiceDeps } from './reminders.ts'
export { TASK_SUMMARY_MAX_CHARS, type TaskManager } from './tasks.ts'

export type SchedulingDeps = {
  config: Pick<KeithConfig, 'scheduler' | 'mind'>
  repos: Pick<
    Repositories,
    'tasks' | 'commitments' | 'deliveries' | 'threads' | 'persons' | 'relationships' | 'reminders'
  >
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
  /** Phase 4: handed to `registerBuiltins` for the `reminder.*` tools (bootstrap step 10). */
  reminders: ReminderService
  /** Handed to the plugin host as `deliveries` (bootstrap step 11). */
  deliverySinks: PluginScoped<DeliverySink>
  /**
   * Recovers tasks left over from the last run, subscribes commitment expiry and due reminders
   * (`reminders.fireDue`) to ticks, starts the tick timer.
   */
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
  const reminders = createReminderService({ config, repos, deliveries, ids, clock, log })
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
    reminders,
    deliverySinks,
    async start() {
      await tasks.recover()
      unsubscribe ??= events.on('scheduler.ticked', async ({ data }) => {
        // A failing expiry must not hold back due reminders (the bus logs whatever throws).
        try {
          await commitments.expireDue()
        } finally {
          await reminders.fireDue(data.at)
        }
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
