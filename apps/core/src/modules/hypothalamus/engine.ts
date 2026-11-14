// The protocol engine (docs/specs/hypothalamus.md, "Engine"): starts runs exactly once per trigger, ticks due runs, and
// keeps every run's state in the repos. Deterministic: the clock is injected and nothing here calls a model.
import type { ProtocolDefinition, RunStatus, TriggerKind } from '@keith/contracts'
import type { ProtocolRecord, RunRecord } from '@keith/db'
import { KEITH_OWNER } from './authoring.ts'
import { evaluateCondition } from './conditions.ts'
import { type AnswerInput, type AnswerOutcome, createDriver, type Driver } from './drive.ts'
import { type EngineDeps, subjectOf } from './ports.ts'
import { loadVersion } from './run-state.ts'
import { runIdFor, utcDayStart } from './steps.ts'
import type { RunStarter, RunStartInput, RunStartOutcome } from './triggers.ts'

/** Due runs one tick takes when the deps do not say otherwise. */
export const DEFAULT_TICK_LIMIT = 50

export interface StartInput {
  protocolId: string
  /** What fired: `time`, `absence`, `signal` or `event`. Only the fire record and the audit row carry it. */
  trigger: TriggerKind
  /** The fire id (a schedule's fire, `absence:<lastSignAt>`, a signal id or an event sequence): the exactly-once key. */
  triggerRef: string
  /**
   * When the run's first step may start. Absent or past: the run starts now. In the future (an `afterMs` event, a
   * `time.at`): the run is created `waiting` until then.
   */
  startAt?: number
  /** The person the run acts for when the trigger names one (a `delivery.failed` record's `personId`); keith-owned only. */
  person?: string
}

export type StartOutcome =
  | { status: 'created'; run: RunRecord }
  | { status: 'exists'; run: RunRecord }
  | { status: 'limit' }
  | { status: 'off'; reason: 'missing' | 'disabled' | 'paused' | 'no-owner' }

export interface TickOutcome {
  /** Due runs taken this tick. */
  claimed: number
  /** Runs ended `cancelled` by their `cancelWhen` this tick. */
  cancelled: number
  /** True when a tick was already running: nothing was done. */
  skipped: boolean
}

/** What boot recovery found and resumed (docs/specs/hypothalamus.md, "Restart"). */
export interface RecoverReport {
  /** Waiting runs the engine now watches for `cancelWhen`. */
  waiting: number
  /** Running runs driven again: a step in flight at the crash is replayed or ends `unknown`. */
  resumed: number
}

export interface ProtocolEngine {
  start(input: StartInput): Promise<StartOutcome>
  /**
   * Boot recovery: watches the waiting runs and drives every `running` run left by a crash. A waiting run whose wake
   * time passed advances at the first tick. Called once, before the timers start.
   */
  recover(): Promise<RecoverReport>
  /** Re-checks the `cancelWhen` of waiting runs, then takes and advances every due run. Never overlaps itself. */
  tick(): Promise<TickOutcome>
  /** An answer to an open `ask` of a run; the person must be the step's recipient. */
  answer(input: AnswerInput): Promise<AnswerOutcome>
  /** Ids of the runs the engine watches for `cancelWhen` (the waiting ones). */
  readonly watched: ReadonlySet<string>
  /** Adds the waiting runs of the store to the watch (boot recovery, P28.2.6). */
  watchWaiting(runs: readonly RunRecord[]): void
}

/** The engine. Each run is driven by one transition at a time; a second writer loses the compare-and-set and stops. */
export function createEngine(deps: EngineDeps): ProtocolEngine {
  const { clock, conditions, protocols, runs, journal, ownerOf } = deps
  const warn = deps.warn ?? (() => {})
  const tickLimit = deps.tickLimit ?? DEFAULT_TICK_LIMIT
  const watched = new Set<string>()
  const driver: Driver = createDriver({ ...deps, watched })
  let ticking = false

  /** Every condition reads the person the run acts for (a `keith`-owned run: the owner found at its start). */
  async function conditionsHold(definition: ProtocolDefinition, person: string): Promise<boolean> {
    for (const condition of definition.conditions) {
      if (!(await evaluateCondition(condition, { viewer: person, ports: conditions }))) return false
    }
    return true
  }

  /** A drive that throws leaves the run as it is in the store; boot recovery picks it up (P28.2.6). */
  async function safeDrive(run: RunRecord): Promise<void> {
    try {
      await driver.drive(run)
    } catch (error) {
      warn(
        `protocol run ${run.id} stopped: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function start(input: StartInput): Promise<StartOutcome> {
    const now = clock.now()
    const protocol: ProtocolRecord | undefined = protocols.get(input.protocolId)
    if (protocol === undefined) return { status: 'off', reason: 'missing' }
    if (!protocol.enabled) return { status: 'off', reason: 'disabled' }
    if (protocol.pausedUntil !== null && protocol.pausedUntil > now) {
      return { status: 'off', reason: 'paused' }
    }
    const stored = runs.findByTrigger(protocol.id, input.triggerRef)
    if (stored !== undefined) return { status: 'exists', run: stored }

    const version = loadVersion(protocols, protocol.id, protocol.version)
    if (version === undefined) return { status: 'off', reason: 'missing' }
    const { definition } = version
    // the person a new run acts for: the owner found now (a `keith`-owned protocol follows an ownership transfer at its
    // next start); a person-owned protocol acts for its owner
    const runPerson =
      protocol.owner === KEITH_OWNER ? (input.person ?? (await ownerOf())) : protocol.owner
    if (runPerson === '') return { status: 'off', reason: 'no-owner' }
    const later = input.startAt !== undefined && input.startAt > now
    // conditions decide at the start, never at a later wait (a later check is a condition branch or `cancelWhen`)
    const holds = later ? true : await conditionsHold(definition, runPerson)
    const status: RunStatus = later ? 'waiting' : holds ? 'running' : 'skipped'

    const created = runs.start(
      {
        id: runIdFor(protocol.id, input.triggerRef),
        protocolId: protocol.id,
        version: protocol.version,
        person: runPerson,
        triggerRef: input.triggerRef,
        step: status === 'skipped' ? null : definition.start,
        status,
        wakeAt: later && input.startAt !== undefined ? input.startAt : null,
        ...(status === 'skipped' ? { endedAt: now } : {}),
      },
      now,
      { since: utcDayStart(now), max: definition.limits.maxRunsPerDay },
    )
    if (created.status === 'exists') return { status: 'exists', run: created.run }
    if (created.status === 'limit') {
      journal.audit('protocol.run.refused', {
        protocolId: protocol.id,
        reason: 'daily-limit',
        ...subjectOf(runPerson),
      })
      return { status: 'limit' }
    }

    const run = created.run
    const person = { personId: run.person }
    const base = { protocolId: protocol.id, runId: run.id, trigger: input.trigger }
    journal.audit('protocol.run.start', { ...base, status, ...subjectOf(run.person) })
    journal.event('brain.hypothalamus.fire', { ...base, ...person })
    if (status === 'skipped') {
      journal.audit('protocol.run.end', {
        protocolId: protocol.id,
        runId: run.id,
        status,
        ...subjectOf(run.person),
      })
      journal.event('brain.hypothalamus.end', { runId: run.id, status, ...person })
    }
    if (status === 'waiting') {
      watched.add(run.id)
      journal.event('brain.hypothalamus.wait', {
        runId: run.id,
        wakeAt: run.wakeAt ?? now,
        ...person,
      })
    }
    if (status === 'running') await safeDrive(run)
    return { status: 'created', run: runs.get(run.id) ?? run }
  }

  async function tick(): Promise<TickOutcome> {
    if (ticking) return { claimed: 0, cancelled: 0, skipped: true }
    ticking = true
    try {
      let cancelled = 0
      for (const id of [...watched]) {
        const run = runs.get(id)
        if (run === undefined || run.status !== 'waiting') {
          watched.delete(id)
          continue
        }
        if (await driver.cancelIfWhen(run)) {
          watched.delete(id)
          cancelled++
        }
      }
      const due = runs.claimDue(clock.now(), tickLimit)
      for (const run of due) await safeDrive(run)
      return { claimed: due.length, cancelled, skipped: false }
    } finally {
      ticking = false
    }
  }

  function watchWaiting(waiting: readonly RunRecord[]): void {
    for (const run of waiting) {
      const version = loadVersion(protocols, run.protocolId, run.version)
      if (version?.definition.limits.cancelWhen !== undefined) watched.add(run.id)
    }
  }

  async function recover(): Promise<RecoverReport> {
    const waiting = runs.inStatus('waiting')
    watchWaiting(waiting)
    const running = runs.inStatus('running')
    for (const run of running) await safeDrive(run)
    return { waiting: waiting.length, resumed: running.length }
  }

  return {
    start,
    recover,
    tick,
    answer: driver.answer,
    watched,
    watchWaiting,
  }
}

/**
 * The engine as the triggers' start port (`RunStarter`). The trigger's detail says what fired (`kind`, for the fire
 * record) and, for an `event` with `afterMs` or `until`, when the run's first step may start (`wakeAt`): the run is then
 * created `waiting` until then. A start without detail is refused: every trigger sends one.
 */
export function createRunStarter(engine: Pick<ProtocolEngine, 'start'>): RunStarter {
  return {
    async start(input: RunStartInput): Promise<RunStartOutcome> {
      const detail = input.detail
      if (detail === undefined) return 'refused'
      const startAt = detail.kind === 'event' ? detail.wakeAt : undefined
      const outcome = await engine.start({
        protocolId: input.protocolId,
        trigger: detail.kind,
        triggerRef: input.ref,
        ...(startAt === undefined ? {} : { startAt }),
        ...(detail.kind === 'event' && detail.personId !== undefined
          ? { person: detail.personId }
          : {}),
      })
      if (outcome.status === 'created') return 'started'
      if (outcome.status === 'exists') return 'duplicate'
      return 'refused'
    },
  }
}
