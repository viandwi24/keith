/**
 * A refused groups or access operation; procedures map the code to an oRPC error. `NOT_FOUND` is the one
 * answer for a missing and a denied resource (docs/specs/acl.md, "Not found"), so its message never varies.
 */
export type AclAdminCode = 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'CONFLICT' | 'STEP_UP'

export class AclAdminError extends Error {
  constructor(
    readonly code: AclAdminCode,
    message: string,
  ) {
    super(message)
    this.name = 'AclAdminError'
  }
}

export const NOT_FOUND_MESSAGE = 'not found'
