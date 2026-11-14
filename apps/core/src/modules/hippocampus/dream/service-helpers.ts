// Pure helpers of the dream service: the counts, the diary lines, the run view and the reason a run row holds. Only the memory
// tiers read the folder. The service (service.ts) calls them; they never call the service.

import { existsSync } from 'node:fs'
import {
  DREAM_FAILURE_REASONS,
  DREAM_REFUSAL_REASONS,
  DREAM_SKIP_REASONS,
  type DreamPlan,
  type DreamRunCounts,
  type DreamRunReason,
  type DreamRunView,
} from '@keith/contracts'
import type { DreamRunRecord } from '@keith/db'
import { memoryDir } from '../hippocampus.ts'
import type { ApplyResult } from './apply.ts'
import type { DiaryEntry } from './diary.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER, tierOfPath } from './files.ts'

export const ZERO_COUNTS: DreamRunCounts = {
  candidates: 0,
  promoted: 0,
  merged: 0,
  superseded: 0,
  dropped: 0,
}

const REASONS: ReadonlySet<string> = new Set([
  ...DREAM_REFUSAL_REASONS,
  ...DREAM_FAILURE_REASONS,
  ...DREAM_SKIP_REASONS,
])

/**
 * A run `dream.undo` may restore: an applied run, or a run that stopped while writing (`apply-partial`), when its undo window is set
 * (`undo_until` is null for a run that wrote nothing). The window and the preimages are checked by `decideUndo`.
 */
export function undoableOf(row: Pick<DreamRunRecord, 'status' | 'reason' | 'undoUntil'>): boolean {
  if (row.undoUntil === null) return false
  return row.status === 'applied' || (row.status === 'failed' && row.reason === 'apply-partial')
}

/** The reason a run row holds, as the view reads it (a known reason or null). */
function reasonOf(value: string | null): DreamRunReason | null {
  return value !== null && REASONS.has(value) ? (value as DreamRunReason) : null
}

/** The memory files a judge can read and the applier can write: the three fixed tiers and every topic file that exists now. */
export function memoryTiersOf(dataDir: string, personId: string) {
  const folder = memoryDir(dataDir, personId)
  const topics = existsSync(folder)
    ? Array.from(new Bun.Glob('*.md').scanSync({ cwd: folder, onlyFiles: true })).flatMap(
        (name) => {
          const tier = tierOfPath(name)
          return tier?.kind === 'topic' ? [tier] : []
        },
      )
    : []
  return [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER, ...topics]
}

/** The counts of a finished apply: every judged candidate is either written or dropped (an unnamed one is dropped as `absent`). */
export function countsOf(result: ApplyResult): DreamRunCounts {
  return {
    candidates: result.counts.candidates,
    promoted: result.counts.promoted,
    merged: result.counts.merged,
    superseded: result.counts.superseded,
    dropped: result.counts.dropped,
  }
}

/** The diary lines of an apply (or of a `propose` dry run): one per written unit, staged unit and drop, plus the expiry sweep. */
export function diaryEntriesOf(
  plan: DreamPlan,
  result: ApplyResult,
  proposed: boolean,
): DiaryEntry[] {
  const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]))
  const entries: DiaryEntry[] = []
  for (const item of result.written) {
    if (item.id === null) {
      entries.push({
        action: 'expired',
        target: 'archive.md',
        text: `${result.counts.expired} entries`,
        reason: 'expired',
      })
      continue
    }
    const candidate = byId.get(item.id)
    entries.push({
      action: proposed ? `proposed ${item.effect}` : item.effect,
      target: item.paths[0],
      text: candidate?.text,
      reason: candidate?.reason,
    })
  }
  for (const item of result.staged) {
    entries.push({ action: 'staged', text: byId.get(item.id)?.text, reason: item.reason })
  }
  for (const item of result.dropped) {
    entries.push({ action: 'dropped', text: byId.get(item.id)?.text, reason: item.reason })
  }
  return entries
}

/** A run row as the person reads it: its state, counts and whether a staged plan waits. Never the text. */
export function viewOf(row: DreamRunRecord, staged: boolean): DreamRunView {
  return {
    id: row.id,
    trigger: row.trigger,
    mode: row.mode,
    status: row.status,
    reason: reasonOf(row.reason),
    startedAt: row.startedAt,
    finishedAt: row.endedAt,
    counts: row.counts,
    applied: row.status === 'applied',
    staged,
  }
}

/**
 * The base of a staged plan written after a run's own writes. A file the run wrote is hashed as it is now, so the run's own write is
 * not a change to `apply`. Every other file keeps the base the plan was judged against (null when it was absent), so a change made
 * during the judge turn stays a change and `apply` refuses the plan.
 */
export function heldBaseOf(input: {
  readonly judged: Readonly<Record<string, string | null>>
  readonly now: Readonly<Record<string, string | null>>
  /** The memory-relative paths the run wrote. */
  readonly written: readonly string[]
}): Record<string, string | null> {
  const paths = new Set([...Object.keys(input.judged), ...Object.keys(input.now)])
  return Object.fromEntries(
    [...paths].map((path) => [
      path,
      input.written.includes(path) ? (input.now[path] ?? null) : (input.judged[path] ?? null),
    ]),
  )
}
