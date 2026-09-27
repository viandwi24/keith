/**
 * The central error code list (R-11). See docs/contracts/plugin-api.md#errors. New codes are an
 * additive contract change.
 */
export const KEITH_ERROR_CODES = [
  // Plugin host
  'PLUGIN_KIND_VIOLATION',
  'PLUGIN_NAMESPACE_INVALID',
  'SERVICE_MISSING',
  'SERVICE_CONFLICT',
  'CONFIG_INVALID',
  'TOOL_NAME_INVALID',
  'TOOL_NAME_TAKEN',
  'ROUTE_CONFLICT',
  // Tools
  'TOOL_INPUT_INVALID',
  'TOOL_TIMEOUT',
  'TIER_INSUFFICIENT',
  'TASK_LIMIT_REACHED',
  // Core
  'STORAGE_CORRUPT',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'INTERNAL',
] as const

export type KeithErrorCode = (typeof KEITH_ERROR_CODES)[number]

export type KeithErrorOptions = {
  cause?: unknown
  /** Structured, non-secret context for logs. */
  details?: Record<string, unknown>
}

/** The one error type Keith code throws (R-11). */
export class KeithError extends Error {
  readonly code: KeithErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: KeithErrorCode, message: string, options: KeithErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KeithError'
    this.code = code
    this.details = options.details
  }
}

/** True when `error` is a KeithError, optionally with the given code. */
export function isKeithError(error: unknown, code?: KeithErrorCode): error is KeithError {
  return error instanceof KeithError && (code === undefined || error.code === code)
}
