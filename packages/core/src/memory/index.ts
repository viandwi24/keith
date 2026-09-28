// Public surface of memory/ for other core folders (R-3).

export { ActivityTracker, buildDigest, DIGEST_MAX_LINES } from './digest.ts'
export { createReflection, type Reflection, type ReflectionDeps } from './reflect/index.ts'
export { type ForgetResult, type MemoryServiceDeps, MemoryStore, RECALL_DEFAULT_LIMIT } from './service.ts'
export { createThreadSummaries, type ThreadSummaries, type ThreadSummariesDeps } from './summary/index.ts'
export type { MemoryJob, MemoryService, ReflectionResult, Reflector, ThreadSummarizer } from './types.ts'
export {
  admits,
  isVisible,
  loadVisibilityFacts,
  type PersonFacts,
  taskTarget,
  toStorageFilter,
  type VisibilityFacts,
  type VisibilityTarget,
  viewerPersonIds,
} from './visibility.ts'
