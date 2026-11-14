// Pure helpers of the run engine (docs/specs/hypothalamus.md, "Engine"): the run id of a trigger, the UTC day, the quiet
// window, who a recipient is, and the outcome class a branch reads. No I/O; the caller passes the clock's values.
import type { ProtocolDefinition, ProtocolStep } from '@keith/contracts'
import type { RunRecord } from '@keith/db'
import { KEITH_OWNER } from './authoring.ts'
import { inWindow, minutesOfDay } from './conditions.ts'
import { outcomeOfDelivery, type PersonActivity, type ProtocolDelivery } from './deliver-port.ts'
import type { StepResult, StepRunInput, StepRunner } from './ports.ts'

/** The recipient word of a person-owned protocol: the person the run acts for. */
export const OWNER_OF_RUN = 'owner-of-run'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/**
 * The run id of a trigger: a digest of the protocol and the trigger ref. A re-fire of the same trigger has the same id,
 * so the id itself is the start's dedupe key and the root of every delivery key (`<runId>:<stepId>:<visit>`).
 */
export function runIdFor(protocolId: string, triggerRef: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(`${protocolId}\n${triggerRef}`).digest('hex')
  return `run_${digest.slice(0, 32)}`
}

/** Epoch ms of the UTC midnight at or before `now`: the window of `maxRunsPerDay`. */
export function utcDayStart(now: number): number {
  return now - (((now % DAY_MS) + DAY_MS) % DAY_MS)
}

/** Who a step's recipient is: `owner-of-run` is the person the run acts for, anything else is a person id. */
export function recipientOf(to: string, run: Pick<RunRecord, 'person'>, ownerId: string): string {
  if (to !== OWNER_OF_RUN) return to
  // a keith-owned run has the instance owner as its person (the self layer reads as the owner, ADR-0020)
  return run.person === KEITH_OWNER ? ownerId : run.person
}

/**
 * The end of the quiet window when `now` is inside it, else undefined. A window across midnight (22:00 to 07:00) works
 * the same way. The result is the next `to` minute, never less than one minute ahead.
 */
export function quietEnd(
  now: number,
  quiet: { from: string; to: string } | undefined,
  timeZone: string,
): number | undefined {
  if (quiet === undefined) return undefined
  const minute = minutesOfDay(now, timeZone)
  if (!inWindow(minute, quiet.from, quiet.to)) return undefined
  const [hour = 0, mins = 0] = quiet.to.split(':').map(Number)
  const until = hour * 60 + mins
  const ahead = (((until - minute) % 1440) + 1440) % 1440 || 1440
  return now + ahead * MINUTE_MS
}

/** The step of a definition by id. */
export function stepById(definition: ProtocolDefinition, id: string): ProtocolStep | undefined {
  return definition.steps.find((step) => step.id === id)
}

/** Executions counted over every step of a run. */
export function totalVisits(visits: Readonly<Record<string, number>>): number {
  return Object.values(visits).reduce((sum, count) => sum + count, 0)
}

/** The class of a step outcome a branch reads: `ok`, or `failed` for every `failed:*`, `refused:*` and `unknown`. */
export function outcomeClass(outcome: string): 'ok' | 'failed' {
  return outcome === 'ok' ? 'ok' : 'failed'
}

/** What one `wake` turn is charged to its run and reserved from the person's budget (USD). */
export const WAKE_COST_USD = 0.02
/** The note a person gets once when a step does not run for want of budget (fixed text, no data). */
export const BUDGET_NOTICE = 'A protocol step did not run: its budget for this run is used up.'

export interface StepRunnerDeps {
  deliver: ProtocolDelivery
  people: PersonActivity
  budget: { remaining(personId: string): Promise<number> }
  /** The `act` steps (`act.ts`, P28.2.4). */
  act(input: StepRunInput): Promise<StepResult>
  /**
   * The `system` steps of the built-in succession protocol (P29.2.4). Absent, a `system` step is refused, so a run never
   * reaches a handler it was not given.
   */
  system?: (input: StepRunInput) => Promise<StepResult>
}

const SOURCE = (protocolId: string): string => `protocol:${protocolId}`

/**
 * The runner of the side-effecting steps (docs/specs/hypothalamus.md, "Advancing a step"): `notify` and `ask` are notes
 * through the delivery service, `wake` is a model turn of the step's person (the run's person, or the named one of a
 * `keith`-owned protocol), and `act` is handed to its own module. Every delivery id is the step's key, so a replay sends
 * nothing twice (the delivery service answers the stored outcome).
 */
export function createStepRunner(deps: StepRunnerDeps): StepRunner {
  const { deliver, people, budget } = deps

  async function notifyStep(
    input: StepRunInput,
    step: Extract<ProtocolStep, { kind: 'notify' }>,
  ): Promise<StepResult> {
    const to = recipientOf(step.to, input.run, input.ownerId)
    if (!(await people.isActive(to))) return { kind: 'done', outcome: 'refused:person-inactive' }
    const outcome = await deliver.deliver({
      id: input.key,
      source: SOURCE(input.run.protocolId),
      to,
      name: 'protocol.notify',
      text: step.text,
      needs: {
        mode: 'note',
        capabilities: step.needs ?? [],
        fanout: step.channels ?? 'best',
        urgency: step.urgent === true ? 'high' : 'normal',
      },
    })
    return { kind: 'done', outcome: outcomeOfDelivery(outcome) }
  }

  async function askStep(
    input: StepRunInput,
    step: Extract<ProtocolStep, { kind: 'ask' }>,
  ): Promise<StepResult> {
    const to = recipientOf(step.to, input.run, input.ownerId)
    if (!(await people.isActive(to))) return { kind: 'done', outcome: 'refused:person-inactive' }
    const outcome = await deliver.deliver({
      id: input.key,
      source: SOURCE(input.run.protocolId),
      to,
      name: 'protocol.ask',
      text: step.text,
      data: { runId: input.run.id, step: step.id, options: step.options ?? [] },
      needs: { mode: 'note', capabilities: [], fanout: step.channels ?? 'best', urgency: 'normal' },
    })
    // a queued question still waits: the delivery service retries it, and the answer is the deadline's business
    if (outcome.status === 'failed') return { kind: 'done', outcome: outcomeOfDelivery(outcome) }
    return { kind: 'open', timeoutMs: step.timeoutMs }
  }

  async function wakeStep(
    input: StepRunInput,
    step: Extract<ProtocolStep, { kind: 'wake' }>,
  ): Promise<StepResult> {
    const to = recipientOf(step.to, input.run, input.ownerId)
    if (!(await people.isActive(to))) return { kind: 'done', outcome: 'refused:person-inactive' }
    const runLeft = input.run.costUsd + WAKE_COST_USD <= input.definition.limits.budgetUsdPerRun
    if (!runLeft || (await budget.remaining(to)) < WAKE_COST_USD) {
      await tellOnce(input, to)
      return { kind: 'done', outcome: 'refused:budget' }
    }
    const outcome = await deliver.deliver({
      id: input.key,
      source: SOURCE(input.run.protocolId),
      to,
      name: 'protocol.wake',
      text: step.instruction,
      needs: {
        mode: 'wake',
        capabilities: [],
        fanout: 'best',
        urgency: step.urgent === true ? 'high' : 'normal',
      },
    })
    const result = outcomeOfDelivery(outcome)
    return result === 'ok'
      ? { kind: 'done', outcome: result, costUsd: WAKE_COST_USD }
      : { kind: 'done', outcome: result }
  }

  /** The budget notice: a note keyed by the step, so the person hears of it once per step of the run. */
  async function tellOnce(input: StepRunInput, to: string): Promise<void> {
    await deliver.deliver({
      id: `${input.run.id}:${input.step.id}:budget`,
      source: SOURCE(input.run.protocolId),
      to,
      name: 'protocol.notice',
      text: BUDGET_NOTICE,
      needs: { mode: 'note', capabilities: [], fanout: 'best', urgency: 'normal' },
    })
  }

  return {
    async run(input) {
      const { step } = input
      switch (step.kind) {
        case 'notify':
          return notifyStep(input, step)
        case 'ask':
          return askStep(input, step)
        case 'wake':
          return wakeStep(input, step)
        case 'act':
          return deps.act(input)
        case 'wait':
          return { kind: 'done', outcome: 'ok' }
        case 'system':
          return deps.system === undefined
            ? { kind: 'done', outcome: 'refused:no-handler' }
            : deps.system(input)
      }
    },
    async tell(input) {
      await deliver.deliver({
        id: input.key,
        source: 'protocol',
        to: input.to,
        name: 'protocol.notice',
        text: input.text,
        needs: { mode: 'note', capabilities: [], fanout: 'best', urgency: 'normal' },
      })
    },
  }
}
