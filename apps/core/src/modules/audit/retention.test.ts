import { describe, expect, test } from 'bun:test'
import { auditRepo, migrateDatabase, openDatabase, settingsRepo } from '@keith/db'
import { createAudit } from './audit.ts'
import {
  AUDIT_RETENTION_KEY,
  createAuditRetention,
  DEFAULT_AUDIT_RETENTION_DAYS,
} from './retention.ts'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const repo = auditRepo(sqlite, { now: () => NOW })
  const settings = settingsRepo(sqlite)
  const audit = createAudit(repo)
  const retention = createAuditRetention({ repo, settings, audit, via: 'local', now: () => NOW })
  const at = (daysAgo: number, kind: string) =>
    sqlite
      .query('INSERT INTO audit_events (at, kind, actor, via, detail) VALUES (?, ?, ?, ?, ?)')
      .run(NOW - daysAgo * DAY, kind, 'owner', 'local', '{}')
  return { sqlite, repo, settings, retention, at }
}

describe('audit retention', () => {
  test('the default is 180 days; older rows go, newer stay, and the prune itself is recorded', () => {
    const { repo, retention, at } = setup()
    expect(retention.days()).toBe(DEFAULT_AUDIT_RETENTION_DAYS)
    at(400, 'old.a')
    at(181, 'old.b')
    at(179, 'new.a')
    at(1, 'new.b')
    expect(retention.prune()).toBe(2)
    const kinds = repo.list(10).map((e) => e.kind)
    expect(kinds.sort()).toEqual(['audit.pruned', 'new.a', 'new.b'])
    const pruned = repo.list(10).find((e) => e.kind === 'audit.pruned')
    expect(pruned).toMatchObject({
      actor: 'system',
      via: 'local',
      detail: { deleted: 2, retentionDays: 180 },
    })
    // nothing left to prune: no new row
    expect(retention.prune()).toBe(0)
    expect(repo.list(10)).toHaveLength(3)
  })

  test('a stopped core prunes with via offline; the running one says local', () => {
    const { sqlite, repo, settings, at } = setup()
    const offline = createAuditRetention({
      repo,
      settings,
      audit: createAudit(repo),
      via: 'offline',
      now: () => NOW,
    })
    at(400, 'old')
    expect(offline.prune()).toBe(1)
    expect(repo.list(5).find((e) => e.kind === 'audit.pruned')?.via).toBe('offline')
    sqlite.close()
  })

  test('the boundary: a row exactly at the limit stays', () => {
    const { retention, at, repo } = setup()
    at(180, 'edge')
    expect(retention.prune()).toBe(0)
    expect(repo.list(5)).toHaveLength(1)
  })

  test('the setting moves the window; 0 keeps everything', () => {
    const { retention, at, repo } = setup()
    at(40, 'a')
    at(10, 'b')
    retention.setDays(30)
    expect(retention.days()).toBe(30)
    expect(retention.prune()).toBe(1)
    retention.setDays(0)
    at(5000, 'ancient')
    expect(retention.prune()).toBe(0)
    expect(repo.list(10).map((e) => e.kind)).toContain('ancient')
  })

  test('a corrupt stored value reads as the default, never as forever', () => {
    const { retention, settings } = setup()
    for (const bad of ['soon', -3, 1.5, 99999, null, { days: 3 }]) {
      settings.set(AUDIT_RETENTION_KEY, bad)
      expect(retention.days()).toBe(DEFAULT_AUDIT_RETENTION_DAYS)
    }
  })

  test('setDays refuses a bad value and stores nothing', () => {
    const { retention, settings } = setup()
    for (const bad of [-1, 1.5, 3651, Number.NaN])
      expect(() => retention.setDays(bad)).toThrow(RangeError)
    expect(settings.get(AUDIT_RETENTION_KEY)).toBeUndefined()
  })
})
