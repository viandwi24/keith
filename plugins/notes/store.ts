import type { KeithCtx } from '@keith/host'
import { sql, z } from '@keith/host/schema'

/** The ACL kind of a note (a leaf: `r` reads, `w` edits). */
export const KIND = 'note'
export const TITLE_MAX = 200
export const BODY_MAX = 20_000
/** Notes one person may have written (a seatbelt against a runaway loop, not a quota). */
export const NOTES_PER_AUTHOR_MAX = 2_000

export const NoteSummary = z.object({
  id: z.string(),
  title: z.string(),
  /** The author's name, or `you` for the caller's own notes. */
  by: z.string(),
  mine: z.boolean(),
  updatedAt: z.number(),
})
export type NoteSummary = z.infer<typeof NoteSummary>

export interface NoteRow {
  id: string
  authorId: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

type Db = KeithCtx['db']
type Row = Record<string, unknown>

const toRow = (r: Row): NoteRow => ({
  id: String(r.id),
  authorId: String(r.author_id),
  title: String(r.title),
  body: String(r.body),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})

/** The ids go in as one JSON array parameter: no limit on how many a person can see, no string-built SQL. */
const idsParam = (ids: readonly string[]): string => JSON.stringify(ids)

export function insertNote(db: Db, row: NoteRow): void {
  db.run(
    sql`INSERT INTO plg_notes_items (id, author_id, title, body, created_at, updated_at) VALUES (${row.id}, ${row.authorId}, ${row.title}, ${row.body}, ${row.createdAt}, ${row.updatedAt})`,
  )
  indexNote(db, row.id, row.title, row.body)
}

export function indexNote(db: Db, id: string, title: string, body: string): void {
  db.run(sql`DELETE FROM plg_notes_fts WHERE id = ${id}`)
  db.run(sql`INSERT INTO plg_notes_fts (id, title, body) VALUES (${id}, ${title}, ${body})`)
}

export function updateNote(
  db: Db,
  id: string,
  title: string,
  body: string,
  updatedAt: number,
): void {
  db.run(
    sql`UPDATE plg_notes_items SET title = ${title}, body = ${body}, updated_at = ${updatedAt} WHERE id = ${id}`,
  )
  indexNote(db, id, title, body)
}

export function deleteNote(db: Db, id: string): void {
  db.run(sql`DELETE FROM plg_notes_items WHERE id = ${id}`)
  db.run(sql`DELETE FROM plg_notes_fts WHERE id = ${id}`)
}

export function getNote(db: Db, id: string): NoteRow | undefined {
  const r = db.all<Row>(sql`SELECT * FROM plg_notes_items WHERE id = ${id}`)[0]
  return r === undefined ? undefined : toRow(r)
}

export function countByAuthor(db: Db, authorId: string): number {
  return Number(
    db.all<Row>(sql`SELECT count(*) AS n FROM plg_notes_items WHERE author_id = ${authorId}`)[0]
      ?.n ?? 0,
  )
}

/** The notes whose id is in `visible` (what the actor may read), newest first. The filter comes before the limit and the count. */
export function listVisible(
  db: Db,
  visible: readonly string[],
  limit: number,
  offset: number,
): { rows: NoteRow[]; total: number } {
  if (visible.length === 0) return { rows: [], total: 0 }
  const ids = idsParam(visible)
  const total = Number(
    db.all<Row>(
      sql`SELECT count(*) AS n FROM plg_notes_items WHERE id IN (SELECT value FROM json_each(${ids}))`,
    )[0]?.n ?? 0,
  )
  const rows = db
    .all<Row>(
      sql`SELECT * FROM plg_notes_items WHERE id IN (SELECT value FROM json_each(${ids}))
          ORDER BY updated_at DESC, id LIMIT ${limit} OFFSET ${offset}`,
    )
    .map(toRow)
  return { rows, total }
}

/** Words of a person's query as a safe FTS5 expression: every word quoted (no operators), all of them required. */
export function ftsQuery(query: string): string | undefined {
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8)
  if (words === undefined || words.length === 0) return undefined
  return words.map((w) => `"${w}"`).join(' ')
}

/**
 * Full-text search restricted to `visible` **inside the query**, so ranking, the limit and the snippet only ever
 * see notes the actor may read. The score is used for the order and never returned.
 */
export function searchVisible(
  db: Db,
  visible: readonly string[],
  query: string,
  limit: number,
): Array<{ row: NoteRow; snippet: string }> {
  const match = ftsQuery(query)
  if (match === undefined || visible.length === 0) return []
  const rows = db.all<Row>(
    sql`SELECT n.*, snippet(plg_notes_fts, -1, '', '', '...', 16) AS snippet
        FROM plg_notes_fts f JOIN plg_notes_items n ON n.id = f.id
        WHERE plg_notes_fts MATCH ${match} AND f.id IN (SELECT value FROM json_each(${idsParam(visible)}))
        ORDER BY bm25(plg_notes_fts), n.id LIMIT ${limit}`,
  )
  return rows.map((r) => ({ row: toRow(r), snippet: String(r.snippet ?? '') }))
}

/** `by` and `mine` for a result row; names are looked up once per author. */
export async function summarize(k: KeithCtx, rows: readonly NoteRow[]): Promise<NoteSummary[]> {
  const me = k.actor.personId
  const names = new Map<string, string>()
  for (const id of new Set(rows.map((r) => r.authorId))) {
    // a guest is told no one's name: a public note says only that it has an author
    if (k.actor.kind === 'guest') names.set(id, 'the author')
    else names.set(id, id === me ? 'you' : ((await k.people.name(id)) ?? 'someone who left'))
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    by: names.get(r.authorId) ?? 'someone',
    mine: r.authorId === me,
    updatedAt: r.updatedAt,
  }))
}
