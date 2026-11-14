import { type CapabilityRegistry, capabilitiesOf, KEITH_STEP_UP_REQUIRED } from '@keith/contracts'
import type { GrantsRepo } from '@keith/db'
import type { Principal } from './tokens.ts'

/**
 * What a principal may do right now: the role table plus the person's grants. Ids are strings since P16: the
 * core ids plus the ones plugins register at load (`CapabilityRegistry`).
 */
export interface Capabilities {
  of(principal: Principal): ReadonlySet<string>
}

/**
 * Role table ∪ grants, read per request (a grant or a role change applies to the next call). The
 * grants come from the database; the role is the one the credential check just loaded.
 */
export function createCapabilities(
  grants: Pick<GrantsRepo, 'list'>,
  registry?: CapabilityRegistry,
): Capabilities {
  return {
    of: (principal) => {
      const granted = grants.list(principal.personId)
      return registry === undefined
        ? capabilitiesOf(principal.role, granted)
        : registry.capabilitiesOf(principal.role, granted)
    },
  }
}

/** The role table only: for a principal without a grants store (tests that build one by hand). */
export const roleCapabilities: Capabilities = { of: (principal) => capabilitiesOf(principal.role) }

/** A legacy token has no PIN or password behind it, so it can never step up. */
export const LEGACY_STEP_UP_MESSAGE =
  'a legacy token cannot step up: replace it with `keith-core token create`'

/**
 * The refusal of a sensitive call (an oRPC procedure with `stepUp`, or answering a shell approval)
 * from a remote principal that has not stepped up; undefined when the call may go on. The local
 * socket is always elevated.
 */
export function stepUpDenial(
  principal: Principal,
  via: 'tcp' | 'local' = 'tcp',
): { code: typeof KEITH_STEP_UP_REQUIRED; message: string } | undefined {
  // the implicit owner of the socket has no credential and is always stepped up; a session credential
  // presented on the socket (`local trust: none`) steps up like on TCP
  if ((via === 'local' && principal.credential === undefined) || principal.elevated === true)
    return undefined
  return {
    code: KEITH_STEP_UP_REQUIRED,
    message:
      principal.credential?.kind === 'legacy'
        ? LEGACY_STEP_UP_MESSAGE
        : 'confirm with your PIN or password first (step-up)',
  }
}
