// The activity-log capture of the core (ADR-0032 §1, docs/specs/activity-logs.md "Capture"): one queue and one settings reader,
// built once here. Every agent gets the same `activity-logs` plugin; the queue writes batches through the repo and is flushed
// when the core stops (compose.ts `close`).
import { type ActivityLogsRepo, activityLogsRepo, type SettingsRepo, type Sqlite } from '@keith/db'
import type { LanguageModel } from 'ai'
import type { HarnessPlugin } from 'eharness'
import {
  type ActivityLogSettings,
  activityLogs,
  type CaptureRecord,
  createActivityLogSettings,
  createLogQueue,
  type LogQueue,
  observeAux,
} from './modules/audit/activity-logs/index.ts'
import type { Logger } from './platform/logger.ts'

export interface ActivityCapture {
  /** The `activity-logs` plugin: added to every agent the core builds (front, room, worker, guest). */
  plugin: HarnessPlugin
  /** The owner's log settings, read at each call and each prune. */
  settings: ActivityLogSettings
  /** The store of the calls: the `logs` RPC reads it. */
  repo: ActivityLogsRepo
  /** The queue: what waits for the writer and what overflow dropped (`logs.status`). */
  queue: Pick<LogQueue<CaptureRecord>, 'size' | 'dropped'>
  /** Wraps a model that a call outside a turn makes: its calls are stored under `aux:<name>:<personId>` (ADR-0032 §1). */
  observeAux(name: string, personId: string, model: LanguageModel): LanguageModel
  /** Writes what is queued now. Never rejects. */
  flush(): Promise<void>
  /** Flushes, then refuses later events. Called once, when the core stops. */
  stop(): Promise<void>
}

export function createActivityCapture(options: {
  sqlite: Sqlite
  settings: SettingsRepo
  logger: Logger
}): ActivityCapture {
  const repo = activityLogsRepo(options.sqlite)
  const settings = createActivityLogSettings(options.settings)
  const queue: LogQueue<CaptureRecord> = createLogQueue<CaptureRecord>({
    sink: (batch) => {
      repo.insertCalls(batch)
    },
    onError: (error, size) =>
      options.logger.warn(
        `activity logs: ${size} calls not stored: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  return {
    plugin: activityLogs({ queue, settings }),
    settings,
    repo,
    queue,
    observeAux: (name, personId, model) => observeAux(name, personId, model, { queue, settings }),
    flush: () => queue.flush(),
    stop: () => queue.stop(),
  }
}
