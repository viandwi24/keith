// Thread summaries (phase 4, ADR-0014): rows that leave the recent-messages window are folded into
// `threads.summary`. See docs/architecture/memory.md#thread-summary.

import type { KeithConfig } from '../../config/types.ts'
import type { CoreEventBus } from '../../events/types.ts'
import type { RunLoop } from '../../mind/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Clock, Ids, Logger } from '../../shared/types.ts'
import type { Repositories } from '../../storage/types.ts'
import type { MemoryJob, ThreadSummarizer } from '../types.ts'
import { createSummaryJob } from './job.ts'
import { createSummarizer } from './summarizer.ts'

export type ThreadSummariesDeps = {
  /** `memory.summary` drives the job; `mind.context.recentMessages` is the window it summarizes behind. */
  config: Pick<KeithConfig, 'memory' | 'mind'>
  /** `persons` names the speakers in the transcript the model reads. */
  repos: Pick<Repositories, 'threads' | 'messages' | 'persons'>
  /** Utility-model calls: `modelRole: 'utility'`, no tools, one step, `persist: null`. */
  runLoop: RunLoop
  /** Updates run in the `background` lane. */
  scheduler: Pick<Scheduler, 'run'>
  /** The job subscribes to `turn.completed`; the summarizer emits `thread.summarized`. */
  events: CoreEventBus
  clock: Clock
  ids: Ids
  log: Logger
}

export type ThreadSummaries = { summarizer: ThreadSummarizer; job: MemoryJob }

/** Builds the summarizer and its `turn.completed`-driven job. Bootstrap starts the job (P4-I1). */
export function createThreadSummaries(deps: ThreadSummariesDeps): ThreadSummaries {
  const summarizer = createSummarizer(deps)
  const job = createSummaryJob({
    config: deps.config,
    summarizer,
    scheduler: deps.scheduler,
    events: deps.events,
    log: deps.log,
  })
  return { summarizer, job }
}
