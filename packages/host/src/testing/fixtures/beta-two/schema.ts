import { integer, sqliteTable, text } from '../../../schema.ts'

export const notes = sqliteTable('plg_beta_two_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
})
