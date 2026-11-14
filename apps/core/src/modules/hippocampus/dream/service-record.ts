// The recorders of the dream service (docs/specs/dreaming.md, Rule 8 and "Service"): the audit rows, the `brain.hippocampus.dream`
// events of a run's phases, and the one-off notices of a run. Audit rows and events carry counts, ids and codes only, never text.
// The run and the skip helpers call these; they never decide a run's outcome.

import {
  DREAM_RUN,
  type DreamMode,
  type DreamRunAuditDetail,
  DreamRunAuditDetailSchema,
  type DreamRunCounts,
  type DreamRunReason,
  type DreamTrigger,
  HippocampusDreamPayloadSchema,
} from '@keith/contracts'
import type { DreamRowStatus } from '@keith/db'
import { frontSessionId } from '../../../platform/sessions.ts'
import { ZERO_COUNTS } from './service-helpers.ts'
import type { DreamRecorder, DreamServiceDeps, RunResult } from './service-types.ts'

/** A run that ended without reaching the applier: a refusal, a skip or a failure (the counts are zero, the cursor stays). */
export function endWithout(
  runId: string,
  status: 'refused' | 'failed' | 'skipped',
  reason: DreamRunReason | null,
): RunResult {
  return {
    runId,
    status,
    reason,
    counts: ZERO_COUNTS,
    applied: false,
    staged: false,
  }
}

/** The recorders of one service: they write to the audit service, the activity feed and the delivery service it is given. */
export function createRecorder(
  deps: DreamServiceDeps,
  warn: (message: string) => void,
): DreamRecorder {
  const audit = (
    kind: string,
    personId: string,
    actor: string,
    detail: Record<string, unknown>,
  ): void => {
    deps.audit.record({ kind, actor, via: 'local', detail: { subject: personId, ...detail } })
  }

  /**
   * The brain event of a run's phase, on the person's current front session. `start` is written after the collect (its
   * `candidates` is the count the run reviews, the other counts are zero); `end` when the run ends, whatever its status
   * (`applied` says whether a plan reached memory).
   */
  const phaseEvent = (
    personId: string,
    runId: string,
    trigger: DreamTrigger,
    phase: 'start' | 'end',
    counts: DreamRunCounts,
    applied: boolean,
    outcome?: { status: DreamRowStatus; reason: DreamRunReason | null },
  ): void => {
    if (deps.activity === undefined) return
    const payload = HippocampusDreamPayloadSchema.parse({
      region: 'hippocampus',
      personId,
      runId,
      phase,
      trigger,
      candidates: counts.candidates,
      promoted: counts.promoted,
      merged: counts.merged,
      superseded: counts.superseded,
      dropped: counts.dropped,
      applied,
      ...(outcome === undefined ? {} : { status: outcome.status, reason: outcome.reason }),
    })
    deps.activity.record(
      frontSessionId(personId, deps.generations.current(personId)),
      'brain.hippocampus.dream',
      payload,
    )
  }

  const announce = (
    personId: string,
    record: RunResult,
    trigger: DreamTrigger,
    mode: DreamMode,
    started: boolean,
  ): void => {
    // A run that reached the applier carries its counts; a refused, skipped or failed run carries its status and reason only.
    const reached = record.status === 'applied' || record.status === 'staged'
    const detail: DreamRunAuditDetail = DreamRunAuditDetailSchema.parse({
      subject: personId,
      mode,
      trigger,
      status: record.status,
      reason: record.reason,
      ...(reached
        ? {
            candidates: record.counts.candidates,
            promoted: record.counts.promoted,
            merged: record.counts.merged,
            superseded: record.counts.superseded,
            dropped: record.counts.dropped,
            applied: record.applied,
            staged: record.staged,
          }
        : {}),
    })
    audit(DREAM_RUN, personId, 'system', detail)
    if (!started || record.runId === null) return
    phaseEvent(personId, record.runId, trigger, 'end', record.counts, record.applied, {
      status: record.status,
      reason: record.reason,
    })
  }

  /** One notice per run and kind: the delivery id is the run's, so a repeat of the same run sends nothing (delivery.md). */
  const tellOnce = async (
    personId: string,
    runId: string,
    kind: 'budget' | 'failed' | 'auto',
    text: string,
  ): Promise<void> => {
    if (deps.deliver === undefined) return
    try {
      await deps.deliver({
        id: `dream:${runId}:${kind}`,
        source: 'dreaming',
        to: personId,
        name: 'dreaming.notice',
        text,
        needs: { mode: 'note', capabilities: [], fanout: 'best', urgency: 'normal' },
      })
    } catch (error) {
      warn(`dreaming: ${kind} notice not sent: ${error instanceof Error ? error.message : error}`)
    }
  }

  return { audit, phaseEvent, announce, tellOnce }
}
