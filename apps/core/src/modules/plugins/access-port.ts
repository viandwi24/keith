import {
  type AccessCaller,
  type AccessPort,
  type AclWriteAudit,
  GuardError,
  OperationError,
} from '@keith/host'
import { type AccessService, AclAdminError } from '../acl/index.ts'
import type { AclAudit } from '../audit/index.ts'

/** Maps the access service's refusals to what an operation shows: `NOT_FOUND` stays the one standard refusal. */
function mapped(error: unknown): never {
  if (error instanceof AclAdminError) {
    if (error.code === 'NOT_FOUND') throw new GuardError('NOT_FOUND', 'access')
    if (error.code === 'FORBIDDEN') throw new OperationError('FORBIDDEN', error.message)
    if (error.code === 'CONFLICT') throw new OperationError('CONFLICT', error.message)
    if (error.code === 'STEP_UP') throw new OperationError('FORBIDDEN', error.message)
    throw new OperationError('INVALID_INPUT', error.message)
  }
  throw error
}

/**
 * The host's `AccessPort` over the core's access service (the one behind `acl.share` and `keith-core acl`).
 * A resource-level refusal (the resource is missing or not visible, or it is not theirs to change) is counted
 * as `acl.deny` through the ACL audit. Function-level refusals (an unknown kind, a guest) stay `plugin.denied`,
 * written by the guard.
 */
export function createAccessPort(
  access: AccessService,
  audit: Pick<AclAudit, 'denied'>,
): AccessPort {
  const run = async <T>(caller: AccessCaller, kind: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      if (
        error instanceof AclAdminError &&
        (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')
      )
        audit.denied(caller, kind)
      return mapped(error)
    }
  }
  return {
    show: (caller, ref) => run(caller, ref.kind, () => access.show(caller, ref)),
    share: (caller, input) => run(caller, input.kind, () => access.share(caller, input)),
    unshare: (caller, input) => run(caller, input.kind, () => access.unshare(caller, input)),
  }
}

/** The plugins' own resource writes as `acl.create` and `acl.remove` rows (`k.acl`, docs/specs/acl.md). */
export function createPluginAclAudit(audit: Pick<AclAudit, 'record'>): AclWriteAudit {
  return {
    created: (caller, r) =>
      audit.record('acl.create', caller, {
        kind: r.kind,
        id: r.id,
        owner: r.owner,
        mode: r.mode,
        resourceOwner: r.owner,
      }),
    removed: (caller, r) =>
      audit.record('acl.remove', caller, { kind: r.kind, id: r.id, resourceOwner: r.owner }),
  }
}
