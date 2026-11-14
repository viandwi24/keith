/**
 * Errors of the ACL layer. The message never names an id, a kind or a person: a refusal reads the
 * same whether the resource is denied or missing (docs/specs/acl.md, "Not found").
 */
export type AclErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'CONFLICT'

export class AclError extends Error {
  readonly code: AclErrorCode
  constructor(code: AclErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGE[code])
    this.name = 'AclError'
    this.code = code
  }
}

const DEFAULT_MESSAGE: Record<AclErrorCode, string> = {
  NOT_FOUND: 'not found',
  FORBIDDEN: 'forbidden',
  INVALID: 'invalid access data',
  CONFLICT: 'conflict',
}
