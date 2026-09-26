// files repository: metadata of uploaded files. The bytes live in `KEITH_HOME/files/`, written by
// the server; this table only records them (docs/architecture/storage.md).

import { eq } from 'drizzle-orm'
import type { Orm } from './orm.ts'
import { files } from './schema.ts'
import type { FileRecord, FilesRepository } from './types.ts'

export function createFilesRepository(db: Orm): FilesRepository {
  return {
    async create(f) {
      db.insert(files).values(f).run()
    },
    async get(id) {
      const row = db.select().from(files).where(eq(files.id, id)).get()
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        path: row.path,
        mime: row.mime,
        size: row.size,
        ownerPersonId: row.ownerPersonId,
        createdAt: row.createdAt,
      } satisfies FileRecord
    },
  }
}
