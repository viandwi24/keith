// The run as the engine reads and writes it: JSON columns parsed into records, and a version of a protocol loaded with its
// definition checked again by the contract (docs/specs/hypothalamus.md, "Data model"). Only the repos touch the table.
import { type ProtocolDefinition, ProtocolDefinitionSchema, type RunStatus } from '@keith/contracts'
import type { ProtocolsRepo, RunPatch, RunRecord } from '@keith/db'
import type { ActApproval } from './authoring.ts'

/** The answer state of one `ask` step of a run: `open` while it waits, then `answered` or `timeout`. */
export interface Answer {
  /** The visit of the ask this answer belongs to. */
  visit: number
  state: 'open' | 'answered' | 'timeout'
  option?: string
  /** A free-text answer (stored here only: never in a log or an audit row). */
  text?: string
}

/**
 * The key of `answers` that holds a run's cancel reason while its `onCancel` step runs. Step ids cannot hold `$`, so it
 * never collides with an answer; `stateOf` and `patchOf` are the only readers and writers of it.
 */
const CANCEL_KEY = '$cancel'

/** The mutable part of a run. `stateOf` reads it from a row; `patchOf` writes it back with the repo's compare-and-set. */
export interface RunState {
  status: RunStatus
  step: string | null
  visits: Record<string, number>
  answers: Record<string, Answer>
  wakeAt: number | null
  costUsd: number
  endedAt: number | null
  /** The reason the run is cancelled while its `onCancel` step runs (it then ends `cancelled`); null otherwise. */
  cancelling: string | null
}

export function stateOf(run: RunRecord): RunState {
  const stored = JSON.parse(run.answers) as Record<string, Answer>
  const cancelling = stored[CANCEL_KEY]?.option ?? null
  const answers = { ...stored }
  delete answers[CANCEL_KEY]
  return {
    status: run.status,
    step: run.step,
    visits: JSON.parse(run.visits) as Record<string, number>,
    answers,
    wakeAt: run.wakeAt,
    costUsd: run.costUsd,
    endedAt: run.endedAt,
    cancelling,
  }
}

export function patchOf(state: RunState): RunPatch {
  const stored: Record<string, Answer> =
    state.cancelling === null
      ? state.answers
      : {
          ...state.answers,
          [CANCEL_KEY]: { visit: 0, state: 'answered', option: state.cancelling },
        }
  return {
    status: state.status,
    step: state.step,
    visits: JSON.stringify(state.visits),
    answers: JSON.stringify(stored),
    wakeAt: state.wakeAt,
    costUsd: state.costUsd,
    endedAt: state.endedAt,
  }
}

/** One version of a protocol: its definition (checked by the contract) and the pre-approvals of its `act` steps. */
export interface LoadedVersion {
  definition: ProtocolDefinition
  approvals: ActApproval[]
}

/** The stored version a run runs, or undefined when it is gone. Runs keep the version they started with. */
export function loadVersion(
  protocols: ProtocolsRepo,
  protocolId: string,
  version: number,
): LoadedVersion | undefined {
  const row = protocols.version(protocolId, version)
  if (row === undefined) return undefined
  return {
    definition: ProtocolDefinitionSchema.parse(JSON.parse(row.definition)),
    approvals: JSON.parse(row.approvals) as ActApproval[],
  }
}
