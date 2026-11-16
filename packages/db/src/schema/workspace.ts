// The workspace of each person (ADR-0037, docs/specs/workspace.md): one versioned JSON document of desktops and windows. A
// missing row is the empty workspace at version 0. No foreign key: a removed person's row follows the removal registry.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable('workspaces', {
  personId: text('person_id').primaryKey(),
  version: integer('version').notNull(),
  /** JSON of `WorkspaceDoc` (`@keith/contracts`), validated by the core on write and on read. */
  doc: text('doc').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
