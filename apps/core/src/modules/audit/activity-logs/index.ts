// The activity logs module (docs/specs/activity-logs.md). Exports grow with the steps of P36; this file is the only import path.

export { activityLogs, type CaptureRecord } from './capture.ts'
export { type AuxObserveDeps, auxSessionId, observeAux } from './observe.ts'
export { createLogQueue, type LogQueue, type LogQueueOptions } from './queue.ts'
export {
  type ActivityLogSettings,
  createActivityLogSettings,
  logsKey,
} from './settings.ts'
