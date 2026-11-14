// InboxAdapter: `eh_inbox` and `eh_inbox_keys` of `eharness/sqlite` (same tables and columns as
// Keith's migrations; ADR-0012).

import type { InboxAdapter } from 'eharness'
import { sqliteInbox as packageInbox } from 'eharness/sqlite'
import { driverOf } from './driver.ts'
import type { Sqlite } from './sql.ts'

export interface SqliteInboxOptions {
  /** Dedupe horizon after the ack (ms). Default 24 hours, the minimum the spec asks for. */
  dedupeWindowMs?: number
}

/**
 * The package adapter without its polling `subscribe`: Keith's holder polls the inbox itself
 * (`inbox.pollMs`), as it did before the package, so the wake-up behavior does not change.
 */
export function sqliteInbox(sqlite: Sqlite, options: SqliteInboxOptions = {}): InboxAdapter {
  const { subscribe: _subscribe, ...adapter } = packageInbox(driverOf(sqlite), options)
  return adapter
}
