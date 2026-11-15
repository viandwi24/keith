// The `push_subscriptions` table (docs/specs/push.md, "Data"): the Web Push subscriptions of a person. Policy (the limit
// per person, when to drop a row) is the core's; the repo stores rows and answers the questions the service asks.
import type { Sqlite } from '../eh/sql.ts'

export interface PushSubscriptionRow {
  id: string
  personId: string
  endpoint: string
  p256dh: string
  auth: string
  clientId: string | null
  label: string
  userAgent: string
  createdAt: number
  lastSuccessAt: number | null
  failureCount: number
}

export interface NewPushSubscription {
  id: string
  personId: string
  endpoint: string
  p256dh: string
  auth: string
  clientId?: string | null
  label: string
  userAgent: string
  createdAt: number
}

export interface PushSubscriptionsRepo {
  /**
   * Stores a subscription. An endpoint already stored is updated in place (keys, labels, owner) and its failure count reset;
   * the row keeps its id and creation time.
   */
  upsert(row: NewPushSubscription): PushSubscriptionRow
  get(id: string): PushSubscriptionRow | undefined
  byEndpoint(endpoint: string): PushSubscriptionRow | undefined
  /** The subscriptions of one person, oldest first. */
  listFor(personId: string): PushSubscriptionRow[]
  countFor(personId: string): number
  /** Deletes one row; false when none. */
  delete(id: string): boolean
  deleteFor(personId: string): number
  /** A send was accepted: `last_success_at` set and the failure count reset. */
  markSuccess(id: string, at: number): void
  /** A send failed: the count after this failure, or undefined when the row is gone. */
  markFailure(id: string): number | undefined
}

interface Row {
  id: string
  person_id: string
  endpoint: string
  p256dh: string
  auth: string
  client_id: string | null
  label: string
  user_agent: string
  created_at: number
  last_success_at: number | null
  failure_count: number
}

const rowOf = (r: Row): PushSubscriptionRow => ({
  id: r.id,
  personId: r.person_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  clientId: r.client_id,
  label: r.label,
  userAgent: r.user_agent,
  createdAt: r.created_at,
  lastSuccessAt: r.last_success_at,
  failureCount: r.failure_count,
})

export function pushSubscriptionsRepo(sqlite: Sqlite): PushSubscriptionsRepo {
  const byEndpoint = (endpoint: string): PushSubscriptionRow | undefined => {
    const found = sqlite
      .query<Row, [string]>('SELECT * FROM push_subscriptions WHERE endpoint = ?')
      .get(endpoint)
    return found === null ? undefined : rowOf(found)
  }
  return {
    upsert(row) {
      sqlite
        .query(
          `INSERT INTO push_subscriptions (id, person_id, endpoint, p256dh, auth, client_id, label, user_agent, created_at, failure_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id, p256dh = excluded.p256dh,
             auth = excluded.auth, client_id = excluded.client_id, label = excluded.label,
             user_agent = excluded.user_agent, failure_count = 0`,
        )
        .run(
          row.id,
          row.personId,
          row.endpoint,
          row.p256dh,
          row.auth,
          row.clientId ?? null,
          row.label,
          row.userAgent,
          row.createdAt,
        )
      return byEndpoint(row.endpoint) as PushSubscriptionRow
    },
    get(id) {
      const found = sqlite
        .query<Row, [string]>('SELECT * FROM push_subscriptions WHERE id = ?')
        .get(id)
      return found === null ? undefined : rowOf(found)
    },
    byEndpoint,
    listFor(personId) {
      return sqlite
        .query<Row, [string]>(
          'SELECT * FROM push_subscriptions WHERE person_id = ? ORDER BY created_at, id',
        )
        .all(personId)
        .map(rowOf)
    },
    countFor(personId) {
      return (
        sqlite
          .query<{ n: number }, [string]>(
            'SELECT count(*) AS n FROM push_subscriptions WHERE person_id = ?',
          )
          .get(personId)?.n ?? 0
      )
    },
    delete(id) {
      return sqlite.query('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0
    },
    deleteFor(personId) {
      return sqlite.query('DELETE FROM push_subscriptions WHERE person_id = ?').run(personId)
        .changes
    },
    markSuccess(id, at) {
      sqlite
        .query('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?')
        .run(at, id)
    },
    markFailure(id) {
      return (
        sqlite
          .query<{ failure_count: number }, [string]>(
            'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ? RETURNING failure_count',
          )
          .get(id)?.failure_count ?? undefined
      )
    },
  }
}
