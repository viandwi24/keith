import { sqliteTable, text } from '../../../schema.ts'

// A table outside `plg_stray_*`: `plugin:db:generate` must refuse this schema.
export const stray = sqliteTable('people_copy', { id: text('id').primaryKey() })
