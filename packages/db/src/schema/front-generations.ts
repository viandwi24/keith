// The current front generation of each person who has reset their front context (docs/specs/chat-context.md, ADR-0030 §2,
// P34.2.1). A missing row means generation 0. No foreign key (as `tasks`): a removed person's row stays until the purge.
// The table is the source of truth; the in-memory map of modules/wernicke-broca/generations.ts is a cache of it.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The current generation of one person's front session chain (`front:<personId>:g<generation>`). */
export const frontGenerations = sqliteTable('front_generations', {
  personId: text('person_id').primaryKey(),
  generation: integer('generation').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
