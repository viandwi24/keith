// Public surface of memory/ for other core folders (R-3).

export { ActivityTracker, buildDigest, DIGEST_MAX_LINES } from './digest.ts'
export { type ForgetResult, type MemoryServiceDeps, MemoryStore, RECALL_DEFAULT_LIMIT } from './service.ts'
export type { MemoryService } from './types.ts'
export {
  admits,
  isVisible,
  loadVisibilityFacts,
  type PersonFacts,
  toStorageFilter,
  type VisibilityFacts,
  type VisibilityTarget,
  viewerPersonIds,
} from './visibility.ts'
