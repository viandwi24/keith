// The `presence_signals` table (docs/specs/parietal.md, "Signals and computation", ADR-0025 §1): facts with a time that
// presence is computed from. Rows hold no message text; `detail` is small JSON. Pruning is in retention.ts (7 days).
import type { SignalType } from '@keith/contracts'
import type { Sqlite } from '../eh/sql.ts'

/** `client.active` rows of one client are stored at most once per this many ms (ADR-0025 consequences). */
export const ACTIVE_COALESCE_MS = 60_000
/** Most bytes of `detail` (JSON) a signal may carry. */
export const SIGNAL_DETAIL_MAX_BYTES = 200

export interface SignalInput {
  personId: string
  clientId?: string | null
  type: SignalType
  /** Epoch ms of the fact. */
  at: number
  detail?: Record<string, string | number | boolean | null> | null
}

export interface PresenceSignalsRepo {
  /**
   * Stores a signal. A `client.active` of a client already stored within `ACTIVE_COALESCE_MS` is skipped; returns
   * whether a row was written. Throws a RangeError when `detail` is over 200 bytes (a caller bug, never user text).
   */
  record(input: SignalInput): boolean
  /** The newest `at` of the person's signals of these types, or null. */
  newest(personId: string, types: readonly SignalType[]): number | null
  /** The newest `at` of each client of the person with a signal of this type (keyed by client id). */
  newestPerClient(personId: string, type: SignalType): Map<string, number>
  /**
   * Signals after a cursor in the order `(at, id)`, oldest first, at most `limit`: `at > after.at`, or `at = after.at`
   * and `id > after.id`. `detail` is parsed back to its flat object (null when none). Read only, for the protocol
   * triggers (docs/specs/hypothalamus.md, "Triggers").
   */
  since(after: { at: number; id: string }, limit: number): SignalRecord[]
}

export interface SignalRecord {
  id: string
  personId: string
  clientId: string | null
  type: SignalType
  at: number
  detail: Record<string, string | number | boolean | null> | null
}

interface SignalRow {
  id: string
  person_id: string
  client_id: string | null
  type: SignalType
  at: number
  detail: string | null
}

export function presenceSignalsRepo(sqlite: Sqlite): PresenceSignalsRepo {
  return {
    record(input) {
      if (input.type === 'client.active' && input.clientId) {
        const last = sqlite
          .query<{ at: number }, [string, string, number]>(
            `SELECT at FROM presence_signals WHERE person_id = ? AND client_id = ? AND type = 'client.active' AND at > ?
             ORDER BY at DESC LIMIT 1`,
          )
          .get(input.personId, input.clientId, input.at - ACTIVE_COALESCE_MS)
        if (last !== null) return false
      }
      const detail = input.detail == null ? null : JSON.stringify(input.detail)
      if (detail !== null && Buffer.byteLength(detail) > SIGNAL_DETAIL_MAX_BYTES)
        throw new RangeError(`presence signal detail is over ${SIGNAL_DETAIL_MAX_BYTES} bytes`)
      sqlite
        .query(
          `INSERT INTO presence_signals (id, person_id, client_id, type, at, detail) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Bun.randomUUIDv7(),
          input.personId,
          input.clientId ?? null,
          input.type,
          input.at,
          detail,
        )
      return true
    },
    newest(personId, types) {
      if (types.length === 0) return null
      const marks = types.map(() => '?').join(', ')
      const row = sqlite
        .query<{ at: number | null }, (string | number)[]>(
          `SELECT MAX(at) AS at FROM presence_signals WHERE person_id = ? AND type IN (${marks})`,
        )
        .get(personId, ...types)
      return row?.at ?? null
    },
    newestPerClient(personId, type) {
      const rows = sqlite
        .query<{ client_id: string; at: number }, [string, string]>(
          `SELECT client_id, MAX(at) AS at FROM presence_signals
           WHERE person_id = ? AND type = ? AND client_id IS NOT NULL GROUP BY client_id`,
        )
        .all(personId, type)
      return new Map(rows.map((row) => [row.client_id, row.at]))
    },
    since(after, limit) {
      const rows = sqlite
        .query<SignalRow, [number, number, string, number]>(
          `SELECT id, person_id, client_id, type, at, detail FROM presence_signals
           WHERE at > ? OR (at = ? AND id > ?) ORDER BY at ASC, id ASC LIMIT ?`,
        )
        .all(after.at, after.at, after.id, limit)
      return rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        clientId: row.client_id,
        type: row.type,
        at: row.at,
        detail: row.detail === null ? null : JSON.parse(row.detail),
      }))
    },
  }
}
