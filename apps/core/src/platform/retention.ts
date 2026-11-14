// Retention of ended rows (ADR-0027 §26-28, docs/specs/db.md "Retention", P26.5.1): the prune tick deletes what has
// ended for longer than the period of its table, and writes one `data.pruned` row per table that lost rows.
import { activityLogsRepo, retentionRepo, type Sqlite } from '@keith/db'
import type { Audit } from '../modules/audit/audit.ts'

export const DAY_MS = 86_400_000

/** How long each kind of ended row is kept, in ms. The owner has no setting for them; tests shorten them. */
export interface RetentionPeriods {
  /** Credentials and legacy client tokens after they ended (revoked, rotated, evicted or expired). */
  credentialsMs: number
  /** Finished tasks (`done`, `failed`, `stopped`, `timed_out`, `interrupted`). */
  tasksMs: number
  /** Dead letters of the inbox, with their dedupe keys. */
  deadLettersMs: number
  /** Closed budget reservations, counted from their expiry. */
  budgetReservationsMs: number
  /** Expired pairing codes: read by `pairing.purgeExpired` (P24.2.3), not deleted by `pruneRetention`. */
  pairingCodesMs: number
  /** Delivered or failed deliveries, counted from their end (P25.1.2, docs/specs/delivery.md). */
  deliveriesMs: number
  /** Presence signals, counted from their time (P27.1.2, docs/specs/parietal.md). */
  presenceSignalsMs: number
  /** Clients not seen since their last heartbeat (P27.1.2). */
  clientsMs: number
  /** Runs of protocols and their steps, counted from their end (P28.1.4, docs/specs/hypothalamus.md). */
  protocolRunsMs: number
  /** Proposals, counted from their expiry (P28.1.4). */
  protocolProposalsMs: number
  /** Agenda items, counted from their end (P28.1.4, ADR-0025 §2). */
  agendaItemsMs: number
  /** Dreaming runs, counted from their end (P35.5.6, ADR-0031 §8, docs/specs/db.md). */
  dreamRunsMs: number
}

export const RETENTION_PERIODS: RetentionPeriods = {
  credentialsMs: 90 * DAY_MS,
  tasksMs: 90 * DAY_MS,
  deadLettersMs: 30 * DAY_MS,
  budgetReservationsMs: 7 * DAY_MS,
  pairingCodesMs: 1 * DAY_MS,
  deliveriesMs: 7 * DAY_MS,
  presenceSignalsMs: 7 * DAY_MS,
  clientsMs: 90 * DAY_MS,
  protocolRunsMs: 90 * DAY_MS,
  protocolProposalsMs: 30 * DAY_MS,
  agendaItemsMs: 30 * DAY_MS,
  dreamRunsMs: 90 * DAY_MS,
}

/**
 * The activity-log periods (ADR-0032 §6, §7), in days. Not rows of `RETENTION_PERIODS`: the owner sets them
 * (`bodyRetentionDays`, `metaRetentionDays`), so the prune reads them at each run. Until the settings are wired
 * the defaults below apply.
 */
export interface ActivityRetentionDays {
  /** Bodies of calls started before this many days ago are purged (`llm_bodies`). */
  bodyRetentionDays: number
  /** Calls and sessions last active before this many days ago are deleted (`llm_calls`, `llm_sessions`). */
  metaRetentionDays: number
}

export const ACTIVITY_RETENTION_DEFAULTS: ActivityRetentionDays = {
  bodyRetentionDays: 14,
  metaRetentionDays: 365,
}

/** Rows deleted per table by one run, in the order they were deleted. */
export interface RetentionResult {
  table: string
  count: number
}

/**
 * Delete what the periods say has ended (and the judge transcripts left by older installs), then audit one `data.pruned { table, count }` per table with a count above
 * zero (no ids, no text). `eh_budget_record` (the spend record) and `audit_events` are not touched here. The
 * activity-log tables (`llm_bodies`, `llm_calls`, `llm_sessions`) use the days `activity()` returns at this run.
 */
export function pruneRetention(
  sqlite: Sqlite,
  now: number,
  audit: Pick<Audit, 'record'>,
  periods: RetentionPeriods = RETENTION_PERIODS,
  activity: () => ActivityRetentionDays = () => ACTIVITY_RETENTION_DEFAULTS,
): RetentionResult[] {
  const repo = retentionRepo(sqlite)
  const dead = repo.deadLetters(now - periods.deadLettersMs)
  const results: RetentionResult[] = [
    { table: 'credentials', count: repo.credentials(now - periods.credentialsMs) },
    { table: 'client_tokens', count: repo.clientTokens(now - periods.credentialsMs) },
    { table: 'tasks', count: repo.tasks(now - periods.tasksMs) },
    { table: 'eh_inbox', count: dead.items },
    { table: 'eh_inbox_keys', count: dead.keys },
    {
      table: 'eh_budget_reservation',
      count: repo.budgetReservations(now - periods.budgetReservationsMs),
    },
    { table: 'deliveries', count: repo.deliveries(now - periods.deliveriesMs) },
    { table: 'presence_signals', count: repo.presenceSignals(now - periods.presenceSignalsMs) },
    { table: 'clients', count: repo.clients(now - periods.clientsMs) },
    { table: 'presence_status', count: repo.presenceStatus(now) },
  ]
  const runs = repo.protocolRuns(now - periods.protocolRunsMs)
  results.push(
    { table: 'protocol_runs', count: runs.runs },
    { table: 'protocol_run_steps', count: runs.steps },
    {
      table: 'protocol_proposals',
      count: repo.protocolProposals(now - periods.protocolProposalsMs),
    },
    { table: 'agenda_items', count: repo.agendaItems(now - periods.agendaItemsMs) },
    { table: 'dream_runs', count: repo.dreamRuns(now - periods.dreamRunsMs) },
  )
  // the judge's transcripts of installs before the judge kept none (dreaming.md "Judge"); zero, and no audit row, once they are gone
  const judge = repo.dreamJudgeSessions()
  results.push(
    { table: 'eh_messages', count: judge.messages },
    { table: 'eh_state', count: judge.state },
  )
  const days = activity()
  const logs = activityLogsRepo(sqlite)
  const bodies = logs.purgeBodiesBefore(now - days.bodyRetentionDays * DAY_MS)
  // a call's body older than its figures goes with it, so the bodies count includes those
  const meta = logs.purgeBefore(now - days.metaRetentionDays * DAY_MS)
  results.push(
    { table: 'llm_bodies', count: bodies.bodies + meta.bodies },
    { table: 'llm_calls', count: meta.calls },
    { table: 'llm_sessions', count: meta.sessions },
  )
  for (const { table, count } of results) {
    if (count > 0)
      audit.record({ kind: 'data.pruned', actor: 'system', via: 'local', detail: { table, count } })
  }
  return results
}
