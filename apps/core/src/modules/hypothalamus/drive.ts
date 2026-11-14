// The run state machine (docs/specs/hypothalamus.md, "Engine" and "Restart"). A transition moves a run one step: it either
// writes one state change (with its step row, in one transaction) and returns the new run to continue with, or it stops the
// run (waiting, ended, or a lost compare-and-set) and returns undefined. The side effect of a step always sits between two
// writes: the `started` row first, the outcome second. A crash between them leaves the `started` row, and the next drive
// replays the step (a `notify`, `wake` or `ask` with the same delivery key is a no-op; an `act` becomes `unknown`).
import type { ProtocolDefinition, ProtocolStep } from '@keith/contracts'
import type { RunRecord, RunStepRecord } from '@keith/db'
import { evaluatedTrigger } from './builtins.ts'
import { gateVerdict } from './gate.ts'
import type { EngineDeps, StepResult } from './ports.ts'
import {
  type Answer,
  type LoadedVersion,
  loadVersion,
  type RunState,
  stateOf,
} from './run-state.ts'
import { outcomeClass, quietEnd, recipientOf, stepById, totalVisits } from './steps.ts'
import { createWriter, type RouteKey, type Row } from './writer.ts'

export interface AnswerInput {
  runId: string
  /** The person who answers; must be the step's recipient. */
  by: string
  option?: string
  text?: string
}

export type AnswerOutcome =
  | { status: 'answered'; run: RunRecord }
  | { status: 'not-waiting' | 'not-open' | 'not-yours' | 'bad-option' | 'lost' }

export interface Driver {
  /** Runs transitions of one claimed or new run until it waits or ends. */
  drive(run: RunRecord): Promise<void>
  /** Records an answer of an open `ask` and continues the run. */
  answer(input: AnswerInput): Promise<AnswerOutcome>
  /** Ends the run `cancelled` when its `cancelWhen` holds now; true when it did. */
  cancelIfWhen(run: RunRecord): Promise<boolean>
}

export type DriverDeps = Omit<EngineDeps, 'tickLimit'> & {
  /** Ids of the runs that are waiting (the tick re-checks their `cancelWhen`). */
  watched: Set<string>
}

export function createDriver(deps: DriverDeps): Driver {
  const { clock, conditions, protocols, runs, steps, ownerOf } = deps
  const warn = deps.warn ?? (() => {})
  const now = (): number => clock.now()
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)
  const writer = createWriter(deps)
  const { holds, route, persist, finish, noteWait, inFlight, tellOwner } = writer

  /** An `act` in flight at a crash: never repeated; the owner is told first (a keyed notice), then the run ends. */
  async function unknownAct(
    run: RunRecord,
    state: RunState,
    step: ProtocolStep,
    row: RunStepRecord,
  ): Promise<undefined> {
    await tellOwner(run)
    finish(run, state, 'failed', {
      settle: { n: row.n, step: step.id, kind: step.kind, outcome: 'unknown' },
      reason: 'unknown',
    })
    return undefined
  }

  /** The run ends failed at a limit; the step's row records the limit. */
  function limitHit(run: RunRecord, state: RunState, step: ProtocolStep): undefined {
    finish(run, state, 'failed', {
      append: { step: step.id, kind: step.kind, outcome: 'failed:limit' },
      reason: 'limit',
    })
    return undefined
  }

  /** The step's side effect and its outcome: one write for the `open` of an ask, one for a finished step. */
  async function execute(
    run: RunRecord,
    state: RunState,
    step: ProtocolStep,
    version: LoadedVersion,
    at: { row: number; visit: number },
  ): Promise<RunRecord | undefined> {
    let result: StepResult
    try {
      result = await steps.run({
        run,
        definition: version.definition,
        approvals: version.approvals,
        step,
        visit: at.visit,
        key: `${run.id}:${step.id}:${at.visit}`,
        now: now(),
        ownerId: await ownerOf(),
        protocolOwner: protocols.get(run.protocolId)?.owner ?? '',
      })
    } catch (error) {
      warn(`protocol ${run.protocolId} step ${step.id} failed: ${message(error)}`)
      result = { kind: 'done', outcome: 'failed:error' }
    }

    if (result.kind === 'open') {
      const answers: Record<string, Answer> = {
        ...state.answers,
        [step.id]: { visit: at.visit, state: 'open' },
      }
      const wakeAt = now() + result.timeoutMs
      const written = persist(
        run,
        { ...state, status: 'waiting', step: step.id, wakeAt, answers },
        {
          settle: {
            n: at.row,
            step: step.id,
            kind: step.kind,
            outcome: 'ok',
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          },
        },
      )
      if (written !== undefined) noteWait(run, wakeAt)
      return undefined
    }

    const settle = {
      n: at.row,
      step: step.id,
      kind: step.kind,
      outcome: result.outcome,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    }
    if (result.outcome === 'unknown') {
      await tellOwner(run)
      finish(run, state, 'failed', { settle, reason: 'unknown' })
      return undefined
    }
    const costed: RunState = { ...state, costUsd: state.costUsd + (result.costUsd ?? 0) }
    const goto = await route(step, outcomeClass(result.outcome), run)
    if (goto === undefined || goto === 'end') {
      finish(run, costed, outcomeClass(result.outcome) === 'ok' ? 'done' : 'failed', { settle })
      return undefined
    }
    return persist(run, { ...costed, step: goto }, { settle })?.run
  }

  /** The step is entered: a quiet window defers `notify` and `wake` (no row, no visit). */
  function quietDefer(
    run: RunRecord,
    state: RunState,
    step: ProtocolStep,
    def: ProtocolDefinition,
  ): boolean {
    if (
      (step.kind !== 'notify' && step.kind !== 'wake') ||
      ('urgent' in step && step.urgent === true)
    ) {
      return false
    }
    const end = quietEnd(now(), def.limits.quietHours, clock.timeZone)
    if (end === undefined) return false
    const written = persist(run, { ...state, status: 'waiting', wakeAt: end })
    if (written !== undefined) noteWait(run, end)
    return true
  }

  /** One transition of a run. Returns the run to continue with, or undefined when the run stops. */
  async function transition(
    run: RunRecord,
    version: LoadedVersion,
  ): Promise<RunRecord | undefined> {
    const { definition } = version
    const state = stateOf(run)
    if (state.step === null) {
      finish(run, state, 'done')
      return undefined
    }
    const cancel = definition.limits.cancelWhen
    if (state.cancelling === null && cancel !== undefined && (await holds(cancel, run))) {
      return cancelled(run, state, definition)
    }
    // the trigger's guard is read when the run first moves (at its wake time): a false guard skips the run
    if (state.step === definition.start && totalVisits(state.visits) === 0) {
      const verdict = await gateVerdict({
        trigger: evaluatedTrigger(
          definition.trigger,
          protocols.get(run.protocolId)?.builtIn,
          deps.pingBeforeMs,
        ),
        viewer: run.person,
        ports: conditions,
        now: now(),
        triggerRef: run.triggerRef,
      })
      if (verdict.kind === 'skip') {
        finish(run, state, 'skipped', { reason: 'guard' })
        return undefined
      }
      if (verdict.kind === 'wait') {
        const written = persist(run, { ...state, status: 'waiting', wakeAt: verdict.wakeAt })
        if (written !== undefined) noteWait(run, verdict.wakeAt)
        return undefined
      }
    }
    const step = stepById(definition, state.step)
    if (step === undefined) {
      finish(run, state, 'failed', { reason: 'no-step' })
      return undefined
    }

    // an ask whose answer is still open at its deadline: the timeout branch (or next, or the run expires)
    const open = state.answers[step.id]
    if (step.kind === 'ask' && open?.state === 'open') {
      return timeout(run, state, step, open)
    }
    if (step.kind === 'wait') return wait(run, state, step, definition)

    const replayed = inFlight(run, step.id)
    if (replayed !== undefined) {
      if (step.kind === 'act') return unknownAct(run, state, step, replayed)
      // notify, wake, ask: the same delivery key makes the repeat a no-op at the delivery service
      return await execute(run, state, step, version, {
        row: replayed.n,
        visit: state.visits[step.id] ?? 1,
      })
    }

    if (quietDefer(run, state, step, definition)) return undefined

    const visit = (state.visits[step.id] ?? 0) + 1
    if (visit > definition.limits.maxVisits) return limitHit(run, state, step)
    if (totalVisits(state.visits) + 1 > definition.limits.maxSteps) {
      return limitHit(run, state, step)
    }
    // the `started` row and the visit are written before the side effect
    const begun = persist(
      run,
      {
        ...state,
        status: 'running',
        wakeAt: null,
        visits: { ...state.visits, [step.id]: visit },
      },
      { append: { step: step.id, kind: step.kind, outcome: 'started' } },
    )
    if (begun === undefined) return undefined
    return execute(begun.run, stateOf(begun.run), step, version, { row: begun.n, visit })
  }

  async function timeout(
    run: RunRecord,
    state: RunState,
    step: ProtocolStep,
    open: Answer,
  ): Promise<RunRecord | undefined> {
    const goto = await route(step, 'timeout', run)
    const base: RunState = {
      ...state,
      answers: { ...state.answers, [step.id]: { ...open, state: 'timeout' } },
    }
    const row: Row = { step: step.id, kind: step.kind, outcome: 'timeout' }
    if (goto === undefined || goto === 'end') {
      finish(run, base, 'expired', { append: row })
      return undefined
    }
    return persist(run, { ...base, status: 'running', step: goto, wakeAt: null }, { append: row })
      ?.run
  }

  function wait(
    run: RunRecord,
    state: RunState,
    step: Extract<ProtocolStep, { kind: 'wait' }>,
    definition: ProtocolDefinition,
  ): RunRecord | undefined {
    const visit = (state.visits[step.id] ?? 0) + 1
    if (visit > definition.limits.maxVisits) return limitHit(run, state, step)
    if (totalVisits(state.visits) + 1 > definition.limits.maxSteps) {
      return limitHit(run, state, step)
    }
    const goto = step.next
    const ended = goto === undefined || goto === 'end'
    const wakeAt = now() + step.durationMs
    const written = persist(
      run,
      {
        ...state,
        status: 'waiting',
        step: ended ? null : goto,
        wakeAt,
        visits: { ...state.visits, [step.id]: visit },
      },
      { append: { step: step.id, kind: 'wait', outcome: 'ok' } },
    )
    if (written !== undefined) noteWait(run, wakeAt)
    return undefined
  }

  async function drive(start: RunRecord): Promise<void> {
    const version = loadVersion(protocols, start.protocolId, start.version)
    if (version === undefined) {
      finish(start, stateOf(start), 'failed', { reason: 'no-version' })
      return
    }
    let run: RunRecord | undefined = start
    while (run !== undefined) run = await transition(run, version)
  }

  async function answer(input: AnswerInput): Promise<AnswerOutcome> {
    const run = runs.get(input.runId)
    if (run === undefined || run.status !== 'waiting') return { status: 'not-waiting' }
    const version = loadVersion(protocols, run.protocolId, run.version)
    if (version === undefined) return { status: 'not-waiting' }
    const state = stateOf(run)
    const step = state.step === null ? undefined : stepById(version.definition, state.step)
    if (step === undefined || step.kind !== 'ask') return { status: 'not-waiting' }
    const open = state.answers[step.id]
    if (open === undefined || open.state !== 'open') return { status: 'not-open' }
    if (input.by !== recipientOf(step.to, run, await ownerOf())) return { status: 'not-yours' }
    if (input.option === undefined && input.text === undefined) return { status: 'bad-option' }
    if (input.option !== undefined && !(step.options ?? []).includes(input.option)) {
      return { status: 'bad-option' }
    }

    const key: RouteKey | undefined =
      input.option === undefined ? undefined : `answer:${input.option}`
    const goto = await route(step, key, run)
    const answered: Answer = {
      visit: open.visit,
      state: 'answered',
      ...(input.option === undefined ? {} : { option: input.option }),
      ...(input.text === undefined ? {} : { text: input.text }),
    }
    const base: RunState = { ...state, answers: { ...state.answers, [step.id]: answered } }
    const row: Row = {
      step: step.id,
      kind: step.kind,
      outcome: input.option === undefined ? 'answered:text' : `answered:${input.option}`,
    }
    if (goto === undefined || goto === 'end') {
      return finish(run, base, 'done', { append: row })
        ? { status: 'answered', run: runs.get(run.id) ?? run }
        : { status: 'lost' }
    }
    const written = persist(
      run,
      { ...base, status: 'running', step: goto, wakeAt: null },
      { append: row },
    )
    if (written === undefined) return { status: 'lost' }
    await drive(written.run)
    return { status: 'answered', run: runs.get(run.id) ?? written.run }
  }

  /**
   * The run's `cancelWhen` holds: it ends `cancelled` now, or, with an `onCancel` step, runs that step first and ends
   * `cancelled` after it. The returned run continues with the onCancel step; undefined when the run stopped here.
   */
  function cancelled(
    run: RunRecord,
    state: RunState,
    definition: ProtocolDefinition,
  ): RunRecord | undefined {
    const onCancel = definition.limits.onCancel
    if (onCancel === undefined) {
      finish(run, state, 'cancelled', { reason: 'cancelWhen' })
      return undefined
    }
    return persist(run, {
      ...state,
      status: 'running',
      step: onCancel,
      wakeAt: null,
      cancelling: 'cancelWhen',
    })?.run
  }

  /** Tick path of a waiting run: ends it (or starts its onCancel step) when its `cancelWhen` holds; true when it did. */
  async function cancelIfWhen(run: RunRecord): Promise<boolean> {
    const version = loadVersion(protocols, run.protocolId, run.version)
    const rule = version?.definition.limits.cancelWhen
    const state = stateOf(run)
    if (version === undefined || rule === undefined || state.cancelling !== null) return false
    if (!(await holds(rule, run))) return false
    if (version.definition.limits.onCancel === undefined) {
      return finish(run, state, 'cancelled', { reason: 'cancelWhen' })
    }
    const started = cancelled(run, state, version.definition)
    if (started === undefined) return false
    await drive(started)
    return true
  }

  return { drive, answer, cancelIfWhen }
}
