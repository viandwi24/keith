import { index, integer, sqliteTable, text } from '../../../schema.ts'

export const items = sqliteTable(
  'plg_alpha_items',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    done: integer('done').notNull().default(0),
  },
  (t) => [index('plg_alpha_items_title').on(t.title)],
)
