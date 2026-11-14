// Cortex: the worker agents the front agent delegates to (docs/specs/cortex.md).

export { resolveWorkspacePath, type WorkspaceCaller } from '../../platform/workspace-resolve.ts'
export { type Cortex, type CortexOptions, createCortex } from './cortex.ts'
export { createSearch, SEARCH_MODEL, searchModel } from './web-search.ts'
export {
  createWorker,
  WORKER_BUDGET,
  WORKER_DESCRIPTIONS,
  WORKER_KEYS,
  WORKER_STEPS,
  type WorkerDeps,
  type WorkerHardening,
  type WorkerKey,
  workspaceDir,
} from './workers.ts'
export {
  migrateLegacyWorkspace,
  personWorkspaceDir,
  workspaceOf,
} from './workspace.ts'
