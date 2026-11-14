import type { Sqlite } from '../eh/sql.ts'

/**
 * Bring a P8 `people` row up to the P9 shape (the generated migration only adds columns with
 * defaults): the owner gets username `owner`, and `updated_at` is the creation time. Idempotent;
 * `migrateDatabase` runs it after the SQL migrations.
 */
export function backfillPeople(sqlite: Sqlite): void {
  sqlite.transaction(() => {
    sqlite
      .query("UPDATE people SET username = 'owner' WHERE id = 'owner' AND username IS NULL")
      .run()
    sqlite.query('UPDATE people SET updated_at = created_at WHERE updated_at = 0').run()
    // `left` was never written and is no longer a status: a denied person stays denied (ADR-0027 §26)
    sqlite.query("UPDATE people SET status = 'suspended' WHERE status = 'left'").run()
  })()
}
