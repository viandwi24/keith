import { z } from 'zod'

/** Error codes carried by `error` frames and HTTP error bodies. See docs/contracts/protocol.md#error-codes. */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_REQUEST',
  'INVALID_FRAME',
  'UNKNOWN_FRAME',
  'THREAD_BUSY',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'INTERNAL',
] as const

export const ErrorCode = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCode>

/** HTTP error body: `{ error: { code, message } }`. */
export const HttpErrorBody = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
})
export type HttpErrorBody = z.infer<typeof HttpErrorBody>

/** WebSocket close codes used by the core. */
export const WS_CLOSE_CODES = {
  /** No `hello` within 5 s of the upgrade. */
  helloTimeout: 4001,
  /** Invalid or expired token. */
  invalidToken: 4003,
  /** `hello.protocol` or the envelope `v` is not 1. */
  unsupportedProtocol: 4009,
  /** No frame from the node for 60 s. */
  heartbeatTimeout: 4010,
} as const

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES]
