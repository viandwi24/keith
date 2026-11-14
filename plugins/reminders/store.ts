import type { KeithCtx, ScheduleFireCtx } from '@keith/host'
import { sql, z } from '@keith/host/schema'

export const KIND = 'reminder'
export const TEXT_MAX = 500
/** Active reminders one creator may have (the owner too: a seatbelt, not a quota). */
export const ACTIVE_PER_CREATOR_MAX = 50
/** Other people a member may have active reminders for. */
export const RECIPIENTS_PER_CREATOR_MAX = 10
/** Reminders of one creator that may fire in one hour; more are skipped and audited. */
export const FIRES_PER_HOUR_MAX = 20
export const HOUR_MS = 3_600_000
/** The text an owner sees of a reminder that is neither theirs nor for them: the line of the list (ADR-0027 §18). */
export const LINE_TEXT_MAX = 80

export const When = z.object({
  kind: z.enum(['once', 'cron']),
  at: z.number().nullable(),
  expr: z.string().nullable(),
})

export const ReminderOut = z.object({
  id: z.string(),
  text: z.string(),
  /** The creator's name (`you` for the caller). */
  by: z.string(),
  /** The recipient's name (`you` for the caller). */
  to: z.string(),
  mine: z.boolean(),
  forMe: z.boolean(),
  status: z.enum(['active', 'done', 'ended']),
  endedReason: z.string().nullable(),
  when: When,
  nextAt: z.number().nullable(),
  fireCount: z.number(),
})
export type ReminderOut = z.infer<typeof ReminderOut>

export interface ReminderRow {
  id: string
  creatorId: string
  recipientId: string
  text: string
  whenKind: 'once' | 'cron'
  whenAt: number | null
  whenExpr: string | null
  status: 'active' | 'done' | 'ended'
  endedReason: string | null
  lastSlot: number | null
  lastFireAt: number | null
  fireCount: number
  createdAt: number
  updatedAt: number
}

type Db = KeithCtx['db'] | ScheduleFireCtx['db']
type Raw = Record<string, unknown>
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const toRow = (r: Raw): ReminderRow => ({
  id: String(r.id),
  creatorId: String(r.creator_id),
  recipientId: String(r.recipient_id),
  text: String(r.text),
  whenKind: r.when_kind === 'cron' ? 'cron' : 'once',
  whenAt: num(r.when_at),
  whenExpr: r.when_expr === null ? null : String(r.when_expr),
  status: r.status === 'done' ? 'done' : r.status === 'ended' ? 'ended' : 'active',
  endedReason: r.ended_reason === null ? null : String(r.ended_reason),
  lastSlot: num(r.last_slot),
  lastFireAt: num(r.last_fire_at),
  fireCount: Number(r.fire_count ?? 0),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
})

export const insertReminder = (db: Db, r: ReminderRow): void =>
  void db.run(
    sql`INSERT INTO plg_reminders_items (id, creator_id, recipient_id, text, when_kind, when_at, when_expr, status, ended_reason, last_slot, last_fire_at, fire_count, created_at, updated_at)
        VALUES (${r.id}, ${r.creatorId}, ${r.recipientId}, ${r.text}, ${r.whenKind}, ${r.whenAt}, ${r.whenExpr}, ${r.status}, ${r.endedReason}, ${r.lastSlot}, ${r.lastFireAt}, ${r.fireCount}, ${r.createdAt}, ${r.updatedAt})`,
  )

export const getReminder = (db: Db, id: string): ReminderRow | undefined => {
  const r = db.all<Raw>(sql`SELECT * FROM plg_reminders_items WHERE id = ${id}`)[0]
  return r === undefined ? undefined : toRow(r)
}

export const setWhen = (
  db: Db,
  id: string,
  when: { kind: 'once' | 'cron'; at: number | null; expr: string | null },
  text: string,
  now: number,
): void =>
  void db.run(
    sql`UPDATE plg_reminders_items SET when_kind = ${when.kind}, when_at = ${when.at}, when_expr = ${when.expr}, text = ${text}, status = 'active', ended_reason = NULL, updated_at = ${now} WHERE id = ${id}`,
  )

export const endReminder = (
  db: Db,
  id: string,
  status: 'done' | 'ended',
  reason: string | null,
  now: number,
): void =>
  void db.run(
    sql`UPDATE plg_reminders_items SET status = ${status}, ended_reason = ${reason}, updated_at = ${now} WHERE id = ${id}`,
  )

export const markFired = (db: Db, id: string, slot: number, now: number, done: boolean): void =>
  void db.run(
    sql`UPDATE plg_reminders_items SET last_slot = ${slot}, last_fire_at = ${now}, fire_count = fire_count + 1, status = ${done ? 'done' : 'active'}, updated_at = ${now} WHERE id = ${id}`,
  )

export const activeOf = (db: Db, creatorId: string): ReminderRow[] =>
  db
    .all<Raw>(
      sql`SELECT * FROM plg_reminders_items WHERE creator_id = ${creatorId} AND status = 'active'`,
    )
    .map(toRow)

/** The reminders whose id is in `visible` (what the actor may read), newest first; the filter comes before the limit. */
export function listVisible(
  db: Db,
  visible: readonly string[],
  options: { creator?: string; recipient?: string; activeOnly: boolean; limit: number },
): ReminderRow[] {
  if (visible.length === 0) return []
  return db
    .all<Raw>(
      sql`SELECT * FROM plg_reminders_items
          WHERE id IN (SELECT value FROM json_each(${JSON.stringify(visible)}))
            AND (${options.creator ?? null} IS NULL OR creator_id = ${options.creator ?? null})
            AND (${options.recipient ?? null} IS NULL OR recipient_id = ${options.recipient ?? null})
            AND (${options.activeOnly ? 1 : 0} = 0 OR status = 'active')
          ORDER BY created_at DESC, id LIMIT ${options.limit}`,
    )
    .map(toRow)
}

/**
 * The instance owner reads a reminder between two other people only as a line (ADR-0027 §18): the time, the status and
 * the first characters of the text. The owner cannot read its full text, change it or delete it.
 */
export const ownerOnlyOf = (row: ReminderRow, k: KeithCtx): boolean =>
  k.actor.role === 'owner' &&
  row.creatorId !== k.actor.personId &&
  row.recipientId !== k.actor.personId

/** Names once per person (`you` for the caller), then the output shape. */
export async function present(k: KeithCtx, rows: readonly ReminderRow[]): Promise<ReminderOut[]> {
  const me = k.actor.personId
  const names = new Map<string, string>()
  const nameOf = async (id: string): Promise<string> => {
    const have = names.get(id)
    if (have !== undefined) return have
    const n = id === me ? 'you' : ((await k.people.name(id)) ?? 'someone who left')
    names.set(id, n)
    return n
  }
  const out: ReminderOut[] = []
  for (const r of rows) {
    const next = r.status === 'active' ? ((await k.schedule.get(r.id))?.nextFireAt ?? null) : null
    out.push({
      id: r.id,
      text: ownerOnlyOf(r, k) ? r.text.slice(0, LINE_TEXT_MAX) : r.text,
      by: await nameOf(r.creatorId),
      to: await nameOf(r.recipientId),
      mine: r.creatorId === me,
      forMe: r.recipientId === me,
      status: r.status,
      endedReason: r.endedReason,
      when: { kind: r.whenKind, at: r.whenAt, expr: r.whenExpr },
      nextAt: next,
      fireCount: r.fireCount,
    })
  }
  return out
}

/** How long a fire row is kept: the rate limit reads an hour of them, a restart reads the claimed ones (P25, F-021). */
export const FIRE_RETENTION_MS = 48 * HOUR_MS

export interface FireRow {
  fireId: string
  reminderId: string
  creatorId: string
  slot: number
  firedAt: number
  state: 'claimed' | 'accepted'
}

export const getFire = (db: Db, fireId: string): FireRow | undefined => {
  const r = db.all<Raw>(sql`SELECT * FROM plg_reminders_fires WHERE fire_id = ${fireId}`)[0]
  if (r === undefined) return undefined
  return {
    fireId: String(r.fire_id),
    reminderId: String(r.reminder_id),
    creatorId: String(r.creator_id),
    slot: Number(r.slot),
    firedAt: Number(r.fired_at),
    state: r.state === 'accepted' ? 'accepted' : 'claimed',
  }
}

export const insertFire = (db: Db, f: FireRow): void =>
  void db.run(
    sql`INSERT INTO plg_reminders_fires (fire_id, reminder_id, creator_id, slot, fired_at, state)
        VALUES (${f.fireId}, ${f.reminderId}, ${f.creatorId}, ${f.slot}, ${f.firedAt}, ${f.state})`,
  )

export const acceptFire = (db: Db, fireId: string): void =>
  void db.run(sql`UPDATE plg_reminders_fires SET state = 'accepted' WHERE fire_id = ${fireId}`)

export const deleteFire = (db: Db, fireId: string): void =>
  void db.run(sql`DELETE FROM plg_reminders_fires WHERE fire_id = ${fireId}`)

/** The last slot of a reminder, written in the same transaction as its fire row (ADR-0027 §16). */
export const setLastSlot = (db: Db, id: string, slot: number, now: number): void =>
  void db.run(
    sql`UPDATE plg_reminders_items SET last_slot = ${slot}, updated_at = ${now} WHERE id = ${id}`,
  )

/** Fires of one creator since `since` (claimed and accepted alike: a claimed one may still reach the model). */
export const countFiresSince = (db: Db, creatorId: string, since: number): number =>
  Number(
    db.all<Raw>(
      sql`SELECT COUNT(*) AS n FROM plg_reminders_fires WHERE creator_id = ${creatorId} AND fired_at >= ${since}`,
    )[0]?.n ?? 0,
  )

/** Deletes the fire rows fired before `before`; returns how many. */
export const pruneFires = (db: Db, before: number): number =>
  db.all<Raw>(sql`DELETE FROM plg_reminders_fires WHERE fired_at < ${before} RETURNING fire_id`)
    .length
