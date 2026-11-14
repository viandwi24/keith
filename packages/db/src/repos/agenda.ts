// The `agenda_items` table (docs/specs/hypothalamus.md "Agenda", ADR-0025 §2): what a person will do and when. The repo
// stores items and answers the questions of the agenda and of presence (`busyAt`). Who may read or write an item is the
// service's rule (only the person, and the owner with an audit row); pruning of ended items is in retention.ts.
import { immediate, type Sqlite } from '../eh/sql.ts'

export type AgendaItemStatus = 'tentative' | 'confirmed' | 'done' | 'cancelled' | 'dismissed'

/** The span an item without `ends_at` counts for: busy, window overlap and retention (one hour from its start). */
export const AGENDA_DEFAULT_SPAN_MS = 3_600_000

export interface AgendaItemRecord {
  id: string
  person: string
  what: string
  startsAt: number
  endsAt: number | null
  place: string | null
  status: AgendaItemStatus
  sourceSession: string | null
  sourceMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface NewAgendaItem {
  id: string
  person: string
  what: string
  startsAt: number
  endsAt?: number | null
  place?: string | null
  status: AgendaItemStatus
  sourceSession?: string | null
  sourceMessage?: string | null
}

/** The fields an update may change; `null` clears a nullable field. */
export interface AgendaItemPatch {
  what?: string
  startsAt?: number
  endsAt?: number | null
  place?: string | null
  status?: AgendaItemStatus
}

export interface AgendaRepo {
  add(input: NewAgendaItem, at: number): AgendaItemRecord
  get(id: string): AgendaItemRecord | undefined
  /**
   * Applies the patch to one item and returns it; undefined when no item has the id. Read and write run in one
   * `BEGIN IMMEDIATE`, so a patch never overwrites a field it did not name.
   */
  update(id: string, patch: AgendaItemPatch, at: number): AgendaItemRecord | undefined
  /**
   * Items of a person that overlap `[from, to)`, earliest first. An item overlaps when it starts before `to` and ends
   * after `from` (an item without an end counts one hour). Any status is listed; a bound that is absent is open.
   */
  list(person: string, window?: { from?: number; to?: number }): AgendaItemRecord[]
  /** Confirmed items of a person that cover `at`. A tentative item never makes a person busy. */
  busyAt(person: string, at: number): AgendaItemRecord[]
}

interface Row {
  id: string
  person: string
  what: string
  starts_at: number
  ends_at: number | null
  place: string | null
  status: string
  source_session: string | null
  source_message: string | null
  created_at: number
  updated_at: number
}

const toItem = (r: Row): AgendaItemRecord => ({
  id: r.id,
  person: r.person,
  what: r.what,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  place: r.place,
  status: r.status as AgendaItemStatus,
  sourceSession: r.source_session,
  sourceMessage: r.source_message,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** The end an item counts for: `ends_at`, or one hour after its start. */
const SPAN = `coalesce(ends_at, starts_at + ${AGENDA_DEFAULT_SPAN_MS})`

export function agendaRepo(sqlite: Sqlite): AgendaRepo {
  const row = (id: string) =>
    sqlite.query<Row, [string]>('SELECT * FROM agenda_items WHERE id = ?').get(id)

  return {
    add(input, at) {
      sqlite
        .query(
          `INSERT INTO agenda_items (id, person, what, starts_at, ends_at, place, status, source_session,
             source_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.person,
          input.what,
          input.startsAt,
          input.endsAt ?? null,
          input.place ?? null,
          input.status,
          input.sourceSession ?? null,
          input.sourceMessage ?? null,
          at,
          at,
        )
      const created = row(input.id)
      if (created === null) throw new Error(`agenda_items: row ${input.id} vanished after insert`)
      return toItem(created)
    },
    get(id) {
      const r = row(id)
      return r === null ? undefined : toItem(r)
    },
    update(id, patch, at) {
      return immediate(sqlite, () => {
        const current = row(id)
        if (current === null) return undefined
        const next: AgendaItemRecord = { ...toItem(current), ...definedOnly(patch), updatedAt: at }
        sqlite
          .query(
            `UPDATE agenda_items SET what = ?, starts_at = ?, ends_at = ?, place = ?, status = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(next.what, next.startsAt, next.endsAt, next.place, next.status, at, id)
        return next
      })
    },
    list(person, window = {}) {
      const where = ['person = ?']
      const params: (string | number)[] = [person]
      if (window.to !== undefined) {
        where.push('starts_at < ?')
        params.push(window.to)
      }
      if (window.from !== undefined) {
        where.push(`${SPAN} > ?`)
        params.push(window.from)
      }
      return sqlite
        .query<Row, (string | number)[]>(
          `SELECT * FROM agenda_items WHERE ${where.join(' AND ')} ORDER BY starts_at, id`,
        )
        .all(...params)
        .map(toItem)
    },
    busyAt(person, at) {
      return sqlite
        .query<Row, [string, number, number]>(
          `SELECT * FROM agenda_items WHERE person = ? AND status = 'confirmed'
             AND starts_at <= ? AND ${SPAN} > ? ORDER BY starts_at, id`,
        )
        .all(person, at, at)
        .map(toItem)
    },
  }
}

/** The fields of a patch that are set (an absent key is kept; an explicit null clears). */
function definedOnly(patch: AgendaItemPatch): AgendaItemPatch {
  const out: AgendaItemPatch = {}
  for (const key of Object.keys(patch) as (keyof AgendaItemPatch)[]) {
    if (patch[key] !== undefined) (out as Record<string, unknown>)[key] = patch[key]
  }
  return out
}
