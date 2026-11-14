import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import {
  budgetStatus,
  currentPeriod,
  setBudgetLimit,
  sqliteBudgetLedger,
} from '../eh/budget-ledger.ts'
import { auditRepo } from './audit.ts'
import { credentialsRepo } from './credentials.ts'
import { deliveriesRepo } from './deliveries.ts'
import { deviceRequestsRepo, MAX_PENDING_PER_IP } from './devices.ts'
import { nodesRepo } from './nodes.ts'
import { pairingRepo } from './pairing.ts'
import { secretsRepo } from './secrets.ts'
import { settingsRepo } from './settings.ts'
import { tasksRepo } from './tasks.ts'
import { tokensRepo } from './tokens.ts'

const db = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

describe('settingsRepo', () => {
  test('round-trips JSON values and deletes', () => {
    const settings = settingsRepo(db())
    expect(settings.get('model.front')).toBeUndefined()
    settings.set('model.front', 'openrouter:anthropic/claude-haiku-5.5')
    expect(settings.get<string>('model.front')).toBe('openrouter:anthropic/claude-haiku-5.5')
    settings.delete('model.front')
    expect(settings.get('model.front')).toBeUndefined()
  })
})

describe('tokensRepo', () => {
  test('finds live tokens by hash and revokes them', () => {
    const tokens = tokensRepo(db())
    expect(tokens.owner()).toBeUndefined()
    tokens.createOwner({ id: 'owner', name: 'Owner', role: 'owner' })
    tokens.addToken({ id: 't1', personId: 'owner', label: 'boot', hash: 'h1' })
    expect(tokens.findByHash('h1')?.person.role).toBe('owner')
    expect(tokens.findByHash('nope')).toBeUndefined()
    expect(tokens.revokeAll('owner')).toBe(1)
    expect(tokens.findByHash('h1')).toBeUndefined()
  })
})

describe('tasksRepo', () => {
  const base = { parentSessionId: 'p1', agent: 'cortex.research', description: 'find A' }

  test('upsert inserts then updates and keeps createdAt', () => {
    let t = 100
    const tasks = tasksRepo(db(), { now: () => t })
    const first = tasks.upsert({ id: 'c1', ...base, status: 'running' })
    expect(first).toMatchObject({ status: 'running', steps: 0, createdAt: 100, finishedAt: null })
    t = 200
    const next = tasks.upsert({ id: 'c1', ...base, status: 'running', steps: 3 })
    expect(next).toMatchObject({ steps: 3, createdAt: 100, updatedAt: 200 })
    expect(tasks.get('c1')?.steps).toBe(3)
    expect(tasks.get('nope')).toBeUndefined()
  })

  test('list filters by parent and active, newest updated first, with a limit', () => {
    let t = 0
    const tasks = tasksRepo(db(), { now: () => ++t })
    tasks.upsert({ id: 'a', ...base, status: 'running' })
    tasks.upsert({ id: 'b', ...base, status: 'waiting' })
    tasks.upsert({ id: 'c', ...base, status: 'done' })
    tasks.upsert({ id: 'd', ...base, parentSessionId: 'p2', status: 'queued' })
    expect(tasks.list().map((x) => x.id)).toEqual(['d', 'c', 'b', 'a'])
    expect(tasks.list({ parentSessionId: 'p1' }).map((x) => x.id)).toEqual(['c', 'b', 'a'])
    expect(tasks.list({ active: true }).map((x) => x.id)).toEqual(['d', 'b', 'a'])
    expect(tasks.list({ active: false }).map((x) => x.id)).toEqual(['c'])
    expect(tasks.list({ limit: 2 }).map((x) => x.id)).toEqual(['d', 'c'])
  })

  test('markFinished sets the final state', () => {
    const tasks = tasksRepo(db(), { now: () => 500 })
    tasks.upsert({ id: 'a', ...base, status: 'running' })
    expect(tasks.markFinished('a', { status: 'failed', error: 'boom' })).toMatchObject({
      status: 'failed',
      error: 'boom',
      summary: null,
      finishedAt: 500,
    })
    expect(tasks.markFinished('a', { status: 'done', summary: 'ok' })?.error).toBe('boom')
    expect(tasks.markFinished('zz', { status: 'done' })).toBeUndefined()
  })
})

describe('nodesRepo', () => {
  const input = (name: string, tokenHash: string) => ({
    name,
    os: 'darwin',
    arch: 'arm64',
    version: '0.1.0',
    manifest: { capabilities: ['system.info'] },
    allowShell: false,
    tokenHash,
  })

  test('creates, finds by token hash, updates and touches', () => {
    let t = 100
    const nodes = nodesRepo(db(), { now: () => t })
    const node = nodes.create(input('laptop-e', 'h1'))
    expect(node).toMatchObject({
      name: 'laptop-e',
      status: 'offline',
      lastSeenAt: null,
      createdAt: 100,
    })
    expect(nodes.findByTokenHash('h1')?.id).toBe(node.id)
    t = 200
    expect(nodes.touch(node.id)?.lastSeenAt).toBe(200)
    expect(nodes.setStatus(node.id, 'online', 250)).toMatchObject({
      status: 'online',
      lastSeenAt: 250,
    })
    const updated = nodes.updateManifest(node.id, { version: '0.2.0', allowShell: true })
    expect(updated).toMatchObject({ version: '0.2.0', allowShell: true, os: 'darwin' })
    expect(nodes.list()).toHaveLength(1)
  })

  test('a revoked token is never found again', () => {
    const nodes = nodesRepo(db())
    const node = nodes.create(input('a', 'h1'))
    expect(nodes.revoke(node.id)).toMatchObject({ status: 'revoked' })
    expect(nodes.get(node.id)?.revokedAt).not.toBeNull()
    expect(nodes.findByTokenHash('h1')).toBeUndefined()
    expect(nodes.list()).toHaveLength(0)
    expect(nodes.list({ includeRevoked: true })).toHaveLength(1)
    expect(nodes.touch(node.id)).toBeUndefined()
    expect(nodes.setStatus(node.id, 'online')).toBeUndefined()
    // the old hash can be issued again to a new node
    expect(nodes.create(input('a', 'h1')).id).not.toBe(node.id)
  })

  test('names are unique among active nodes only', () => {
    const nodes = nodesRepo(db())
    const first = nodes.create(input('laptop-e', 'h1'))
    expect(() => nodes.create(input('laptop-e', 'h2'))).toThrow()
    nodes.revoke(first.id)
    expect(nodes.create(input('laptop-e', 'h3')).name).toBe('laptop-e')
  })
  test('a pending rotation also matches; committing it makes the new token current', () => {
    let t = 100
    const nodes = nodesRepo(db(), { now: () => t })
    const node = nodes.create(input('laptop-e', 'h1'))
    expect(node.tokenIssuedAt).toBe(100)
    t = 500
    expect(nodes.beginTokenRotation(node.id, 'h2')).toMatchObject({ tokenIssuedAt: 100 })
    expect(nodes.findByTokenHash('h1')?.id).toBe(node.id)
    expect(nodes.findByTokenHash('h2')?.id).toBe(node.id)
    expect(nodes.commitTokenRotation(node.id, 'h1')).toBeUndefined()
    expect(nodes.commitTokenRotation(node.id, 'h2')).toMatchObject({ tokenIssuedAt: 500 })
    expect(nodes.findByTokenHash('h1')).toBeUndefined()
    expect(nodes.findByTokenHash('h2')?.id).toBe(node.id)
    // a repeat of the commit changes nothing
    expect(nodes.commitTokenRotation(node.id, 'h2')).toBeUndefined()
  })

  test('revoke scrambles a pending token too, and a revoked node cannot start a rotation', () => {
    const nodes = nodesRepo(db())
    const node = nodes.create(input('a', 'h1'))
    nodes.beginTokenRotation(node.id, 'h2')
    nodes.revoke(node.id)
    expect(nodes.findByTokenHash('h1')).toBeUndefined()
    expect(nodes.findByTokenHash('h2')).toBeUndefined()
    expect(nodes.commitTokenRotation(node.id, 'h2')).toBeUndefined()
    expect(nodes.beginTokenRotation(node.id, 'h3')).toBeUndefined()
  })
})

describe('pairingRepo', () => {
  test('a code is consumable once', () => {
    const pairing = pairingRepo(db(), { now: () => 1000 })
    expect(pairing.create({ hash: 'c1', createdBy: 'owner', ttlMs: 600_000 })).toEqual({
      ok: true,
      expiresAt: 601_000,
    })
    expect(pairing.consume('c1', 'n1')).toEqual({ ok: true })
    expect(pairing.consume('c1')).toEqual({ ok: false, reason: 'used' })
    expect(pairing.consume('nope')).toEqual({ ok: false, reason: 'unknown' })
    expect(pairing.active('owner')).toBe(0)
  })

  test('expired codes are refused and purged', () => {
    let t = 0
    const pairing = pairingRepo(db(), { now: () => t })
    pairing.create({ hash: 'c1', createdBy: 'owner', ttlMs: 10 })
    expect(pairing.active('owner')).toBe(1)
    t = 10
    expect(pairing.consume('c1')).toEqual({ ok: false, reason: 'expired' })
    expect(pairing.active('owner')).toBe(0)
    expect(pairing.purgeExpired()).toBe(1)
    expect(pairing.consume('c1')).toEqual({ ok: false, reason: 'unknown' })
    // a code kept for a while after it expired: the join still says "expired", not "unknown"
    pairing.create({ hash: 'c2', createdBy: 'owner', ttlMs: 10 })
    t += 1_000
    expect(pairing.purgeExpired(5_000)).toBe(0)
    expect(pairing.consume('c2')).toEqual({ ok: false, reason: 'expired' })
    t += 10_000
    expect(pairing.purgeExpired(5_000)).toBe(1)
  })

  test('refuses a fourth active code until one is used or expires', () => {
    let t = 0
    const pairing = pairingRepo(db(), { now: () => t })
    for (const h of ['a', 'b', 'c']) {
      expect(pairing.create({ hash: h, createdBy: 'owner', ttlMs: 100 }).ok).toBe(true)
    }
    expect(pairing.create({ hash: 'd', createdBy: 'owner', ttlMs: 100 })).toEqual({
      ok: false,
      reason: 'limit',
    })
    pairing.consume('a')
    expect(pairing.create({ hash: 'd', createdBy: 'owner', ttlMs: 100 }).ok).toBe(true)
    t = 100
    expect(pairing.create({ hash: 'e', createdBy: 'owner', ttlMs: 100 }).ok).toBe(true)
  })
})

describe('budget status', () => {
  test('reports limit, spending and reservations for the month', async () => {
    const sqlite = db()
    const ledger = sqliteBudgetLedger(sqlite)
    expect(budgetStatus(sqlite, ['owner'])[0]).toMatchObject({
      scope: 'owner',
      limitUsd: null,
      spentUsd: 0,
      reservedUsd: 0,
    })
    setBudgetLimit(sqlite, 'owner', 5)
    await ledger.record({ scopes: ['owner'], amountUsd: 1.25, key: 'a' })
    const held = await ledger.reserve({
      scopes: ['owner'],
      amountUsd: 0.5,
      ttlMs: 60_000,
      key: 'b',
    })
    expect(held.ok).toBe(true)
    const [status] = budgetStatus(sqlite, ['owner', 'owner'])
    expect(budgetStatus(sqlite, ['owner', 'owner'])).toHaveLength(1)
    expect(status).toEqual({
      scope: 'owner',
      limitUsd: 5,
      spentUsd: 1.25,
      reservedUsd: 0.5,
      periodStart: currentPeriod(),
    })
    setBudgetLimit(sqlite, 'owner', null)
    expect(budgetStatus(sqlite, ['owner'])[0]?.limitUsd).toBeNull()
  })

  test('a later month inherits the limit but starts with no spending', async () => {
    const sqlite = db()
    setBudgetLimit(sqlite, 'owner', 3)
    await sqliteBudgetLedger(sqlite).record({ scopes: ['owner'], amountUsd: 2, key: 'a' })
    const next = Date.UTC(new Date().getUTCFullYear() + 1, 0, 15)
    expect(budgetStatus(sqlite, ['owner'], next)[0]).toMatchObject({
      limitUsd: 3,
      spentUsd: 0,
      periodStart: currentPeriod(next),
    })
  })

  test('currentPeriod is the first instant of the UTC month', () => {
    expect(currentPeriod(Date.UTC(2026, 9, 26, 23, 59))).toBe(Date.UTC(2026, 9, 1))
  })
})

describe('credentialsRepo', () => {
  test('creates, finds, touches, lists by kind and revokes', () => {
    const sqlite = db()
    tokensRepo(sqlite).createOwner({ id: 'owner', name: 'Owner', role: 'owner' })
    let t = 1000
    const repo = credentialsRepo(sqlite, { now: () => t })
    repo.create({ id: 'a', personId: 'owner', kind: 'device', label: 'phone', secretHash: 'h' })
    t = 2000
    repo.create({ id: 'b', personId: 'owner', kind: 'token', label: 'ci', secretHash: 'h2' })
    expect(repo.find('a')).toMatchObject({ kind: 'device', secretHash: 'h', lastSeenAt: null })
    expect(repo.find('a')?.person.role).toBe('owner')
    expect(repo.find('nope')).toBeUndefined()
    repo.touch('a', '10.0.0.1', 3000)
    expect(repo.find('a')).toMatchObject({ lastSeenAt: 3000, lastIp: '10.0.0.1' })
    expect(repo.list('owner').map((c) => c.id)).toEqual(['b', 'a'])
    expect(repo.list('owner', 'device').map((c) => c.id)).toEqual(['a'])
    expect(repo.revoke('a', 'token')).toBe(false) // wrong kind
    expect(repo.revoke('a', 'device')).toBe(true)
    expect(repo.revoke('a')).toBe(false)
    expect(repo.revokeAll('owner')).toBe(1)
  })
})

describe('deviceRequestsRepo', () => {
  const input = (id: string, ip = '1.1.1.1') => ({
    id,
    codeHash: `c-${id}`,
    pollHash: `p-${id}`,
    label: 'x',
    ip,
    secretHash: 's',
    ttlMs: 1000,
  })

  test('creates, approves once, lists pending, caps pending per address, purges', () => {
    let t = 0
    const repo = deviceRequestsRepo(db(), { now: () => t })
    for (let i = 0; i < MAX_PENDING_PER_IP; i++) expect(repo.create(input(`r${i}`)).ok).toBe(true)
    expect(repo.create(input('over'))).toEqual({ ok: false, reason: 'limit' })
    expect(repo.create(input('other', '2.2.2.2')).ok).toBe(true)
    expect(repo.findPendingByCode('c-r0')?.id).toBe('r0')
    expect(repo.approve('r0', 'cred')).toBe(true)
    expect(repo.approve('r0', 'cred2')).toBe(false) // no longer pending
    expect(repo.get('r0')).toMatchObject({
      status: 'approved',
      credentialId: 'cred',
      pollHash: 'p-r0',
    })
    expect(repo.deny('r1')).toBe(true)
    expect(repo.listPending().map((r) => r.id)).toEqual(['other', 'r2', 'r3', 'r4'])
    t = 1500 // expired
    expect(repo.findPendingByCode('c-r2')).toBeUndefined()
    expect(repo.approve('r2', 'x')).toBe(false)
    expect(repo.purgeExpired(0).removed).toBe(6)
  })
})

describe('auditRepo', () => {
  test('appends and lists newest first with parsed detail', () => {
    let t = 1
    const repo = auditRepo(db(), { now: () => t++ })
    repo.add({ kind: 'a', actor: 'system', via: 'offline' })
    repo.add({ kind: 'b', actor: 'owner', via: 'local', detail: { n: 1 } })
    expect(repo.list(10)).toEqual([
      { id: 2, at: 2, kind: 'b', actor: 'owner', via: 'local', detail: { n: 1 } },
      { id: 1, at: 1, kind: 'a', actor: 'system', via: 'offline', detail: {} },
    ])
    expect(repo.list(1)).toHaveLength(1)
  })
})

describe('secretsRepo', () => {
  test('secrets are per person and kind; counters upsert, lock and reset', () => {
    const sqlite = db()
    const tokens = tokensRepo(sqlite)
    tokens.createOwner({ id: 'owner', name: 'Owner', role: 'owner' })
    const secrets = secretsRepo(sqlite)
    expect(secrets.findPerson('owner')?.id).toBe('owner')
    expect(secrets.findPerson('nobody')).toBeUndefined()
    secrets.set('owner', 'password', 'h1', 1)
    secrets.set('owner', 'pin', 'h2', 1)
    secrets.set('owner', 'password', 'h3', 2)
    expect(secrets.get('owner', 'password')).toEqual({ hash: 'h3', updatedAt: 2 })
    expect(secrets.kinds('owner')).toEqual(['password', 'pin'])
    expect(secrets.clear('owner', 'pin')).toBe(true)
    expect(secrets.clear('owner', 'pin')).toBe(false)

    expect(secrets.fail('owner', '1.1.1.1', 10).failures).toBe(1)
    expect(secrets.fail('owner', '1.1.1.1', 20)).toEqual({
      failures: 2,
      lastFailureAt: 20,
      lockedAt: null,
    })
    expect(secrets.locked('owner')).toBe(false)
    secrets.lock('owner', 30)
    expect(secrets.locked('owner')).toBe(true)
    expect(secrets.prune(1000)).toBe(1) // the locked row stays
    expect(secrets.reset('owner')).toBe(true)
    expect(secrets.attempt('owner', '1.1.1.1')).toBeUndefined()
    expect(secrets.reset('owner')).toBe(false)
  })
})

describe('credentials step-up window', () => {
  test('setElevated stores the end; a revoked credential cannot be elevated', () => {
    const sqlite = db()
    tokensRepo(sqlite).createOwner({ id: 'owner', name: 'Owner', role: 'owner' })
    const credentials = credentialsRepo(sqlite)
    credentials.create({ id: 'c1', personId: 'owner', kind: 'device', label: 'a', secretHash: 'x' })
    expect(credentials.find('c1')?.elevatedUntil).toBeNull()
    expect(credentials.setElevated('c1', 99)).toBe(true)
    expect(credentials.find('c1')?.elevatedUntil).toBe(99)
    credentials.revoke('c1')
    expect(credentials.setElevated('c1', 100)).toBe(false)
  })
})

describe('auditRepo.prune', () => {
  test('deletes rows strictly older than the cutoff and returns the count', () => {
    const sqlite = db()
    let t = 1_000
    const audit = auditRepo(sqlite, { now: () => t })
    for (const kind of ['a', 'b', 'c', 'd']) {
      audit.add({ kind, actor: 'owner', via: 'local' })
      t += 100
    }
    expect(audit.prune(1_200)).toBe(2) // at 1000 and 1100 go, 1200 stays
    expect(audit.list(10).map((e) => e.kind)).toEqual(['d', 'c'])
    expect(audit.prune(0)).toBe(0)
  })
})

describe('deliveriesRepo (P25.1.2, docs/specs/delivery.md "Data")', () => {
  const row = (
    id: string,
    extra: Partial<Parameters<ReturnType<typeof deliveriesRepo>['create']>[0]> = {},
  ) => ({
    id,
    source: 'plugin:reminders',
    recipientId: 'ana',
    name: 'reminder',
    needs: '{"mode":"wake"}',
    text: 'pay the rent',
    ...extra,
  })

  test('create is idempotent by id: a second create returns the stored row and sends nothing new', () => {
    let at = 1_000
    const deliveries = deliveriesRepo(db(), { now: () => at })
    const first = deliveries.create(row('run-1'))
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({
      status: 'pending',
      text: 'pay the rent',
      attempts: 0,
      nextAttemptAt: 1_000,
    })
    at = 5_000
    const again = deliveries.create(row('run-1', { text: 'changed' }))
    expect(again.created).toBe(false)
    expect(again.record.text).toBe('pay the rent')
    expect(again.record.createdAt).toBe(1_000)
  })

  test('due returns pending rows whose attempt is due, oldest first, at most the limit', () => {
    const deliveries = deliveriesRepo(db(), { now: () => 0 })
    deliveries.create(row('late', { nextAttemptAt: 300 }))
    deliveries.create(row('early', { nextAttemptAt: 100 }))
    deliveries.create(row('future', { nextAttemptAt: 900 }))
    expect(deliveries.due(500, 10).map((r) => r.id)).toEqual(['early', 'late'])
    expect(deliveries.due(500, 1).map((r) => r.id)).toEqual(['early'])
  })

  test('settle to delivered blanks the text; a queued row keeps it and gets the next attempt', () => {
    const deliveries = deliveriesRepo(db(), { now: () => 0 })
    deliveries.create(row('queued'))
    deliveries.create(row('done'))
    expect(
      deliveries.settle('queued', {
        status: 'pending',
        attempts: 1,
        nextAttemptAt: 60_000,
        reason: 'unavailable',
      }),
    ).toBe(true)
    expect(deliveries.get('queued')).toMatchObject({
      status: 'pending',
      text: 'pay the rent',
      attempts: 1,
      nextAttemptAt: 60_000,
    })
    expect(deliveries.settle('done', { status: 'delivered', attempts: 1, route: 'front' })).toBe(
      true,
    )
    expect(deliveries.get('done')).toMatchObject({ status: 'delivered', text: '', route: 'front' })
    expect(deliveries.settle('nope', { status: 'failed', attempts: 0 })).toBe(false)
  })

  test('pendingFor and deletePendingFor touch only the recipient pending rows', () => {
    const deliveries = deliveriesRepo(db(), { now: () => 0 })
    deliveries.create(row('a-1'))
    deliveries.create(row('a-2'))
    deliveries.create(row('b-1', { recipientId: 'ben' }))
    deliveries.create(row('a-done'))
    deliveries.settle('a-done', { status: 'failed', attempts: 1, reason: 'budget' })
    expect(deliveries.pendingFor('ana').map((r) => r.id)).toEqual(['a-1', 'a-2'])
    expect(deliveries.deletePendingFor('ana')).toBe(2)
    expect(deliveries.get('a-done')).toBeDefined()
    expect(deliveries.get('b-1')).toBeDefined()
  })

  test('pendingBefore counts pending rows created before the cut-off', () => {
    let at = 100
    const deliveries = deliveriesRepo(db(), { now: () => at })
    deliveries.create(row('old'))
    at = 900
    deliveries.create(row('new'))
    expect(deliveries.pendingBefore(500)).toBe(1)
  })
})
