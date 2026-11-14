// MessageAdapter and StateAdapter: `eh_messages` and `eh_state` of `eharness/sqlite` (same
// tables and columns as Keith's migrations; ADR-0012).

import type { MessageAdapter, StateAdapter } from 'eharness'
import { sqliteMessages as packageMessages, sqliteState as packageState } from 'eharness/sqlite'
import { driverOf } from './driver.ts'
import type { Sqlite } from './sql.ts'

export const sqliteMessages = (sqlite: Sqlite): MessageAdapter => packageMessages(driverOf(sqlite))

export const sqliteState = (sqlite: Sqlite): StateAdapter => packageState(driverOf(sqlite))
