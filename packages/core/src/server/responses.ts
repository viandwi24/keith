// HTTP error bodies (docs/contracts/protocol.md#http-endpoints): status + `{ error: { code, message } }`.

import type { ErrorCode, HttpErrorBody } from '@keith/protocol'

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_FRAME: 400,
  UNKNOWN_FRAME: 400,
  THREAD_BUSY: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
}

export function errorResponse(code: ErrorCode, message: string): Response {
  const body: HttpErrorBody = { error: { code, message } }
  return Response.json(body, { status: STATUS[code] })
}
