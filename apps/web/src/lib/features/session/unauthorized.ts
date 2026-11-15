/** A 401 from the core (an eharness HTTP error or an oRPC `UNAUTHORIZED`): the credential is gone. Same rule as the TUI's. */
export const isUnauthorized = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { status?: number }).status === 401 ||
    (error as { code?: string }).code === 'UNAUTHORIZED')
