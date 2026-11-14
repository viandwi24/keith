import type { Database } from 'bun:sqlite'

export type Sqlite = Database
export type Param = string | number | bigint | boolean | null | Uint8Array

/** Run `fn` as one write transaction that takes the write lock up front (`BEGIN IMMEDIATE`). */
export function immediate<T>(sqlite: Sqlite, fn: () => T): T {
  return sqlite.transaction(fn).immediate()
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',')
