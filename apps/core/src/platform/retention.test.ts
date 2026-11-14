import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmCallRecord } from '@keith/contracts'
import { activityLogsRepo, auditRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCore } from '../compose.ts'
import { migrateAll } from '../testing/migrate-all.ts'
import { loadConfig } from './config.ts'
import { silentLogger } from './logger.ts'
import {
  ACTIVITY_RETENTION_DEFAULTS,
  DAY_MS,
  pruneRetention,
  RETENTION_PERIODS,
} from './retention.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const NOW = 2_000 * DAY_MS
const ago = (days: number): number => NOW - days * DAY_MS

function freshDatabase(): Sqlite {
  const sqlite = openDatabase(':memory:')
  migrateAll(sqlite)
  sqlite.exec(
    "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES ('p1', 'Ana', 'member', 1, 'ana', 'active', 1)",
  )
  return sqlite
}

/** The audit sink of the tests: writes into the same database, as the core does. */
const sinkOf = (sqlite: Sqlite) => ({
  record: (event: Parameters<ReturnType<typeof auditRepo>['add']>[0]) =>
    auditRepo(sqlite, { now: () => NOW }).add(event),
})

const ids = (sqlite: Sqlite, table: string, column = 'id'): string[] =>
  sqlite
    .query<{ v: string }, []>(`SELECT ${column} AS v FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => row.v)

function addCredential(
  sqlite: Sqlite,
  id: string,
  ends: { revokedAt?: number; reason?: string; idle?: number; absolute?: number },
): void {
  sqlite
    .query(
      `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at, revoked_at, revoked_reason,
         idle_expires_at, absolute_expires_at)
       VALUES (?, 'p1', 'device', 'laptop', 'h', 1, ?, ?, ?, ?)`,
    )
    .run(id, ends.revokedAt ?? null, ends.reason ?? null, ends.idle ?? null, ends.absolute ?? null)
}

describe('pruneRetention (docs/specs/db.md "Retention")', () => {
  test('credentials: an ended one past its period goes, a live or recent one stays', () => {
    const sqlite = freshDatabase()
    addCredential(sqlite, 'c-revoked-old', { revokedAt: ago(91), reason: 'admin' })
    addCredential(sqlite, 'c-revoked-recent', { revokedAt: ago(10), reason: 'admin' })
    addCredential(sqlite, 'c-live', {})
    addCredential(sqlite, 'c-idle-future', { idle: ago(-1) })
    addCredential(sqlite, 'c-idle-old', { idle: ago(100) })
    addCredential(sqlite, 'c-absolute-recent', { absolute: ago(10) })
    addCredential(sqlite, 'c-rotated-old', { reason: 'rotated', absolute: ago(95) })
    addCredential(sqlite, 'c-evicted-old', { revokedAt: ago(200), reason: 'evicted' })

    pruneRetention(sqlite, NOW, sinkOf(sqlite))

    expect(ids(sqlite, 'credentials')).toEqual([
      'c-absolute-recent',
      'c-idle-future',
      'c-live',
      'c-revoked-recent',
    ])
  })

  test('client tokens: revoked past the period go; live ones stay', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO client_tokens (id, person_id, hash, label, created_at, revoked_at) VALUES
         ('t-old', 'p1', 'h1', 'old', 1, ${ago(120)}),
         ('t-recent', 'p1', 'h2', 'recent', 1, ${ago(5)}),
         ('t-live', 'p1', 'h3', 'live', 1, NULL)`,
    )
    expect(pruneRetention(sqlite, NOW, sinkOf(sqlite))).toContainEqual({
      table: 'client_tokens',
      count: 1,
    })
    expect(ids(sqlite, 'client_tokens')).toEqual(['t-live', 't-recent'])
  })

  test('tasks: finished past the period go; running and recent ones stay', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at, finished_at) VALUES
         ('k-done-old', 'front:p1', 'cortex.general', 'd', 'done', 1, 1, ${ago(100)}, ${ago(100)}),
         ('k-interrupted-old', 'front:p1', 'cortex.general', 'd', 'interrupted', 1, 1, ${ago(100)}, NULL),
         ('k-running-old', 'front:p1', 'cortex.general', 'd', 'running', 1, 1, ${ago(100)}, NULL),
         ('k-done-recent', 'front:p1', 'cortex.general', 'd', 'done', 1, 1, ${ago(3)}, ${ago(3)})`,
    )
    pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(ids(sqlite, 'tasks')).toEqual(['k-done-recent', 'k-running-old'])
  })

  test('dead letters past 30 days go with their dedupe keys; live and recent ones stay', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO eh_inbox (id, session_id, kind, item, dead_at, dead_reason) VALUES
         ('i-dead-old', 'front:p1', 'msg', '{}', ${ago(31)}, 'boom'),
         ('i-dead-recent', 'front:p1', 'msg', '{}', ${ago(5)}, 'boom'),
         ('i-live', 'front:p1', 'msg', '{}', NULL, NULL);
       INSERT INTO eh_inbox_keys (session_id, dedupe_key, item_id, expires_at) VALUES
         ('front:p1', 'k-old', 'i-dead-old', NULL),
         ('front:p1', 'k-recent', 'i-dead-recent', NULL),
         ('front:p1', 'k-live', 'i-live', NULL);`,
    )
    const result = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(result).toContainEqual({ table: 'eh_inbox', count: 1 })
    expect(result).toContainEqual({ table: 'eh_inbox_keys', count: 1 })
    expect(ids(sqlite, 'eh_inbox')).toEqual(['i-dead-recent', 'i-live'])
    expect(ids(sqlite, 'eh_inbox_keys', 'dedupe_key')).toEqual(['k-live', 'k-recent'])
  })

  test('closed budget reservations go 7 days after expiry; open ones stay', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO eh_budget_reservation (id, key, scopes, period_start, amount_usd, expires_at, state) VALUES
         ('r-committed-old', 'k', '[]', 0, '0.1', ${ago(8)}, 'committed'),
         ('r-released-recent', 'k', '[]', 0, '0.1', ${ago(1)}, 'released'),
         ('r-open-old', 'k', '[]', 0, '0.1', ${ago(8)}, 'open');
       INSERT INTO eh_budget_record (key, recorded_at) VALUES ('spend-1', ${ago(1000)});`,
    )
    pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(ids(sqlite, 'eh_budget_reservation')).toEqual(['r-open-old', 'r-released-recent'])
    // the spend record is kept on purpose
    expect(ids(sqlite, 'eh_budget_record', 'key')).toEqual(['spend-1'])
  })

  test('deliveries: delivered or failed 7 days after their end go; pending and recent ones stay', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO deliveries (id, source, recipient_id, name, needs, text, status, attempts, created_at, updated_at) VALUES
         ('d-delivered-old', 'plugin:reminders', 'p1', 'reminder', '{}', '', 'delivered', 1, 1, ${ago(8)}),
         ('d-failed-old', 'plugin:reminders', 'p1', 'reminder', '{}', 'x', 'failed', 1, 1, ${ago(8)}),
         ('d-failed-recent', 'plugin:reminders', 'p1', 'reminder', '{}', 'x', 'failed', 1, 1, ${ago(1)}),
         ('d-pending-old', 'plugin:reminders', 'p1', 'reminder', '{}', 'x', 'pending', 0, 1, ${ago(30)})`,
    )
    expect(pruneRetention(sqlite, NOW, sinkOf(sqlite))).toContainEqual({
      table: 'deliveries',
      count: 2,
    })
    expect(ids(sqlite, 'deliveries')).toEqual(['d-failed-recent', 'd-pending-old'])
  })

  test('presence: signals older than 7 days, clients unseen for 90 days and ended statuses go; the rest stays', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO presence_signals (id, person_id, client_id, type, at, detail) VALUES
         ('s-old', 'p1', NULL, 'activity', ${ago(8)}, NULL),
         ('s-recent', 'p1', NULL, 'activity', ${ago(1)}, NULL);
       INSERT INTO clients (id, person_id, kind, label, capabilities, version, first_seen_at, last_seen_at, last_active_at) VALUES
         ('c-gone', 'p1', 'tui', 'old laptop', '[]', '0.1.0', 1, ${ago(91)}, NULL),
         ('c-recent', 'p1', 'tui', 'laptop', '[]', '0.1.0', 1, ${ago(80)}, NULL);
       INSERT INTO presence_status (person_id, state, note, until, set_at) VALUES
         ('p1', 'busy', 'meeting', ${ago(1)}, ${ago(2)}),
         ('p2', 'busy', 'no end', NULL, ${ago(900)}),
         ('p3', 'busy', 'later', ${ago(-1)}, ${ago(1)});`,
    )
    const result = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(result).toContainEqual({ table: 'presence_signals', count: 1 })
    expect(result).toContainEqual({ table: 'clients', count: 1 })
    expect(result).toContainEqual({ table: 'presence_status', count: 1 })
    expect(ids(sqlite, 'presence_signals')).toEqual(['s-recent'])
    expect(ids(sqlite, 'clients')).toEqual(['c-recent'])
    expect(ids(sqlite, 'presence_status', 'person_id')).toEqual(['p2', 'p3'])
  })

  test('hypothalamus: runs ended 90 days ago with their steps, proposals expired 30 days ago and agenda items ended 30 days ago go; the rest stays', () => {
    const sqlite = freshDatabase()
    sqlite.exec(
      `INSERT INTO protocol_runs (id, protocol_id, version, person, trigger_ref, status, started_at, updated_at, ended_at) VALUES
         ('r-old', 'pr1', 1, 'p1', 't1', 'done', 1, 1, ${ago(91)}),
         ('r-recent', 'pr1', 1, 'p1', 't2', 'done', 1, 1, ${ago(89)}),
         ('r-waiting', 'pr1', 1, 'p1', 't3', 'waiting', 1, 1, NULL);
       INSERT INTO protocol_run_steps (run_id, step, kind, outcome, at) VALUES
         ('r-old', 'a', 'notify', 'ok', 1),
         ('r-old', 'b', 'wait', 'ok', 2),
         ('r-recent', 'a', 'notify', 'ok', 1),
         ('r-waiting', 'a', 'notify', 'ok', 1);
       INSERT INTO protocol_proposals (id, person, definition, reason, source, status, created_at, expires_at) VALUES
         ('x-old', 'p1', '{}', 'r', '{}', 'expired', 1, ${ago(31)}),
         ('x-pending', 'p1', '{}', 'r', '{}', 'pending', ${ago(2)}, ${ago(-5)}),
         ('x-recent', 'p1', '{}', 'r', '{}', 'confirmed', 1, ${ago(29)});
       INSERT INTO agenda_items (id, person, what, starts_at, ends_at, place, status, created_at, updated_at) VALUES
         ('a-old', 'p1', 'x', ${ago(32)}, ${ago(31)}, NULL, 'done', 1, 1),
         ('a-no-end', 'p1', 'y', ${ago(32)}, NULL, NULL, 'tentative', 1, 1),
         ('a-recent', 'p1', 'z', ${ago(3)}, ${ago(2)}, NULL, 'confirmed', 1, 1),
         ('a-future', 'p1', 'w', ${ago(-1)}, NULL, NULL, 'confirmed', 1, 1);`,
    )
    const result = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(result).toContainEqual({ table: 'protocol_runs', count: 1 })
    expect(result).toContainEqual({ table: 'protocol_run_steps', count: 2 })
    expect(result).toContainEqual({ table: 'protocol_proposals', count: 1 })
    expect(result).toContainEqual({ table: 'agenda_items', count: 2 })
    expect(ids(sqlite, 'protocol_runs')).toEqual(['r-recent', 'r-waiting'])
    expect(ids(sqlite, 'protocol_run_steps', 'n').length).toBe(2)
    expect(ids(sqlite, 'protocol_proposals')).toEqual(['x-pending', 'x-recent'])
    expect(ids(sqlite, 'agenda_items')).toEqual(['a-future', 'a-recent'])
  })

  test('one data.pruned row per table that lost rows, with the count and nothing else', () => {
    const sqlite = freshDatabase()
    addCredential(sqlite, 'c-old', { revokedAt: ago(91), reason: 'admin' })
    addCredential(sqlite, 'c-old-2', { revokedAt: ago(92), reason: 'admin' })
    addCredential(sqlite, 'c-live', {})
    pruneRetention(sqlite, NOW, sinkOf(sqlite))
    const rows = sqlite
      .query<{ kind: string; actor: string; via: string; detail: string }, []>(
        "SELECT kind, actor, via, detail FROM audit_events WHERE kind = 'data.pruned'",
      )
      .all()
    expect(rows).toEqual([
      {
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: JSON.stringify({ table: 'credentials', count: 2 }),
      },
    ])
  })

  test('a second run with nothing ended deletes nothing and audits nothing', () => {
    const sqlite = freshDatabase()
    addCredential(sqlite, 'c-live', {})
    const results = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(results.every((result) => result.count === 0)).toBe(true)
    const audited = sqlite
      .query<{ n: number }, []>("SELECT count(*) AS n FROM audit_events WHERE kind = 'data.pruned'")
      .get()
    expect(audited?.n).toBe(0)
  })

  test('judge transcripts of older installs (dream-judge:) are deleted once; the chat and other sessions stay', () => {
    const sqlite = freshDatabase()
    const message = (session: string, id: string) =>
      sqlite
        .query(
          "INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, 'user', '[]', NULL, 1)",
        )
        .run(session, id)
    const state = (session: string) =>
      sqlite
        .query("INSERT INTO eh_state (session_id, state, rev, updated_at) VALUES (?, '{}', 1, 1)")
        .run(session)
    message('dream-judge:0190f5e2-0000-7000-8000-000000000001', 'm1')
    message('dream-judge:0190f5e2-0000-7000-8000-000000000001', 'm2')
    message('dream-judge:0190f5e2-0000-7000-8000-000000000002', 'm3')
    state('dream-judge:0190f5e2-0000-7000-8000-000000000001')
    // not judge sessions: a chat session, a worker, and a name that only starts like the prefix
    message('front:p1', 'm4')
    message('front:p1:worker', 'm5')
    state('front:p1')
    message('dream-judgex:1', 'm6')

    const first = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(first.find((r) => r.table === 'eh_messages')?.count).toBe(3)
    expect(first.find((r) => r.table === 'eh_state')?.count).toBe(1)
    expect(ids(sqlite, 'eh_messages', 'session_id')).toEqual([
      'dream-judgex:1',
      'front:p1',
      'front:p1:worker',
    ])
    expect(ids(sqlite, 'eh_state', 'session_id')).toEqual(['front:p1'])
    const audited = sqlite
      .query<{ detail: string }, []>(
        "SELECT detail FROM audit_events WHERE kind = 'data.pruned' AND detail LIKE '%eh_%' ORDER BY detail",
      )
      .all()
      .map((row) => row.detail)
    expect(audited).toEqual([
      JSON.stringify({ table: 'eh_messages', count: 3 }),
      JSON.stringify({ table: 'eh_state', count: 1 }),
    ])

    // idempotent: the next run finds nothing and audits nothing more
    const second = pruneRetention(sqlite, NOW, sinkOf(sqlite))
    expect(second.find((r) => r.table === 'eh_messages')?.count).toBe(0)
    expect(second.find((r) => r.table === 'eh_state')?.count).toBe(0)
  })

  describe('activity logs (ADR-0032 §7, activity-logs.md "Retention")', () => {
    const call = (
      id: string,
      sessionId: string,
      startedAt: number,
      cost: number,
    ): LlmCallRecord => ({
      id,
      sessionId,
      kind: 'step',
      trigger: 'send',
      turnId: 'turn-1',
      stepIndex: 0,
      startedAt,
      durationMs: 50,
      firstChunkMs: 10,
      status: 'ok',
      finishReason: 'stop',
      modelId: 'model-a',
      provider: 'openrouter',
      upstreamProvider: null,
      tokensIn: 10,
      tokensOut: 5,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      costMicro: cost,
      costSource: 'provider',
      fallbackNote: null,
      errorName: null,
      errorMessage: null,
      requestBytes: 20,
      responseBytes: 30,
      bodyState: 'stored',
      speakerId: null,
    })
    const body = () => ({
      request: Bun.gzipSync(new TextEncoder().encode('{"q":1}')),
      response: Bun.gzipSync(new TextEncoder().encode('{"a":1}')),
      output: null,
    })
    /** front:ana holds a body at 2 days, 20 days (past 14) and a figures-only call; front:old holds one call 400 days ago. */
    function seedLogs(sqlite: Sqlite): void {
      const repo = activityLogsRepo(sqlite)
      const ana = { kind: 'chat', personId: 'p1', roomId: null, app: 'Front' } as const
      repo.insertCalls([
        {
          session: { id: 'front:ana', ...ana },
          call: call('c-new', 'front:ana', ago(2), 100),
          bodies: body(),
        },
        {
          session: { id: 'front:ana', ...ana },
          call: call('c-mid', 'front:ana', ago(20), 200),
          bodies: body(),
        },
        {
          session: { id: 'front:ana', ...ana },
          call: call('c-figures', 'front:ana', ago(21), 300),
        },
        {
          session: { id: 'front:old', ...ana },
          call: call('c-old', 'front:old', ago(400), 400),
          bodies: body(),
        },
      ])
    }

    test('bodies past bodyRetentionDays are purged, the figures stay; calls and sessions past metaRetentionDays go', () => {
      const sqlite = freshDatabase()
      seedLogs(sqlite)
      const results = pruneRetention(sqlite, NOW, sinkOf(sqlite))
      expect(results.filter((r) => r.table.startsWith('llm_'))).toEqual([
        { table: 'llm_bodies', count: 2 },
        { table: 'llm_calls', count: 1 },
        { table: 'llm_sessions', count: 1 },
      ])
      expect(ids(sqlite, 'llm_calls')).toEqual(['c-figures', 'c-mid', 'c-new'])
      expect(ids(sqlite, 'llm_bodies', 'call_id')).toEqual(['c-new'])
      expect(ids(sqlite, 'llm_sessions')).toEqual(['front:ana'])
      const state = sqlite
        .query<{ id: string; body_state: string }, []>(
          'SELECT id, body_state FROM llm_calls ORDER BY id',
        )
        .all()
      expect(state).toEqual([
        { id: 'c-figures', body_state: 'stored' },
        { id: 'c-mid', body_state: 'purged' },
        { id: 'c-new', body_state: 'stored' },
      ])
      // the session's totals equal the calls it still holds
      const session = sqlite
        .query<{ calls: number; cost_micro: number }, []>(
          "SELECT calls, cost_micro FROM llm_sessions WHERE id = 'front:ana'",
        )
        .get()
      expect(session).toEqual({ calls: 3, cost_micro: 600 })
    })

    test('the days come from the activity settings at each run; the defaults are 14 and 365', () => {
      expect(ACTIVITY_RETENTION_DEFAULTS).toEqual({ bodyRetentionDays: 14, metaRetentionDays: 365 })
      const sqlite = freshDatabase()
      seedLogs(sqlite)
      const results = pruneRetention(sqlite, NOW, sinkOf(sqlite), RETENTION_PERIODS, () => ({
        bodyRetentionDays: 30,
        metaRetentionDays: 730,
      }))
      // only the body of the 400-day call goes (30 days); no call or session is past 730 days
      expect(results.filter((r) => r.table.startsWith('llm_')).map((r) => r.count)).toEqual([
        1, 0, 0,
      ])
      expect(ids(sqlite, 'llm_calls')).toEqual(['c-figures', 'c-mid', 'c-new', 'c-old'])
    })

    test('one data.pruned row per log table that lost rows, counts only', () => {
      const sqlite = freshDatabase()
      seedLogs(sqlite)
      pruneRetention(sqlite, NOW, sinkOf(sqlite))
      const rows = sqlite
        .query<{ detail: string }, []>(
          "SELECT detail FROM audit_events WHERE kind = 'data.pruned' ORDER BY id",
        )
        .all()
        .map((r) => JSON.parse(r.detail))
      expect(rows).toEqual([
        { table: 'llm_bodies', count: 2 },
        { table: 'llm_calls', count: 1 },
        { table: 'llm_sessions', count: 1 },
      ])
    })
  })

  test('the periods are the documented ones (db.md "Retention")', () => {
    expect(RETENTION_PERIODS).toEqual({
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
    })
  })

  test('the boot prune of a core deletes an old revoked credential (the prune tick runs it)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-retention-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    const config = loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'retention' })
    const sqlite = openDatabase(config.dbFile)
    migrateAll(sqlite)
    sqlite.exec(
      "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES ('p1', 'Ana', 'member', 1, 'ana', 'active', 1)",
    )
    const old = Date.now() - 100 * DAY_MS
    sqlite.exec(
      `INSERT INTO credentials (id, person_id, kind, label, secret_hash, created_at, revoked_at, revoked_reason)
       VALUES ('c-boot-old', 'p1', 'device', 'old', 'h', 1, ${old}, 'admin')`,
    )
    sqlite.close()

    const core = await createCore({
      config,
      logger: silentLogger,
      catalogs: { offline: true },
      timing: { inboxPollMs: 20, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 },
    })
    await core.close()

    const check = openDatabase(config.dbFile)
    try {
      expect(ids(check, 'credentials')).toEqual([])
      const audited = check
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM audit_events WHERE kind = 'data.pruned' AND detail LIKE '%credentials%'",
        )
        .get()
      expect(audited?.n).toBe(1)
    } finally {
      check.close()
    }
  })

  test('the boot prune purges the rows of an expired stream log (no read or append)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keith-streamlog-'))
    roots.push(root)
    const config = loadConfig({ KEITH_DATA_DIR: join(root, 'data'), KEITH_BUILD_SHA: 'streams' })
    const sqlite = openDatabase(config.dbFile)
    migrateAll(sqlite)
    const past = Date.now() - 60_000
    sqlite.exec(
      `INSERT INTO eh_stream_log (session_id, turn_id, status, length, ttl_ms, expires_at)
       VALUES ('front:ana', 'turn-old', 'done', 2, 600000, ${past});
       INSERT INTO eh_stream_chunks (session_id, turn_id, idx, chunk) VALUES
         ('front:ana', 'turn-old', 0, '"a"'), ('front:ana', 'turn-old', 1, '"b"');`,
    )
    sqlite.close()

    const core = await createCore({
      config,
      logger: silentLogger,
      catalogs: { offline: true },
      timing: { inboxPollMs: 20, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 },
    })
    await core.close()

    const check = openDatabase(config.dbFile)
    try {
      expect(ids(check, 'eh_stream_chunks', 'turn_id')).toEqual([])
      expect(ids(check, 'eh_stream_log', 'turn_id')).toEqual([])
    } finally {
      check.close()
    }
  })
})
