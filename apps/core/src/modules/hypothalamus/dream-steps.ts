// The `dreaming.run` system step (docs/specs/dreaming.md, "Scheduling"; ADR-0031 §6): the one coded action of the built-in `dream`
// protocol. It runs the cadence gate (`too-soon`: the latest non-skipped run started within 20 hours), the schedule's
// `few-messages` gate (fewer than 5 new user messages since the cursor: no model call), then the run service. The model is never
// the scheduler (ADR-0024); this file only maps the run's outcome to the step's outcome. It names the run service by its shape,
// so hypothalamus does not import the hippocampus.
import type { DreamTrigger } from '@keith/contracts'
import type { StepResult, StepRunInput } from './ports.ts'

/** The action the built-in `dream` holds (`authoring.ts` allows it for `dream` only). */
export const DREAMING_RUN = 'dreaming.run' as const
/** A schedule run starts only with at least this many new user messages (ADR-0031 §6). */
export const FEW_MESSAGES_MIN = 5

/** The part of the dreaming run service the step uses (`hippocampus/dream/service.ts` satisfies it). */
export interface DreamingRunPort {
  run(personId: string, trigger: DreamTrigger): Promise<{ status: string; reason: string | null }>
  skip(
    personId: string,
    trigger: DreamTrigger,
    reason: 'too-soon' | 'few-messages',
  ): Promise<unknown>
  isTooSoon(personId: string): boolean
  pendingUserMessages(personId: string): number
}

/**
 * The step outcome of one dreaming run: `ok` for applied, staged and skipped runs (an empty pass is not a failure), `refused:<reason>`
 * for a refusal (`budget`, `no-model`, `off`), `failed:<reason>` for a failed one.
 */
export function outcomeOfRun(result: { status: string; reason: string | null }): string {
  if (result.status === 'refused') return `refused:${result.reason ?? 'refused'}`
  if (result.status === 'failed') return `failed:${result.reason ?? 'run'}`
  return 'ok'
}

/**
 * Runs one person's pass through the gates: `too-soon`, then (schedule only) `few-messages`, then the run service. The gates
 * answer before any model call. `manual` skips only the idle condition of the protocol (the caller's choice), never `too-soon`.
 */
export async function dreamingRunOutcome(
  service: DreamingRunPort,
  personId: string,
  trigger: DreamTrigger,
): Promise<string> {
  if (service.isTooSoon(personId)) {
    await service.skip(personId, trigger, 'too-soon')
    return 'refused:too-soon'
  }
  if (trigger === 'schedule' && service.pendingUserMessages(personId) < FEW_MESSAGES_MIN) {
    await service.skip(personId, trigger, 'few-messages')
    return 'refused:few-messages'
  }
  return outcomeOfRun(await service.run(personId, trigger))
}

/** The `system` handler of `dreaming.run`: the person is the run's person (the built-in is owned by one person). */
export function createDreamSteps(
  service: DreamingRunPort,
): (input: StepRunInput) => Promise<StepResult> {
  return async (input) => {
    const { step } = input
    if (step.kind !== 'system' || step.action !== DREAMING_RUN) {
      return { kind: 'done', outcome: 'failed:not-dreaming' }
    }
    const outcome = await dreamingRunOutcome(service, input.run.person, 'schedule')
    return { kind: 'done', outcome }
  }
}
