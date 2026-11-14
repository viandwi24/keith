// ScheduleStore from `eharness/sqlite` on `eh_schedules` (same table and columns as Keith's migration 0012;
// compared against `schemaSql` in `schedules.test.ts`). The scheduler itself lives in apps/core.
import type { ScheduleStore } from 'eharness/scheduler'
import { sqliteScheduleStore } from 'eharness/sqlite'
import { driverOf } from './driver.ts'
import type { Sqlite } from './sql.ts'

export function sqliteSchedules(sqlite: Sqlite): ScheduleStore {
  return sqliteScheduleStore(driverOf(sqlite))
}
