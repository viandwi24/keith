// The gates of a run that does not start (docs/specs/dreaming.md, Rule 6): the cadence check (`too-soon`) and the recorder of a skipped
// or refused start. No model call happens here.

import type { DreamTrigger } from '@keith/contracts'
import { checkedPersonId } from './files.ts'
import { ZERO_COUNTS } from './service-helpers.ts'
import { TOO_SOON_MS } from './service-text.ts'
import type { DreamRunContext, RunResult } from './service-types.ts'

/** The cadence gate: the latest non-skipped run started less than `TOO_SOON_MS` ago. */
export function isTooSoon(ctx: DreamRunContext, personId: string): boolean {
  const latest = ctx.repo.latestStarted(personId)
  return latest !== undefined && ctx.clock() - latest < TOO_SOON_MS
}

/**
 * A run that did not start. `too-soon` writes no run row: a row would move the cadence anchor of the 20-hour window.
 * `few-messages` writes a `skipped` row, which the anchor ignores.
 */
export async function skipRun(
  ctx: DreamRunContext,
  personId: string,
  trigger: DreamTrigger,
  reason: 'too-soon' | 'few-messages',
): Promise<RunResult> {
  checkedPersonId(personId)
  const mode = await ctx.modeOf(personId)
  const runId = reason === 'too-soon' ? null : ctx.repo.startRun({ personId, trigger, mode })
  if (runId !== null) ctx.repo.endRun(runId, { status: 'skipped', reason })
  const result: RunResult = {
    runId,
    status: reason === 'too-soon' ? 'refused' : 'skipped',
    reason,
    counts: ZERO_COUNTS,
    applied: false,
    staged: false,
  }
  ctx.record.announce(personId, result, trigger, mode, false)
  return result
}
