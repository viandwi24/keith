import type { HarnessLogger } from 'eharness'

/** Which session a log line is about: the random id and the address hash, never anything the visitor sent. */
export interface GuestLogContext {
  guestSession: string
  ipHash: string
}

const CODE = /\b(?:E|W|EH)_[A-Z0-9_]{2,60}\b|\bGUEST_[A-Z0-9_]{2,40}\b/

/**
 * The logger of one guest session's agent (docs/specs/logging.md, guests): it writes `{ code, guestSession, ipHash }`
 * and nothing else. The message text and every other field of eharness' own lines are dropped (a hook error or a
 * provider error can quote what the visitor wrote), and `debug` and `info` are not written at all. A line without a
 * recognisable code is logged as `GUEST_AGENT_EVENT`.
 */
export function createGuestLogger(base: HarnessLogger, context: GuestLogContext): HarnessLogger {
  const line =
    (level: 'warn' | 'error') =>
    (message: string, data?: Record<string, unknown>): void => {
      const fromData = typeof data?.code === 'string' ? CODE.exec(data.code)?.[0] : undefined
      const code = fromData ?? CODE.exec(message)?.[0] ?? 'GUEST_AGENT_EVENT'
      base[level]('guest agent', {
        code,
        guestSession: context.guestSession,
        ipHash: context.ipHash,
      })
    }
  return { debug: () => undefined, info: () => undefined, warn: line('warn'), error: line('error') }
}
