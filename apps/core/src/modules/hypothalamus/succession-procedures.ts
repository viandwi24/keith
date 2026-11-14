// The `admin.succession` procedures (docs/specs/succession.md, "RPC"). The owner's calls (`setHeir`, `clearHeir`,
// `setWindow`, `pause`, `resume`) reach the service with the caller of the call; the gate already refused a non-owner
// (`succession.manage`) and a remote call without a step-up (`sensitive`), the service checks the owner role again. A
// `SuccessionError` becomes the RPC error of its code, with its machine reason in `data.reason`. `get` is decided here:
// the owner gets the owner view, the heir the heir view, anyone else NOT_FOUND.
//
// `claim` is the heir's call (succession.md, "The claim"): the service decides, a local-socket call is FORBIDDEN here.
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import type { SuccessionService, SuccessionStatus } from './succession.ts'
import { GRACE_MS, isActive, SuccessionError } from './succession-shared.ts'

export interface SuccessionProcedureDeps {
  service: SuccessionService
}

const callerOf = (context: RpcContext) => ({
  actor: context.principal.personId,
  via: context.via,
})

/** Runs a service call; a refusal leaves as the RPC error of its code and reason, any other error is not the caller's. */
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof SuccessionError) {
      throw new ORPCError(error.code, {
        message: error.message,
        data: { reason: error.reason },
      })
    }
    throw error
  }
}

/** The owner view (succession.md, "RPC"): the heir, the window, the pause, the run and the owner's last sign. */
function ownerView(status: SuccessionStatus) {
  return {
    role: 'owner' as const,
    state: status.run.state,
    heir: status.heir,
    windowDays: status.settings.windowDays,
    pausedUntil: status.settings.pausedUntil,
    lastSignAt: status.lastSignAt,
    runId: status.run.runId,
    startedAt: status.run.startedAt,
    graceStartedAt: status.run.graceStartedAt,
    claimableAt: status.run.claimableAt,
  }
}

/**
 * The heir of a run: the heir in force, or the heir of a run that is still active (a run keeps its heir until it ends).
 * A former heir of an ended run is not one.
 */
function isHeirOf(status: SuccessionStatus, personId: string): boolean {
  if (status.settings.heir === personId) return true
  return isActive(status.run.state) && status.run.heir === personId
}

/**
 * The heir view (succession.md, "RPC"): the state, the claim date and when the claim opens, never the owner's presence.
 * `claimOpensAt` is the grace's end (`graceStartedAt` + the grace length, the same constant the ladder waits for) in
 * `grace`, `claimableAt` in `claimable`, and null otherwise.
 */
export function heirViewOf(status: Pick<SuccessionStatus, 'run'>) {
  const { run } = status
  const claimOpensAt =
    run.state === 'grace' && run.graceStartedAt !== null
      ? run.graceStartedAt + GRACE_MS
      : run.state === 'claimable'
        ? run.claimableAt
        : null
  return {
    role: 'heir' as const,
    state: run.state,
    claimableAt: run.claimableAt,
    claimOpensAt,
  }
}

export function successionProcedures(deps: SuccessionProcedureDeps) {
  const { service } = deps
  return {
    get: rpc.admin.succession.get.handler(async ({ context }) => {
      const status = await service.status()
      if (context.principal.role === 'owner') return ownerView(status)
      if (status.owner !== null && isHeirOf(status, context.principal.personId))
        return heirViewOf(status)
      throw new ORPCError('NOT_FOUND', { message: 'there is no succession view for you' })
    }),
    setHeir: rpc.admin.succession.setHeir.handler(async ({ input, context }) => {
      await refusing(() => service.setHeir(input.person, callerOf(context)))
      return ownerView(await service.status())
    }),
    clearHeir: rpc.admin.succession.clearHeir.handler(async ({ context }) => {
      await refusing(() => service.clearHeir(callerOf(context)))
      return ownerView(await service.status())
    }),
    setWindow: rpc.admin.succession.setWindow.handler(async ({ input, context }) => {
      await refusing(() => service.setWindow(input.days, callerOf(context)))
      return ownerView(await service.status())
    }),
    pause: rpc.admin.succession.pause.handler(async ({ input, context }) => {
      await refusing(() => service.pause(input.until, callerOf(context)))
      return ownerView(await service.status())
    }),
    resume: rpc.admin.succession.resume.handler(async ({ context }) => {
      await refusing(() => service.resume(callerOf(context)))
      return ownerView(await service.status())
    }),
    // the heir's claim (succession.md, "The claim"): the service checks the heir, the state, the grace and the owner's sign;
    // the gate checked the step-up. The local socket serves the implicit owner, so it is refused here (FORBIDDEN).
    claim: rpc.admin.succession.claim.handler(({ context }) =>
      refusing(() => service.claim(callerOf(context))),
    ),
  }
}

export type SuccessionProcedures = ReturnType<typeof successionProcedures>
