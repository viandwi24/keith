// The staged plan of a `propose` run (docs/specs/dreaming.md "Undo, staging and apply", ADR-0031 §4, §5). The plan is a JSON file
// outside the memory mount: `<dataDir>/dreams/<personId>/staged/<runId>.json`. It records the content hash of every memory file the
// plan was judged against (`base`), so `apply` can refuse a plan whose files changed since (`staged-changed`). Writes are atomic
// (a temporary file, fsync, rename), so a crash leaves the old plan or the new one, never half of one.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { type DreamPlan, DreamPlanSchema } from '@keith/contracts'
import { z } from 'zod'
import {
  checkedPersonId,
  checkedRunId,
  type MemoryTier,
  readMemoryBytes,
  stagedFileOf,
  tierOfPath,
  tierPath,
  writeFileAtomic,
} from './files.ts'
import type { DreamCandidate } from './types.ts'

/** A plan waiting for the person's `/dream apply`. */
export interface StagedPlan {
  readonly runId: string
  readonly personId: string
  /** When the plan was staged (ms since the epoch). */
  readonly stagedAt: number
  readonly plan: DreamPlan
  /** The candidates the plan refers to (the source pointers and the days the applier counts). Kept so `apply` needs no re-collect. */
  readonly candidates: readonly DreamCandidate[]
  /** The SHA-256 (hex) of each memory file the plan was judged against, keyed by its memory-relative path; null when absent. */
  readonly base: Readonly<Record<string, string | null>>
}

const HASH = /^[0-9a-f]{64}$/

const StagedPlanSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  personId: z.string().min(1).max(64),
  stagedAt: z.number().int().nonnegative(),
  plan: DreamPlanSchema,
  candidates: z.array(
    z.strictObject({
      id: z.string().min(1).max(40),
      text: z.string(),
      role: z.enum(['user', 'assistant']),
      sessionId: z.string().min(1),
      messageId: z.string().min(1),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  base: z.record(z.string(), z.string().regex(HASH).nullable()),
})

/** The SHA-256 (hex) of file bytes, or null for a file that does not exist. */
export function contentHash(bytes: Uint8Array | undefined): string | null {
  return bytes === undefined ? null : new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

/** The base of a plan: the hash of each given tier as it is now. */
export function memoryBaseOf(
  dataDir: string,
  personId: string,
  tiers: readonly MemoryTier[],
): Record<string, string | null> {
  return Object.fromEntries(
    tiers.map((tier) => [tierPath(tier), contentHash(readMemoryBytes(dataDir, personId, tier))]),
  )
}

/** The memory-relative paths whose content differs from the base of `staged` now (empty: the plan still applies). */
export function changedSince(dataDir: string, personId: string, staged: StagedPlan): string[] {
  return Object.entries(staged.base)
    .filter(([path, hash]) => {
      const tier = tierOfPath(path)
      if (tier === undefined) throw new Error(`staged plan holds a path no tier names: ${path}`)
      return contentHash(readMemoryBytes(dataDir, personId, tier)) !== hash
    })
    .map(([path]) => path)
}

/** Checks the shape of a plan and that its base holds only tier paths. Throws. */
function checked(staged: StagedPlan): StagedPlan {
  checkedPersonId(staged.personId)
  checkedRunId(staged.runId)
  StagedPlanSchema.parse(staged)
  for (const path of Object.keys(staged.base)) {
    if (tierOfPath(path) === undefined)
      throw new Error(`staged plan base holds a path no tier names: ${path}`)
  }
  return staged
}

/** Writes the staged plan of a run atomically, replacing an earlier file of the same run. Throws when the plan is not valid. */
export function writeStagedPlan(dataDir: string, staged: StagedPlan): void {
  const valid = checked(staged)
  writeFileAtomic(
    stagedFileOf(dataDir, valid.personId, valid.runId),
    `${JSON.stringify(valid, null, 2)}\n`,
  )
}

/**
 * Reads the staged plan of a run. Undefined when there is none. A file that is not a valid plan throws (the caller
 * reports the run as failed; the file is left in place for a look).
 */
export function readStagedPlan(
  dataDir: string,
  personId: string,
  runId: string,
): StagedPlan | undefined {
  const path = stagedFileOf(dataDir, personId, runId)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`staged plan of run ${runId} is not JSON: ${(error as Error).message}`)
  }
  const staged = checked(parsed as StagedPlan)
  if (staged.personId !== personId || staged.runId !== runId) {
    throw new Error(`staged plan of run ${runId} belongs to another run or person`)
  }
  return staged
}

/** Deletes the staged plan of a run (after it is applied or discarded). Missing is not an error. */
export function removeStagedPlan(dataDir: string, personId: string, runId: string): void {
  rmSync(stagedFileOf(dataDir, personId, runId), { force: true })
}
