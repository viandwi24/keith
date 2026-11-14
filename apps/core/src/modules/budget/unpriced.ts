// Models that spent with no catalog price (ADR-0027 §23). The budget counts their cost as 0, so the
// owner must see them: this set answers `budget.get` and the doctor reads the roles on its own.

/** The eharness warning for a model with no price (`W_MODEL_UNPRICED`, `details.model`). */
export const UNPRICED_CODE = 'W_MODEL_UNPRICED'

/** Refs of models that spent without a price since this process booted. */
export interface Unpriced {
  /** Record one model ref; a second warning for the same ref adds nothing. */
  note(ref: string): void
  /** The refs noted so far, sorted. */
  list(): string[]
}

export function createUnpriced(): Unpriced {
  const refs = new Set<string>()
  return {
    note(ref) {
      refs.add(ref)
    },
    list() {
      return [...refs].sort()
    },
  }
}

/** The model ref of an eharness `W_MODEL_UNPRICED` warning's data, else undefined. */
export function unpricedRefOf(data: Record<string, unknown> | undefined): string | undefined {
  if (data?.code !== UNPRICED_CODE) return undefined
  const details = data.details
  const fromDetails =
    details !== null && typeof details === 'object'
      ? (details as Record<string, unknown>).model
      : undefined
  const model = data.model ?? fromDetails
  return typeof model === 'string' && model !== '' ? model : undefined
}

/** The eharness logger interface (debug, info, warn, error over message and data). */
export interface HarnessLoggerLike {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/**
 * Wrap the harness logger so an unpriced warning is noted in `unpriced` on its way to the log. The
 * warning is still logged unchanged.
 */
export function routeUnpriced<L extends HarnessLoggerLike>(inner: L, unpriced: Unpriced): L {
  const note = (data: Record<string, unknown> | undefined): void => {
    const ref = unpricedRefOf(data)
    if (ref !== undefined) unpriced.note(ref)
  }
  return {
    debug: (message, data) => inner.debug(message, data),
    info: (message, data) => {
      note(data)
      inner.info(message, data)
    },
    warn: (message, data) => {
      note(data)
      inner.warn(message, data)
    },
    error: (message, data) => {
      note(data)
      inner.error(message, data)
    },
  } as L
}
