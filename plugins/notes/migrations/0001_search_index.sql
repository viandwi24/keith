-- Custom SQL migration (drizzle-kit generate --custom): the full-text index of the notes. A virtual table is not
-- something Drizzle can describe, so it is written here; the host accepts exactly this shape (create virtual table
-- plg_<id>_... using fts5) in a plugin migration. `id` is stored, not indexed; the operations keep the index in step.
CREATE VIRTUAL TABLE `plg_notes_fts` USING fts5(id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
