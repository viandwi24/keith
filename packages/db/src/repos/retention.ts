// Retention deletes (docs/specs/db.md, "Retention", P26.5.1): what the prune tick may remove, by the cut-off it is given.
// Every statement deletes only rows that have ended before `before`; a live row is never matched.
import { immediate, type Sqlite } from '../eh/sql.ts'

/** Finished task states: the worker is over and nothing will write the row again. */
const FINISHED_TASKS = ['done', 'failed', 'stopped', 'timed_out', 'interrupted'] as const

export interface RetentionRepo {
  /**
   * Credentials that ended before `before`: revoked, rotated away (`revoked_reason`, the old secret's grace
   * ends at `absolute_expires_at`), evicted, or past an idle or absolute limit. The end of a row is the earliest
   * of its revoke time and its expiries. A credential with no end (live, or grandfathered without limits) is kept.
   */
  credentials(before: number): number
  /** Legacy client tokens revoked before `before` (they have no expiry). */
  clientTokens(before: number): number
  /** Tasks finished before `before` (`finished_at`, or `updated_at` when it was never set). */
  tasks(before: number): number
  /**
   * Dead letters of the inbox that died before `before`, and their dedupe keys. Returns the rows of each table:
   * `items` of `eh_inbox`, `keys` of `eh_inbox_keys`.
   */
  deadLetters(before: number): { items: number; keys: number }
  /**
   * Budget reservations that are closed (`committed` or `released`) and whose `expires_at` is before `before`:
   * the table has no close time, so the expiry stands in for it.
   */
  budgetReservations(before: number): number
  /**
   * Deliveries that ended (`delivered` or `failed`) before `before`, by `updated_at` (the time the row ended, P25.1.2).
   * A pending row is never matched.
   */
  deliveries(before: number): number
  /** Presence signals older than `before` (7 days, docs/specs/parietal.md "Retention"). */
  presenceSignals(before: number): number
  /** Clients not seen since `before` (90 days). */
  clients(before: number): number
  /** Manual statuses whose end (`until`) is before `now`. A status with no end is kept. */
  presenceStatus(now: number): number
  /**
   * Runs that ended before `before` (`ended_at`, 90 days, docs/specs/hypothalamus.md) and their step rows. A run with no
   * end (`running` or `waiting`) is never matched. The steps go first: they name their run by id.
   */
  protocolRuns(before: number): { runs: number; steps: number }
  /**
   * Proposals whose expiry (`expires_at`) is before `before`, whatever their status (30 days after their end). The table
   * has no decision time, so the expiry stands in for the end, as for the budget reservations.
   */
  protocolProposals(before: number): number
  /** Agenda items whose end (`ends_at`, or `starts_at` plus one hour when null) is before `before`. */
  agendaItems(before: number): number
  /** Dreaming runs that ended before `before` (`ended_at`; a run still `running` has none and stays). ADR-0031 §8. */
  dreamRuns(before: number): number
  /**
   * The transcripts and state of the judge's turns (`dream-judge:<uuid>`, dreaming.md "Judge"). A judge turn keeps nothing in the
   * core's tables any more, so this only clears the rows of installs that stored them before; it is idempotent (a second call
   * deletes nothing). The id range is the prefix range of the primary key (`:` is followed by `;`), so no table scan.
   */
  dreamJudgeSessions(): { messages: number; state: number }
}

export function retentionRepo(sqlite: Sqlite): RetentionRepo {
  const run = (sql: string, params: (string | number)[]): number =>
    sqlite.query(sql).run(...params).changes

  return {
    credentials(before) {
      return run(
        `DELETE FROM credentials WHERE min(
           coalesce(revoked_at, 9e18),
           coalesce(absolute_expires_at, 9e18),
           coalesce(idle_expires_at, 9e18)) < ?`,
        [before],
      )
    },
    clientTokens(before) {
      return run('DELETE FROM client_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?', [
        before,
      ])
    },
    tasks(before) {
      const marks = FINISHED_TASKS.map(() => '?').join(', ')
      return run(
        `DELETE FROM tasks WHERE status IN (${marks}) AND coalesce(finished_at, updated_at) < ?`,
        [...FINISHED_TASKS, before],
      )
    },
    deadLetters(before) {
      // keys first: they name the items by id, and the items are gone after the delete below; one write transaction
      return immediate(sqlite, () => {
        const dead = 'SELECT id FROM eh_inbox WHERE dead_at IS NOT NULL AND dead_at < ?'
        const keys = run(`DELETE FROM eh_inbox_keys WHERE item_id IN (${dead})`, [before])
        const items = run('DELETE FROM eh_inbox WHERE dead_at IS NOT NULL AND dead_at < ?', [
          before,
        ])
        return { items, keys }
      })
    },
    budgetReservations(before) {
      return run(`DELETE FROM eh_budget_reservation WHERE state <> 'open' AND expires_at < ?`, [
        before,
      ])
    },
    deliveries(before) {
      return run(
        `DELETE FROM deliveries WHERE status IN ('delivered', 'failed') AND updated_at < ?`,
        [before],
      )
    },
    presenceSignals(before) {
      return run('DELETE FROM presence_signals WHERE at < ?', [before])
    },
    clients(before) {
      return run('DELETE FROM clients WHERE last_seen_at < ?', [before])
    },
    presenceStatus(now) {
      return run('DELETE FROM presence_status WHERE until IS NOT NULL AND until < ?', [now])
    },
    protocolRuns(before) {
      // steps first: they name their run by id, and the runs are gone after the delete below; one write transaction
      return immediate(sqlite, () => {
        const ended = 'SELECT id FROM protocol_runs WHERE ended_at IS NOT NULL AND ended_at < ?'
        const steps = run(`DELETE FROM protocol_run_steps WHERE run_id IN (${ended})`, [before])
        const runs = run('DELETE FROM protocol_runs WHERE ended_at IS NOT NULL AND ended_at < ?', [
          before,
        ])
        return { runs, steps }
      })
    },
    protocolProposals(before) {
      return run('DELETE FROM protocol_proposals WHERE expires_at < ?', [before])
    },
    agendaItems(before) {
      return run('DELETE FROM agenda_items WHERE coalesce(ends_at, starts_at + 3600000) < ?', [
        before,
      ])
    },
    dreamRuns(before) {
      return run('DELETE FROM dream_runs WHERE ended_at IS NOT NULL AND ended_at < ?', [before])
    },
    dreamJudgeSessions() {
      // the prefix `dream-judge:` as a key range: from the prefix up to the same prefix with `;` (the next byte after `:`)
      const range = 'session_id >= ? AND session_id < ?'
      const args = ['dream-judge:', 'dream-judge;']
      return {
        messages: run(`DELETE FROM eh_messages WHERE ${range}`, args),
        state: run(`DELETE FROM eh_state WHERE ${range}`, args),
      }
    },
  }
}
