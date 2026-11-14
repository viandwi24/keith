// The step writer of the run engine (docs/specs/hypothalamus.md, "Engine"): the one place that writes a run's state and
// its step rows. Each write is one transaction with the run's compare-and-set on `updated_at`; the journal rows follow the
// commit. Condition checks and routing (the branch a step takes) are read here too, so the transitions stay short.
import type { Condition, Goto, ProtocolStep, RunStatus } from '@keith/contracts'
import type { RunRecord, RunStepRecord } from '@keith/db'
import { evaluateCondition } from './conditions.ts'
import { type EngineDeps, type FlatDetail, subjectOf } from './ports.ts'
import { patchOf, type RunState } from './run-state.ts'

/** The branch keys a route reads: `ok`, `failed`, `timeout` or `answer:<option>`. */
/** The fixed notice to the owner when an `act` may have run and its result is lost. It names nothing from the run. */
export const UNKNOWN_NOTICE =
  'A protocol step may have run before Keith stopped, and its result is unknown. The protocol run has ended and nothing was retried.'

export type RouteKey = 'ok' | 'failed' | 'timeout' | `answer:${string}`

/** A step row to write: the step, its kind, its outcome and its flat detail. */
export interface Row {
  step: string
  kind: string
  outcome: string
  detail?: FlatDetail
}

export interface Change {
  /** The `started` row of this step is settled with the outcome. */
  settle?: Row & { n: number }
  /** A new step row. */
  append?: Row
}

export interface Written {
  run: RunRecord
  /** The `n` of the appended row, or of the settled one. */
  n: number
}

class LostWrite extends Error {}

/** What the writer reads and writes: the engine's ports plus the set of runs the tick watches. */
export type WriterDeps = Omit<EngineDeps, 'tickLimit' | 'protocols'> & { watched: Set<string> }

export function createWriter(deps: WriterDeps) {
  const { clock, conditions, runs, steps, journal, transaction, ownerOf, watched } = deps
  const warn = deps.warn ?? (() => {})
  const now = (): number => clock.now()
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  const holds = (condition: Condition, run: RunRecord): Promise<boolean> =>
    evaluateCondition(condition, {
      viewer: run.person,
      ports: conditions,
      runStartedAt: run.startedAt,
    })

  /** Where a step goes next: condition branches first (in order), then the branch of the key, then `next`. */
  async function route(
    step: ProtocolStep,
    key: RouteKey | undefined,
    run: RunRecord,
  ): Promise<Goto | undefined> {
    for (const branch of step.branches ?? []) {
      if (branch.when === 'condition' && branch.condition !== undefined) {
        if (await holds(branch.condition, run)) return branch.goto
      }
    }
    if (key !== undefined) {
      for (const branch of step.branches ?? []) {
        if (branch.when === key) return branch.goto
      }
    }
    return step.next
  }

  // every run acts for a person (a `keith`-owned run: the owner found at its start), so its records carry that person
  const withPerson = (run: RunRecord, base: FlatDetail): FlatDetail => ({
    ...base,
    personId: run.person,
  })

  function noteStep(run: RunRecord, row: Row): void {
    const base = {
      protocolId: run.protocolId,
      runId: run.id,
      step: row.step,
      kind: row.kind,
      outcome: row.outcome,
    }
    journal.audit('protocol.run.step', { ...base, ...subjectOf(run.person) })
    journal.event('brain.hypothalamus.step', withPerson(run, base))
  }

  function noteWait(run: RunRecord, wakeAt: number): void {
    journal.event('brain.hypothalamus.wait', withPerson(run, { runId: run.id, wakeAt }))
  }

  /**
   * One write transaction: the optional settle of a step row, the optional new row, then the run's compare-and-set on
   * `updated_at`. A lost compare-and-set writes nothing and returns undefined. Journal rows follow the commit.
   */
  function persist(run: RunRecord, next: RunState, change: Change = {}): Written | undefined {
    try {
      const written = transaction((): Written => {
        if (change.settle !== undefined) {
          const { settle } = change
          runs.settleStep(
            settle.n,
            settle.outcome,
            settle.detail === undefined ? undefined : JSON.stringify(settle.detail),
          )
        }
        const n =
          change.append === undefined
            ? (change.settle?.n ?? 0)
            : runs.appendStep({
                runId: run.id,
                step: change.append.step,
                kind: change.append.kind,
                outcome: change.append.outcome,
                at: now(),
                detail:
                  change.append.detail === undefined ? null : JSON.stringify(change.append.detail),
              })
        const updated = runs.advance(run.id, run.updatedAt, patchOf(next), now())
        if (updated === undefined) throw new LostWrite()
        return { run: updated, n }
      })
      if (next.status === 'waiting') watched.add(run.id)
      else watched.delete(run.id)
      const row = change.settle ?? change.append
      if (row !== undefined && row.outcome !== 'started') noteStep(run, row)
      return written
    } catch (error) {
      if (error instanceof LostWrite) return undefined
      throw error
    }
  }

  /**
   * Ends the run. The end row, if any, is written with the status in the same transaction. A run cancelled by `cancelWhen`
   * ends `cancelled` whatever its last step did (`done`, `failed`, `expired`): the cancel reason is kept on the end.
   */
  function finish(
    run: RunRecord,
    state: RunState,
    requested: RunStatus,
    options: Change & { reason?: string } = {},
  ): boolean {
    const cancelling = state.cancelling !== null
    const status: RunStatus =
      cancelling && (requested === 'done' || requested === 'failed' || requested === 'expired')
        ? 'cancelled'
        : requested
    const reason =
      options.reason ?? (cancelling && status === 'cancelled' ? state.cancelling : undefined)
    const written = persist(
      run,
      { ...state, status, step: null, wakeAt: null, endedAt: now() },
      options,
    )
    if (written === undefined) return false
    journal.audit('protocol.run.end', {
      protocolId: run.protocolId,
      runId: run.id,
      status,
      ...(reason === undefined || reason === null ? {} : { reason }),
      ...subjectOf(run.person),
    })
    journal.event('brain.hypothalamus.end', withPerson(run, { runId: run.id, status }))
    return true
  }

  /** The last step row of the run when it is an unsettled `started` row of this step: the step was in flight at a crash. */
  function inFlight(run: RunRecord, stepId: string): RunStepRecord | undefined {
    const rows = runs.steps(run.id)
    const last = rows[rows.length - 1]
    return last !== undefined && last.outcome === 'started' && last.step === stepId
      ? last
      : undefined
  }

  async function tellOwner(run: RunRecord): Promise<void> {
    try {
      const to = await ownerOf()
      if (to === '') return warn(`protocol ${run.protocolId}: no owner to tell about ${run.id}`)
      await steps.tell({ to, key: `${run.id}:unknown`, text: UNKNOWN_NOTICE })
    } catch (error) {
      warn(`protocol ${run.protocolId}: owner notice failed: ${message(error)}`)
    }
  }

  return { holds, route, persist, finish, noteStep, noteWait, inFlight, tellOwner }
}
