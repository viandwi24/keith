/**
 * Error codes of the TUI itself (arguments, the session file). Protocol and HTTP errors are
 * `ClientError`s from `@keith/client`. The TUI can't import the core's `KeithError` (R-1).
 */
export type TuiErrorCode = 'CONFIG_INVALID' | 'INVALID_ARGS'

export class TuiError extends Error {
  readonly code: TuiErrorCode

  constructor(code: TuiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TuiError'
    this.code = code
  }
}
