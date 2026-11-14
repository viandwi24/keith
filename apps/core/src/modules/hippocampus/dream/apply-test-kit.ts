// Shared helpers of the applier tests (apply.test.ts, apply-approved.test.ts): the candidates, the plan builder and an apply
// against the memory as it is now. Plain functions over a data folder; each test file owns its temp folder.
import type { DreamAction, DreamPlan } from '@keith/contracts'
import { type ApplyResult, applyPlan } from './apply.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER, readMemoryFile, topicTier } from './files.ts'
import { memoryBaseOf } from './staged.ts'
import type { DreamCandidate } from './types.ts'
import type { RunWriter } from './undo.ts'

export const PERSON = 'ana'
export const RUN = 'run-1'
export const TODAY = '2026-11-11'

export const cand = (
  id: string,
  text: string,
  role: 'user' | 'assistant' = 'user',
  day = TODAY,
): DreamCandidate => ({
  id,
  text,
  role,
  sessionId: 'front:s1',
  messageId: `m-${id}`,
  day,
})

export interface Item {
  id: string
  action: DreamAction
  target: string
  text: string
  importance?: number
  supersedes?: string
  sourceMessageId?: string
}

/** A plan of judge decisions. The reason is fixed; the source pointer defaults to the candidate's message. */
export const plan = (...items: Item[]): DreamPlan => ({
  candidates: items.map((item) => ({
    id: item.id,
    action: item.action,
    target: item.target,
    text: item.text,
    reason: 'because',
    importance: item.importance ?? 3,
    sourceMessageId: item.sourceMessageId ?? `m-${item.id}`,
    ...(item.supersedes === undefined ? {} : { supersedes: item.supersedes }),
  })),
})

/** Applies a plan in `dataDir` against the memory as it is now (the base is what the judge would have read). */
export function applyIn(
  dataDir: string,
  p: DreamPlan,
  candidates: DreamCandidate[],
  options: { dryRun?: boolean; writer?: RunWriter; approved?: boolean } = {},
): ApplyResult {
  const topics = [...new Set(p.candidates.map((c) => c.target))].filter(
    (t) =>
      t !== 'profile' && t !== 'recent' && !['profile.md', 'recent.md', 'archive.md'].includes(t),
  )
  const base = memoryBaseOf(dataDir, PERSON, [
    PROFILE_TIER,
    RECENT_TIER,
    ARCHIVE_TIER,
    ...topics.map(topicTier),
  ])
  return applyPlan({
    dataDir,
    personId: PERSON,
    runId: RUN,
    today: TODAY,
    plan: p,
    candidates,
    base,
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.writer === undefined ? {} : { writer: options.writer }),
    ...(options.approved === true ? { approved: true } : {}),
  })
}

/** The memory files of `PERSON` in `dataDir`. */
export const filesOf = (dataDir: string) => ({
  recent: () => readMemoryFile(dataDir, PERSON, RECENT_TIER),
  profile: () => readMemoryFile(dataDir, PERSON, PROFILE_TIER),
  archive: () => readMemoryFile(dataDir, PERSON, ARCHIVE_TIER),
  topic: (name: string) => readMemoryFile(dataDir, PERSON, topicTier(name)),
})
