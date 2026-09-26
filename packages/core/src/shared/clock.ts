import type { Clock } from './types.ts'

/** The real clock. Tests inject `createFakeClock()` from `@keith/sdk/testing` instead. */
export const systemClock: Clock = { now: () => Date.now() }
