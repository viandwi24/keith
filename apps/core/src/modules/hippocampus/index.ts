// Hippocampus: per-person long-term memory (docs/specs/hippocampus.md).

// The dream run (P35): the service the dreaming step drives, and the pieces its tests check.
export { applyPlan } from './dream/apply.ts'
export { RECENT_TIER, readMemoryFile } from './dream/files.ts'
export type { JudgeResult } from './dream/judge.ts'
export type { JudgeCandidate } from './dream/prompt.ts'
export { createDreamService, TOO_SOON_MS } from './dream/service.ts'
export {
  HIPPOCAMPUS_PROTOCOL,
  HIPPOCAMPUS_READONLY_PROTOCOL,
  type HippocampusOptions,
  hippocampus,
  MEMORY_ROOT,
  memoryBase,
  memoryDir,
  memoryRootOf,
  profilePathOf,
} from './hippocampus.ts'
export { looksLikeSecret, SECRET_REFUSAL } from './secret-guard.ts'
