// The `system` steps of the owner-absence protocol (docs/specs/succession.md, "The protocol", "States"): begin the grace,
// open the claim, and cancel. Coded here, never a plugin or a node (ADR-0024 §3). Each handler moves the one state row
// by compare-and-set and writes its audit row. Each is idempotent on its own state: a replayed step finds the state it
// wants and answers `ok` again. A step that finds another state fails and writes `owner.succession.refused`.
import type { StepResult, StepRunInput } from './ports.ts'
import { GRACE_MS, isActive, pausedUntilOf, type SuccessionDeps } from './succession-shared.ts'

const OK: StepResult = { kind: 'done', outcome: 'ok' }

export function createSuccessionSteps(
  deps: SuccessionDeps,
): (input: StepRunInput) => Promise<StepResult> {
  const { succession, audit, settings, now } = deps

  /** A refused step: the run fails, and the owner's audit keeps why. No subject: only the owner reads the row. */
  const refused = (action: string, state: string, reason: string): StepResult => {
    audit.record({
      kind: 'owner.succession.refused',
      actor: 'system',
      via: 'local',
      detail: { action, state, reason },
    })
    return { kind: 'done', outcome: `failed:${reason}` }
  }

  /** `check-in` to `grace`: the window ended with no sign. */
  const beginGrace = (input: StepRunInput): StepResult => {
    const at = now()
    const state = succession.get()
    if (state.runId === input.run.id && state.state === 'grace') return OK
    if (state.runId !== input.run.id || state.state !== 'check-in')
      return refused('succession.begin-grace', state.state, 'not-check-in')
    const moved = succession.transaction(() => {
      const ok = succession.move('check-in', 'grace', at, { graceStartedAt: at })
      if (ok)
        audit.record({
          kind: 'owner.succession.start',
          actor: 'system',
          via: 'local',
          detail: {
            heir: state.heir,
            startedAt: state.startedAt,
            graceStartedAt: at,
            owner: input.ownerId,
          },
        })
      return ok
    })
    return moved ? OK : refused('succession.begin-grace', state.state, 'state-moved')
  }

  /** `grace` to `claimable`: the grace period of seven days has ended with no sign. */
  const openClaim = (input: StepRunInput): StepResult => {
    const at = now()
    const state = succession.get()
    if (state.runId === input.run.id && state.state === 'claimable') return OK
    if (state.runId !== input.run.id || state.state !== 'grace')
      return refused('succession.open-claim', state.state, 'not-in-grace')
    if (state.graceStartedAt === null || at < state.graceStartedAt + GRACE_MS)
      return refused('succession.open-claim', state.state, 'grace-not-over')
    const moved = succession.transaction(() => {
      const ok = succession.move('grace', 'claimable', at, { claimableAt: at })
      if (ok)
        audit.record({
          kind: 'owner.succession.claimable',
          actor: 'system',
          via: 'local',
          detail: { heir: state.heir, claimableAt: at, owner: input.ownerId },
        })
      return ok
    })
    return moved ? OK : refused('succession.open-claim', state.state, 'state-moved')
  }

  /**
   * Any active state back to `idle`, after the engine's `cancelWhen` (a sign of the owner) ended the run. The engine
   * ends the run row itself, so this handler only moves the state and audits the cancel. A pause in force is named as
   * the reason; a sign in any other case.
   */
  const cancel = async (input: StepRunInput): Promise<StepResult> => {
    const at = now()
    const state = succession.get()
    if (state.runId !== input.run.id || !isActive(state.state)) return OK
    const paused = pausedUntilOf(settings)
    const sign = await deps.lastSign(input.ownerId)
    succession.transaction(() => {
      if (!succession.move(state.state, 'idle', at)) return
      audit.record({
        kind: 'owner.succession.cancel',
        actor: 'system',
        via: 'local',
        detail: {
          reason: paused !== null && paused > at ? 'paused' : 'owner-sign',
          sign,
          owner: input.ownerId,
          ...(state.heir === null ? {} : { heir: state.heir }),
        },
      })
    })
    return OK
  }

  return async (input) => {
    const step = input.step
    if (step.kind !== 'system') return { kind: 'done', outcome: 'failed:not-system' }
    switch (step.action) {
      case 'succession.begin-grace':
        return beginGrace(input)
      case 'succession.open-claim':
        return openClaim(input)
      case 'succession.cancel':
        return cancel(input)
      // `dreaming.run` is routed to `dream-steps.ts` by compose-protocols.ts and never reaches this handler
      case 'dreaming.run':
        return { kind: 'done', outcome: 'failed:not-wired' }
    }
  }
}
