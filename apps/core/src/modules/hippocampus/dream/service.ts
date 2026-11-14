// The dreaming service (docs/specs/dreaming.md "Service", ADR-0031 §5, §8): the wiring of one service, the person's apply and undo,
// the mode and the status. The run is in service-run.ts, the skip and the cadence gate in service-skip.ts, the audit rows, events and
// notices in service-record.ts, the types in service-types.ts. Audit rows and events carry counts and ids only.
import {
  DREAM_APPLY,
  DREAM_MODE,
  DREAM_UNDO,
  type DreamApplyAuditDetail,
  DreamApplyAuditDetailSchema,
  type DreamMode,
  DreamModeSchema,
  type DreamRunView,
  DreamUndoAuditDetailSchema,
} from '@keith/contracts'
import type { DreamRowStatus, DreamRunRecord } from '@keith/db'
import { ApplyPartialError, applyPlan } from './apply.ts'
import { collectCandidates, dayOf } from './collect.ts'
import { appendDiary, latestDiaryDate, readDiary } from './diary.ts'
import { checkedPersonId, checkedRunId } from './files.ts'
import { stagedExpiresAt } from './purge.ts'
import {
  countsOf,
  diaryEntriesOf,
  heldBaseOf,
  memoryTiersOf,
  undoableOf,
  viewOf,
  ZERO_COUNTS,
} from './service-helpers.ts'
import { createRecorder } from './service-record.ts'
import { runDream } from './service-run.ts'
import { isTooSoon, skipRun } from './service-skip.ts'
import { TOO_SOON_MS } from './service-text.ts'
import type { DreamRunContext, DreamService, DreamServiceDeps } from './service-types.ts'
import { DreamForbidden, DreamRefused } from './service-types.ts'
import {
  changedSince,
  memoryBaseOf,
  readStagedPlan,
  removeStagedPlan,
  writeStagedPlan,
} from './staged.ts'
import { decideUndo, preimagesOf, restoreRun, undoUntilFrom } from './undo.ts'

// The public texts, thresholds and errors stay importable from this module.
export {
  autoNoticeText,
  budgetLowAt,
  DREAM_FAILED_TEXT,
  dreamBudgetTextOf,
  TOO_SOON_MS,
} from './service-text.ts'
export type { DreamService, DreamServiceDeps, RunResult } from './service-types.ts'
export { DreamForbidden, DreamRefused } from './service-types.ts'

export function createDreamService(deps: DreamServiceDeps): DreamService {
  const clock = deps.now ?? Date.now
  const repo = deps.repo
  const warn = deps.warn ?? (() => {})
  const applier = deps.applier ?? applyPlan
  const record = createRecorder(deps, warn)

  const modeOf = async (personId: string): Promise<DreamMode> => {
    const stored = repo.getMode(personId)
    if (stored !== undefined) return stored
    if (await deps.owner.isOwner(personId)) return 'propose'
    return deps.settings().memberDefault
  }

  const baseOf = (personId: string) =>
    memoryBaseOf(deps.dataDir, personId, memoryTiersOf(deps.dataDir, personId))

  const stagedOf = (personId: string, runId: string) =>
    readStagedPlan(deps.dataDir, personId, runId)

  const ctx: DreamRunContext = { deps, repo, clock, warn, applier, modeOf, baseOf, record }

  const service: DreamService = {
    run: (personId, trigger) => runDream(ctx, personId, trigger),

    async apply(personId, runId) {
      checkedPersonId(personId)
      checkedRunId(runId)
      const staged = stagedOf(personId, runId)
      if (staged === undefined) return { runId, applied: 0, staged: 0 }
      if (changedSince(deps.dataDir, personId, staged).length > 0) {
        // The plan was judged against other bytes: it is dropped, and the run row says so (`rejected`, reason `staged-changed`).
        // A `rejected` row does not move the cursor, so the next run collects the same messages and plans them again.
        removeStagedPlan(deps.dataDir, personId, runId)
        repo.endRun(runId, { status: 'rejected', reason: 'staged-changed' })
        throw new DreamRefused('staged-changed')
      }
      const today = dayOf(clock())
      let written: ReturnType<typeof applier>
      try {
        written = applier({
          dataDir: deps.dataDir,
          personId,
          runId,
          today,
          plan: staged.plan,
          candidates: staged.candidates,
          base: staged.base,
          // the person approved exactly these units: the global rules (caps, profile proposal and size) do not stage them
          approved: true,
        })
      } catch (error) {
        if (!(error instanceof ApplyPartialError)) throw error
        // some files changed before the write that failed: the plan is spent, and the run keeps its undo window (`apply-partial`)
        repo.endRun(runId, {
          status: 'failed',
          reason: 'apply-partial',
          undoUntil: undoUntilFrom(clock()),
        })
        removeStagedPlan(deps.dataDir, personId, runId)
        warn(`dreaming: apply of run ${runId} stopped while writing: ${error.message}`)
        return { runId, applied: 0, staged: 0 }
      }
      // A unit a per-unit guard still holds is not reported as applied: it stays in a staged plan of exactly those units
      const held = new Set(written.staged.map((s) => s.id))
      const undoUntil =
        preimagesOf(deps.dataDir, personId, runId).length > 0 ? undoUntilFrom(clock()) : null
      appendDiary(
        deps.dataDir,
        personId,
        today,
        runId,
        diaryEntriesOf(staged.plan, written, false),
        'apply',
      )
      // a run that wrote nothing and still holds units waits again (`staged`); one that wrote keeps its undo window (`applied`)
      const status = written.written.length === 0 && held.size > 0 ? 'staged' : 'applied'
      repo.endRun(runId, { status, counts: countsOf(written), undoUntil })
      // the staged file goes only once the row is ended; a held unit replaces it with a plan of those units
      if (held.size > 0) {
        writeStagedPlan(deps.dataDir, {
          runId,
          personId,
          stagedAt: clock(),
          plan: { candidates: staged.plan.candidates.filter((c) => held.has(c.id)) },
          candidates: staged.candidates.filter((c) => held.has(c.id)),
          base: heldBaseOf({
            judged: staged.base,
            now: baseOf(personId),
            written: written.written.flatMap((w) => w.paths),
          }),
        })
      } else {
        removeStagedPlan(deps.dataDir, personId, runId)
      }
      const detail: DreamApplyAuditDetail = DreamApplyAuditDetailSchema.parse({
        subject: personId,
        runId,
        applied: written.written.length,
      })
      record.audit(DREAM_APPLY, personId, personId, detail)
      return { runId, applied: written.written.length, staged: held.size }
    },

    undo(personId, runId) {
      checkedPersonId(personId)
      const runs = repo.listRuns(personId, 50)
      const run: DreamRunRecord | undefined =
        runId === undefined ? runs.find(undoableOf) : runs.find((r) => r.id === runId)
      if (run === undefined) throw new DreamRefused('nothing-to-undo')
      const decision = decideUndo({
        now: clock(),
        undoUntil: run.undoUntil,
        hasPreimages: preimagesOf(deps.dataDir, personId, run.id).length > 0,
      })
      if (!decision.ok) throw new DreamRefused(decision.reason)
      const restored = restoreRun(deps.dataDir, personId, run.id)
      repo.endRun(run.id, {
        status: run.status as Exclude<DreamRowStatus, 'running'>,
        reason: run.reason,
        undoUntil: null,
      })
      const detail = DreamUndoAuditDetailSchema.parse({
        subject: personId,
        runId: run.id,
        restored: restored.restored,
      })
      record.audit(DREAM_UNDO, personId, personId, detail)
      return { runId: run.id, restored: restored.restored, skipped: [...restored.skipped] }
    },

    async setMode(caller, personId, mode) {
      checkedPersonId(personId)
      if (caller !== personId) throw new DreamForbidden()
      const value = DreamModeSchema.parse(mode)
      const from = await modeOf(personId)
      repo.setMode(personId, value, caller)
      record.audit(DREAM_MODE, personId, caller, { from, to: value })
      try {
        await deps.onModeChanged?.(personId, value)
      } catch (error) {
        warn(
          `dreaming: dream protocol not synced: ${error instanceof Error ? error.message : error}`,
        )
      }
      return value
    },

    async status(personId) {
      checkedPersonId(personId)
      const mode = await modeOf(personId)
      const runs = repo.listRuns(personId, 50)
      const last = runs[0]
      const latest = repo.latestStarted(personId)
      const now = clock()
      const nextRunAt =
        latest !== undefined && now < latest + TOO_SOON_MS ? latest + TOO_SOON_MS : null
      // the newest run that still holds a staged plan: a later skipped, refused or applied run does not hide it
      const stagedRun = runs.find((run) => stagedOf(personId, run.id) !== undefined)
      const undoRun = runs.find(undoableOf)
      const canUndo =
        undoRun !== undefined &&
        decideUndo({
          now,
          undoUntil: undoRun.undoUntil,
          hasPreimages: preimagesOf(deps.dataDir, personId, undoRun.id).length > 0,
        }).ok
      const lastRun: DreamRunView | null =
        last === undefined ? null : viewOf(last, stagedRun?.id === last.id)
      // the waiting plan's expiry: the purge horizon of its run (purge.ts), so the person sees when the plan goes
      const expires =
        stagedRun !== undefined && stagedRun.endedAt != null
          ? stagedExpiresAt(stagedRun.endedAt)
          : undefined
      return {
        mode,
        lastRun,
        nextRunAt,
        canApply: stagedRun !== undefined,
        canUndo,
        ...(stagedRun === undefined
          ? {}
          : { stagedRunId: stagedRun.id, stagedRunStartedAt: stagedRun.startedAt }),
        ...(expires === undefined ? {} : { stagedExpiresAt: expires }),
      }
    },

    runView(personId, runId) {
      checkedPersonId(personId)
      checkedRunId(runId)
      const row = repo.listRuns(personId, 50).find((r) => r.id === runId)
      return row === undefined ? undefined : viewOf(row, stagedOf(personId, runId) !== undefined)
    },

    isTooSoon: (personId) => isTooSoon(ctx, personId),
    skip: (personId, trigger, reason) => skipRun(ctx, personId, trigger, reason),

    endInterrupted() {
      const ended = repo.failRunning()
      // one `dream.run` audit row and one `end` event per ended run: the same recorder as a run that ends on its own
      for (const run of ended)
        record.announce(
          run.personId,
          {
            runId: run.id,
            status: 'failed',
            reason: 'interrupted',
            counts: ZERO_COUNTS,
            applied: false,
            staged: false,
          },
          run.trigger,
          run.mode,
          true,
        )
      return ended.length
    },

    async runNow(personId) {
      checkedPersonId(personId)
      // the person asked, so the idle condition is not read; the cadence still holds (ADR-0031 §6)
      if (isTooSoon(ctx, personId)) {
        await skipRun(ctx, personId, 'manual', 'too-soon')
        throw new DreamRefused('too-soon')
      }
      return service.run(personId, 'manual')
    },

    pendingUserMessages(personId) {
      checkedPersonId(personId)
      const collected = collectCandidates(deps.sqlite, {
        personId,
        generations: deps.generations,
        cursor: repo.cursorOf(personId) ?? {},
      })
      return collected.candidates.filter((c) => c.role === 'user').length
    },

    diary(personId, date) {
      checkedPersonId(personId)
      const day = date ?? latestDiaryDate(deps.dataDir, personId)
      if (day === undefined) return undefined
      const text = readDiary(deps.dataDir, personId, day)
      return text === undefined ? undefined : { date: day, text }
    },
  }
  return service
}
