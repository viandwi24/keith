// memories repository with FTS5 search (docs/architecture/storage.md#memory-search-filter).

import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { Memory } from '../shared/types.ts'
import { definedOnly, type Orm } from './orm.ts'
import { memories } from './schema.ts'
import type { MemoriesRepository, MemoryFilter } from './types.ts'

/**
 * The FTS5 virtual table, created and kept in sync by triggers in the `memories-fts` migration.
 * Declared here (not in schema.ts) so drizzle-kit never tries to create it as a plain table.
 */
const memoriesFts = sqliteTable('memories_fts', {
  id: text('id').notNull(),
  content: text('content').notNull(),
})

/** `memory.recall` returns at most this many memories (docs/architecture/memory.md#recall). */
export const DEFAULT_SEARCH_LIMIT = 8

function toMemory(row: typeof memories.$inferSelect): Memory {
  return { ...row }
}

/**
 * The visibility condition from storage.md, as SQL:
 * (visibility='household' AND :allowHousehold) OR (visibility='owner' AND :allowOwner)
 *   OR (visibility='subject' AND subject_person_id = :subjectPersonId)
 *   OR (visibility='thread' AND thread_id IN (:threadIds))
 * Branches whose parameter can never match are left out. Returns undefined when no branch can
 * match, meaning the filter admits nothing.
 */
export function memoryFilterSql(filter: MemoryFilter): SQL | undefined {
  const branches: SQL[] = []
  if (filter.allowHousehold) branches.push(sql`${memories.visibility} = 'household'`)
  if (filter.allowOwner) branches.push(sql`${memories.visibility} = 'owner'`)
  if (filter.subjectPersonId !== null) {
    branches.push(
      sql`(${memories.visibility} = 'subject' and ${memories.subjectPersonId} = ${filter.subjectPersonId})`,
    )
  }
  if (filter.threadIds.length > 0) {
    branches.push(
      sql`(${memories.visibility} = 'thread' and ${inArray(memories.threadId, filter.threadIds)})`,
    )
  }
  return branches.length === 0 ? undefined : or(...branches)
}

/**
 * Turns free text into an FTS5 query: every word becomes a quoted term, joined with OR, so
 * punctuation and FTS5 operators in user text are never interpreted. Returns null for no words.
 */
export function toFtsQuery(text: string): string | null {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  if (words.size === 0) return null
  return [...words].map((w) => `"${w}"`).join(' OR ')
}

export function createMemoriesRepository(db: Orm): MemoriesRepository {
  return {
    async create(m) {
      db.insert(memories).values(m).run()
    },
    async get(id) {
      const row = db.select().from(memories).where(eq(memories.id, id)).get()
      return row ? toMemory(row) : null
    },
    async update(id, patch) {
      const set = definedOnly(patch)
      if (Object.keys(set).length === 0) return
      db.update(memories).set(set).where(eq(memories.id, id)).run()
    },
    async delete(id) {
      db.delete(memories).where(eq(memories.id, id)).run()
    },
    async search(text, filter, opts) {
      const query = toFtsQuery(text)
      const visible = memoryFilterSql(filter)
      if (query === null || visible === undefined) return []
      return db
        .select({ memory: memories })
        .from(memoriesFts)
        .innerJoin(memories, eq(memories.id, memoriesFts.id))
        .where(and(sql`${memoriesFts} match ${query}`, visible))
        .orderBy(sql`bm25(${memoriesFts})`, desc(memories.updatedAt), desc(memories.id))
        .limit(opts?.limit ?? DEFAULT_SEARCH_LIMIT)
        .all()
        .map((r) => toMemory(r.memory))
    },
    async list(filter, opts) {
      const visible = memoryFilterSql(filter)
      if (visible === undefined) return []
      const pinned = opts?.pinned
      const base = db
        .select()
        .from(memories)
        .where(and(visible, pinned === undefined ? undefined : eq(memories.pinned, pinned)))
        .orderBy(desc(memories.createdAt), desc(memories.id))
      const rows = opts?.limit === undefined ? base.all() : base.limit(opts.limit).all()
      return rows.map(toMemory)
    },
    async touchRecalled(ids, at) {
      if (ids.length === 0) return
      db.update(memories).set({ lastRecalledAt: at }).where(inArray(memories.id, ids)).run()
    },
  }
}
