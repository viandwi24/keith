import { index, integer, sqliteTable, text } from '@keith/host/schema'

/**
 * The content of a note. Who may read or write it lives in the ACL (`resources`, kind `note`), never here:
 * `author_id` only records who wrote it first (the ACL owner can change when a person leaves).
 * The full-text index `plg_notes_fts` (FTS5) is created by the custom migration: a virtual table is not
 * something Drizzle can describe.
 */
export const notes = sqliteTable(
  'plg_notes_items',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('plg_notes_items_updated').on(t.updatedAt)],
)
