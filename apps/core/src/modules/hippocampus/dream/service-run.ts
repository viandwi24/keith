// One run of a person's memory (docs/specs/dreaming.md, Rule 3 and "Service"): collect, judge, then the applier (`auto`) or a staged
// plan (`propose`), the diary, the cursor, the run row, the audit row and the brain events. The model never writes or applies
// (ADR-0031 §7): the judge returns a plan and this function decides what happens to it.

import type { DreamFailureReason, DreamRefusalReason, DreamTrigger } from '@keith/contracts'
import { ApplyPartialError } from './apply.ts'
import { collectCandidates, dayOf } from './collect.ts'
import { appendDiary } from './diary.ts'
import { repeatsFailedBatch, skippedBatchNote } from './failed-batch.ts'
import { checkedPersonId } from './files.ts'
import { sendStagedNotice } from './notify.ts'
import { countsOf, diaryEntriesOf, heldBaseOf, ZERO_COUNTS } from './service-helpers.ts'
import { endWithout } from './service-record.ts'
import {
  autoNoticeText,
  budgetLowAt,
  DREAM_FAILED_TEXT,
  dreamBudgetTextOf,
} from './service-text.ts'
import type { DreamRunContext, RunResult } from './service-types.ts'
import { writeStagedPlan } from './staged.ts'
import type { DreamCandidate } from './types.ts'
import { preimagesOf, undoUntilFrom } from './undo.ts'

/** The status and the coarse reason of a judge failure: a refusal (`no-model`, `budget`) or a failure (`judge`, `turn-error`). */
function judgeFailure(reason: string): {
  status: 'refused' | 'failed'
  reason: DreamRefusalReason | DreamFailureReason
} {
  if (reason === 'no-model') return { status: 'refused', reason: 'no-model' }
  if (reason === 'budget') return { status: 'refused', reason: 'budget' }
  if (reason === 'judge-output') return { status: 'failed', reason: 'judge' }
  return { status: 'failed', reason: 'turn-error' }
}

/** Runs one pass for the person. `off` is refused with an audit row and no run row. */
export async function runDream(
  ctx: DreamRunContext,
  personId: string,
  trigger: DreamTrigger,
): Promise<RunResult> {
  const { deps, repo, clock, warn, applier, modeOf, baseOf, record } = ctx
  const { announce, phaseEvent, tellOnce } = record
  checkedPersonId(personId)
  const mode = await modeOf(personId)
  if (mode === 'off') {
    const off: RunResult = {
      runId: null,
      status: 'refused',
      reason: 'off',
      counts: ZERO_COUNTS,
      applied: false,
      staged: false,
    }
    announce(personId, off, trigger, mode, false)
    return off
  }
  const runId = repo.startRun({ personId, trigger, mode })
  const today = dayOf(clock())
  let result: RunResult
  try {
    const collected = collectCandidates(deps.sqlite, {
      personId,
      generations: deps.generations,
      cursor: repo.cursorOf(personId) ?? {},
    })
    // the start follows the collect, so it carries the count the run reviews (the candidates the judge reads)
    phaseEvent(
      personId,
      runId,
      trigger,
      'start',
      { ...ZERO_COUNTS, candidates: collected.candidates.length },
      false,
    )
    if (collected.candidates.length === 0) {
      repo.endRun(runId, { status: 'skipped' })
      result = endWithout(runId, 'skipped', null)
      announce(personId, result, trigger, mode, true)
      return result
    }
    const candidates: readonly DreamCandidate[] = collected.candidates
    // the cursor this run collected from: a failed run resumes from it (it moves only when a batch is skipped, below)
    const resume = repo.cursorOf(personId) ?? {}
    // The base is read before the judge, so a file changed during the judge turn is seen as changed at apply.
    const base = baseOf(personId)
    const maxUsdPerRun = deps.settings().maxUsdPerRun
    // the judge turn reserves maxUsdPerRun up front; a run that would leave less than that plus a margin is skipped, so it
    // never takes the budget a chat turn needs (docs/specs/dreaming.md, "Budget")
    const remaining = deps.budgetRemaining?.(personId) ?? null
    if (remaining !== null && remaining < budgetLowAt(maxUsdPerRun)) {
      repo.endRun(runId, { status: 'skipped', reason: 'budget-low' })
      result = endWithout(runId, 'skipped', 'budget-low')
      appendDiary(deps.dataDir, personId, today, runId, [
        { action: 'note', reason: 'skipped: the remaining budget is low' },
      ])
      announce(personId, result, trigger, mode, true)
      return result
    }
    const judged = await deps.judge(
      personId,
      candidates.map((c) => ({ id: c.id, text: c.text, day: c.day, messageId: c.messageId })),
      maxUsdPerRun,
    )
    if (!judged.ok) {
      const failure = judgeFailure(judged.reason)
      // A failed judgement (not a refusal) is retried once (failed-batch.ts). A second failure of the same batch advances the
      // cursor past it and records the skip in the diary; nothing is written in either case.
      const batch = candidates.map((c) => c.messageId)
      const repeated =
        failure.status === 'failed' && repeatsFailedBatch(repo.failedBatchOf(personId), batch)
      if (repeated) {
        // `[]` marks the row as one that holds a resume point with no batch left to retry
        repo.endRun(runId, {
          status: 'failed',
          reason: failure.reason,
          cursor: collected.nextCursor,
          failedBatch: [],
        })
        appendDiary(deps.dataDir, personId, today, runId, [
          { action: 'note', reason: skippedBatchNote(candidates.length) },
        ])
      } else if (failure.status === 'failed') {
        repo.endRun(runId, {
          status: 'failed',
          reason: failure.reason,
          cursor: resume,
          failedBatch: batch,
        })
      } else {
        repo.endRun(runId, { status: failure.status, reason: failure.reason })
      }
      // the cause is a closed word (judge.ts JUDGE_CAUSES): the diary and the log hold it, the run row does not
      warn(`dreaming: run ${runId} ${failure.status}: ${failure.reason} (${judged.cause})`)
      if (failure.status === 'failed')
        appendDiary(deps.dataDir, personId, today, runId, [
          { action: 'note', reason: `run failed: ${failure.reason} (${judged.cause})` },
        ])
      // a run that stops on the cap, or fails, tells the person once
      if (failure.reason === 'budget')
        await tellOnce(personId, runId, 'budget', dreamBudgetTextOf(maxUsdPerRun))
      else if (failure.status === 'failed')
        await tellOnce(personId, runId, 'failed', DREAM_FAILED_TEXT)
      result = endWithout(runId, failure.status, failure.reason)
      announce(personId, result, trigger, mode, true)
      return result
    }
    const plan = judged.plan
    if (mode === 'propose') {
      const dry = applier({
        dataDir: deps.dataDir,
        personId,
        runId,
        today,
        plan,
        candidates,
        base,
        dryRun: true,
      })
      writeStagedPlan(deps.dataDir, {
        runId,
        personId,
        stagedAt: clock(),
        plan,
        candidates,
        base,
      })
      appendDiary(deps.dataDir, personId, today, runId, diaryEntriesOf(plan, dry, true))
      const counts = countsOf(dry)
      repo.endRun(runId, { status: 'staged', counts, cursor: collected.nextCursor })
      // one notice for the staged run, after its row is final (ADR-0031 §5); the delivery id keeps a repeat quiet
      await sendStagedNotice(deps.deliver, { personId, day: today, runId, plan, counts }, warn)
      result = { runId, status: 'staged', reason: null, counts, applied: false, staged: true }
    } else {
      const written = applier({
        dataDir: deps.dataDir,
        personId,
        runId,
        today,
        plan,
        candidates,
        base,
      })
      if (written.staged.length > 0) {
        // units held back by a global rule wait for the person: a staged plan of those units. Its base is read after the writes,
        // so the run's own writes are not changes to it; a file the run did not write keeps the pre-judge base (heldBaseOf)
        const held = new Set(written.staged.map((s) => s.id))
        writeStagedPlan(deps.dataDir, {
          runId,
          personId,
          stagedAt: clock(),
          plan: { candidates: plan.candidates.filter((c) => held.has(c.id)) },
          candidates: candidates.filter((c) => held.has(c.id)),
          base: heldBaseOf({
            judged: base,
            now: baseOf(personId),
            written: written.written.flatMap((w) => w.paths),
          }),
        })
      }
      const undoUntil =
        preimagesOf(deps.dataDir, personId, runId).length > 0 ? undoUntilFrom(clock()) : null
      appendDiary(deps.dataDir, personId, today, runId, diaryEntriesOf(plan, written, false))
      const counts = countsOf(written)
      repo.endRun(runId, { status: 'applied', counts, cursor: collected.nextCursor, undoUntil })
      // the person is told once when the run wrote or held anything (no entry text, counts only)
      const appliedCount = written.written.filter((item) => item.id !== null).length
      if (appliedCount > 0 || written.staged.length > 0)
        await tellOnce(personId, runId, 'auto', autoNoticeText(appliedCount, written.staged.length))
      result = {
        runId,
        status: 'applied',
        reason: null,
        counts,
        applied: written.written.length > 0,
        staged: written.staged.length > 0,
      }
    }
  } catch (error) {
    // An unexpected failure ends the run as failed: the cursor stays, so the next run collects the same messages.
    const message = error instanceof Error ? error.message : String(error)
    warn(`dreaming: run ${runId} failed: ${message}`)
    // A write that stopped after another file changed keeps the undo window open, so `dream.undo` puts those files back.
    const partial = error instanceof ApplyPartialError
    repo.endRun(
      runId,
      partial
        ? { status: 'failed', reason: 'apply-partial', undoUntil: undoUntilFrom(clock()) }
        : { status: 'failed' },
    )
    await tellOnce(personId, runId, 'failed', DREAM_FAILED_TEXT)
    result = endWithout(runId, 'failed', partial ? 'apply-partial' : null)
  }
  announce(personId, result, trigger, mode, true)
  return result
}
