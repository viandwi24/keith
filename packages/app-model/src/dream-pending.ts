// The dream in progress and its outcome line in the chat (docs/specs/tui.md "Dreaming"; docs/specs/dreaming.md "Visibility"). Pure:
// no client, no screen. While a run runs the chat shows one animated line (`dreaming · reviewing N notes · 12 s`); when it ends the
// line gives way to one permanent divider (`dream finished · …`). The start event carries the candidate count the run reviews
// (dreaming.md Rule 8), so `N` shows when it is above zero. Words come from dream-state.ts; the divider carries counts and reasons, never text.
import type { DreamRefusalReason, DreamRunView } from '@keith/contracts'
import {
  DREAM_REFUSAL_TEXT,
  DREAM_SKIP_TEXT,
  dateOf,
  FAILED_WITHOUT_REASON,
  reasonTextOf,
  SKIPPED_WITHOUT_REASON,
  stagedExpiresAtOf,
} from './dream-state.ts'

/** A run between its start and its end, as the chat shows it. */
export interface DreamRunning {
  runId: string
  /** Local arrival time of the start (epoch ms): the seconds count from it. */
  startedAt: number
  /** The candidate count the run reviews, from the start event (shown only when above zero). */
  candidates?: number
}

/** The events the running line follows: a start, an end (of any run), and a feed resync (an end may have been missed). */
export type DreamRunningEvent =
  | { type: 'start'; runId: string; at: number; candidates?: number }
  | { type: 'end'; runId: string }
  | { type: 'resync' }

/** Folds one event into the running run. Pure: an end of another run leaves it as it is. */
export function reduceDreamRunning(
  state: DreamRunning | undefined,
  event: DreamRunningEvent,
): DreamRunning | undefined {
  switch (event.type) {
    case 'start':
      return {
        runId: event.runId,
        startedAt: event.at,
        ...(event.candidates !== undefined && event.candidates > 0
          ? { candidates: event.candidates }
          : {}),
      }
    case 'end':
      return state?.runId === event.runId ? undefined : state
    case 'resync':
      return undefined
  }
}

/** The animated line while a run runs: `dreaming · 12 s`, or `dreaming · reviewing 3 notes · 12 s` when the count is known. */
export function dreamingLineOf(running: DreamRunning, now: number): string {
  const seconds = Math.max(0, Math.floor((now - running.startedAt) / 1000))
  const n = running.candidates
  const reviewing =
    n !== undefined && n > 0 ? ` · reviewing ${n} ${n === 1 ? 'note' : 'notes'}` : ''
  return `dreaming${reviewing} · ${seconds} s`
}

/** The changes a run would make or made: promoted, merged and superseded (dropped entries change nothing in memory). */
export function changesOf(counts: DreamRunView['counts']): number {
  return counts.promoted + counts.merged + counts.superseded
}

/**
 * The permanent divider of a finished run (tui-design 5.20 and the chat's context dividers): one line, words and counts only.
 * `staged` waits for `/dream apply`; `applied` was saved (auto mode); `failed`, `skipped`, `refused` and `rejected` say why.
 */
export function dreamDividerOf(
  run: Pick<DreamRunView, 'status' | 'reason' | 'counts'> & { finishedAt?: number | null },
): string {
  const reviewed = run.counts.candidates
  const changes = changesOf(run.counts)
  switch (run.status) {
    case 'staged': {
      if (changes === 0) return `dream finished · ${reviewed} reviewed · nothing to change`
      const waiting = `dream finished · ${reviewed} reviewed · ${changes} ${changes === 1 ? 'change' : 'changes'} waiting (/dream apply)`
      // the divider is history, so the expiry is a date (the live status says "expires in N days")
      return typeof run.finishedAt === 'number'
        ? `${waiting} · expires ${dateOf(stagedExpiresAtOf(run.finishedAt))}`
        : waiting
    }
    case 'applied':
      return changes > 0
        ? `dream finished · ${reviewed} reviewed · ${changes} ${changes === 1 ? 'change' : 'changes'} saved (/dream undo within 7 days)`
        : `dream finished · ${reviewed} reviewed · nothing to change`
    case 'failed':
      return `dream failed · ${reasonTextOf(run.reason) ?? FAILED_WITHOUT_REASON}`
    case 'skipped':
      return run.reason !== null && run.reason in DREAM_SKIP_TEXT
        ? DREAM_SKIP_TEXT[run.reason as keyof typeof DREAM_SKIP_TEXT]
        : `dream skipped · ${reasonTextOf(run.reason) ?? SKIPPED_WITHOUT_REASON}`
    case 'refused':
      return run.reason !== null && run.reason in DREAM_REFUSAL_TEXT
        ? `dream refused · ${DREAM_REFUSAL_TEXT[run.reason as DreamRefusalReason]}`
        : 'dream refused · the run did not start'
    case 'rejected':
      return 'dream rejected · the plan was not accepted; nothing was written.'
    case 'running':
      return 'dream running'
  }
}

/**
 * The divider of an end event whose run the status does not show (the status moved on to a newer run): the event's own status and
 * reason decide when it carries them (dreaming.md Rule 8), else its counts with `applied` telling saved from waiting.
 */
export function dreamEndFallbackOf(end: {
  candidates: number
  promoted: number
  merged: number
  superseded: number
  dropped: number
  applied: boolean
  status?: DreamRunView['status'] | undefined
  reason?: DreamRunView['reason'] | undefined
}): string {
  return dreamDividerOf({
    status: end.status ?? (end.applied ? 'applied' : 'staged'),
    reason: end.reason ?? null,
    counts: {
      candidates: end.candidates,
      promoted: end.promoted,
      merged: end.merged,
      superseded: end.superseded,
      dropped: end.dropped,
    },
  })
}

/** The divider of a refusal that has no run row (`too-soon`, `off`): nothing ran, and nothing else says so in the chat. */
export function dreamRefusedDividerOf(reason: DreamRefusalReason): string {
  return `dream refused · ${DREAM_REFUSAL_TEXT[reason]}`
}
