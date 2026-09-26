/**
 * `@keith/client/testing`: test helpers for every client built on `@keith/client`. Bun-only (the
 * fake core uses `Bun.serve`), so it is never imported from browser code.
 */
export * from './fake-core.ts'
export * from './wait.ts'
