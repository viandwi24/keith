// What a plugin writes its tables and queries with (`@keith/host/schema`): Drizzle's SQLite
// builders and operators, re-exported so a plugin imports only the host (check-imports).
export {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
export {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
export { z } from 'zod'
