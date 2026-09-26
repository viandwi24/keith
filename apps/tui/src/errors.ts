/** Error codes of the TUI. The TUI can't import the core's `KeithError` (R-1), so it has its own. */
export type TuiErrorCode =
  | 'LOGIN_FAILED'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'CONFIG_INVALID'
  | 'INVALID_ARGS'
  | 'ABORTED'

export class TuiError extends Error {
  readonly code: TuiErrorCode

  constructor(code: TuiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TuiError'
    this.code = code
  }
}
