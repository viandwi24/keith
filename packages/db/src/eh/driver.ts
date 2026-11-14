// One `eharness/sqlite` driver per bun:sqlite handle, so every adapter on a database shares a
// statement cache and the transaction nesting depth. The handle is opened by `openDatabase`
// (WAL, busy_timeout, foreign_keys), so the driver borrows it and keeps its pragmas.

import type { SqlDriver } from 'eharness/sqlite'
import { bunSqlite } from 'eharness/sqlite/bun'
import type { Sqlite } from './sql.ts'

const drivers = new WeakMap<Sqlite, SqlDriver>()

/** The shared driver of `sqlite`. */
export function driverOf(sqlite: Sqlite): SqlDriver {
  let driver = drivers.get(sqlite)
  if (driver === undefined) {
    driver = bunSqlite(sqlite)
    drivers.set(sqlite, driver)
  }
  return driver
}
