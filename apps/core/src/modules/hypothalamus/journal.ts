// The journal of the protocol engine (docs/specs/hypothalamus.md, "Audit" and "Events"): the audit rows of the runs and the
// `brain.hypothalamus.*` records on the activity feed. The engine says what happened with flat details (ids, outcomes,
// reasons, never message text); this adapter writes them. Both writes are fire and forget: a failure is reported to `warn`
// and never stops a run.
import type { ActivityStore } from 'eharness/activity'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import { emit } from '../brain-events/index.ts'
import type { Journal, RunAuditKind, RunEventType } from './ports.ts'

export interface JournalDeps {
  /** The core's audit log: one row per call, actor `system`. */
  audit(kind: RunAuditKind, detail: Record<string, unknown>): void
  /** The activity feed the brain events go to. */
  store: ActivityStore
  warn(message: string): void
  /** The current front generation of each person (ADR-0030 §2): the session the person's events go to. */
  generations: FrontGenerationOf
}

/**
 * The events land on the front session of the person the run acts for (`personId` in the payload: every run has one, a
 * `keith`-owned run's is the instance owner found at its start). `region` is added here: the brain payload contracts
 * require it. An event without a person is reported and dropped.
 */
export function createJournal(deps: JournalDeps): Journal {
  return {
    audit(kind, detail) {
      try {
        deps.audit(kind, detail)
      } catch (error) {
        deps.warn(
          `protocols: audit ${kind} failed: ${error instanceof Error ? error.message : error}`,
        )
      }
    },
    event(type: RunEventType, payload) {
      if (typeof payload.personId !== 'string' || payload.personId === '') {
        deps.warn(`protocols: ${type} has no person and is not emitted`)
        return
      }
      emit(
        deps.store,
        type,
        frontSessionId(payload.personId, deps.generations.current(payload.personId)),
        null,
        { region: 'hypothalamus', ...payload },
        deps.warn,
      )
    },
  }
}
