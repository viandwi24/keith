/**
 * Error codes of `@keith/client`. Clients can't import the core's `KeithError` (R-1), so the
 * library has its own error class. Messages are written to be shown to the user as they are.
 */
export type ClientErrorCode =
  /** Wrong username or password, or another login refusal. */
  | 'LOGIN_FAILED'
  /** A bearer request got 401: the token is invalid or expired. Sign in again. */
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  /** Phase 5: the invite link is wrong, used or expired (`POST /v1/auth/invite` answered 401). */
  | 'INVITE_INVALID'
  /** The core refused the request body (400), e.g. a username someone else has. The message is the core's. */
  | 'INVALID_REQUEST'
  /** Any other non-2xx HTTP answer. */
  | 'HTTP_ERROR'
  /** The core could not be reached. */
  | 'NETWORK'
  /** The core answered with a body that does not match `@keith/protocol`. */
  | 'INVALID_RESPONSE'
  /** A base URL that is not http(s). */
  | 'INVALID_URL'
  | 'ABORTED'

export class ClientError extends Error {
  readonly code: ClientErrorCode

  constructor(code: ClientErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClientError'
    this.code = code
  }
}
