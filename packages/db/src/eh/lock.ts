// SessionLock from `eharness/sqlite` on `eh_locks` (same table and columns as Keith's migrations;
// ADR-0012). eharness 0.10+ passes `recovery.instanceId` as the owner of `acquire`, so a lease left
// by the previous run of this core is taken over at once without a flag.
import type { SessionLock } from 'eharness'
import { sqliteLock as packageLock } from 'eharness/sqlite'
import { driverOf } from './driver.ts'
import type { Sqlite } from './sql.ts'

export interface SqliteLockOptions {
  /** Lease length (ms). The holder renews it every third of it. Default 30 000. */
  leaseMs?: number
  /** Owner string of this instance. Default a random id. */
  owner?: string
}

export function sqliteLock(sqlite: Sqlite, options: SqliteLockOptions = {}): SessionLock {
  return packageLock(driverOf(sqlite), {
    ...(options.leaseMs === undefined ? {} : { ms: options.leaseMs }),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
  })
}
