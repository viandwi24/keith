export type GuardCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'INTERNAL'

/** The one text of every refusal that must not tell a hidden thing from a missing one. */
export const NOT_FOUND_MESSAGE = 'not found or not permitted'
const INTERNAL_MESSAGE = 'the operation failed'

/** HTTP status of each code (the core route maps with it). */
export const GUARD_STATUS: Record<GuardCode, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL: 500,
}

/**
 * What a caller of an operation sees when it does not run. `reason` says which guard step refused; it is for
 * the audit row and the log only: it is not enumerable and never part of the message.
 */
export class GuardError extends Error {
  readonly code: GuardCode
  readonly retryAfterMs: number | undefined
  declare readonly reason: string
  constructor(code: GuardCode, reason: string, message?: string, retryAfterMs?: number) {
    super(
      code === 'NOT_FOUND'
        ? NOT_FOUND_MESSAGE
        : code === 'INTERNAL'
          ? INTERNAL_MESSAGE
          : (message ?? code.toLowerCase()),
    )
    this.name = 'GuardError'
    this.code = code
    this.retryAfterMs = retryAfterMs
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false })
  }
}

/**
 * What an operation throws to give the caller a message. The plugin vouches that the text is safe to show
 * (no content of another person, no id, no secret). `NOT_FOUND` always shows the standard text.
 */
export class OperationError extends Error {
  readonly code: Exclude<GuardCode, 'RATE_LIMITED' | 'INTERNAL'>
  constructor(code: Exclude<GuardCode, 'RATE_LIMITED' | 'INTERNAL'>, message: string) {
    super(message)
    this.name = 'OperationError'
    this.code = code
  }
}
