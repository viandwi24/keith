import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProtocolDefinitionSchema } from '@keith/contracts'
import {
  agendaRepo,
  migrateDatabase,
  openDatabase,
  protocolProposalsRepo,
  protocolRunsRepo,
  protocolsRepo,
  type Sqlite,
} from '@keith/db'
import { removedFolderOf } from '../people/index.ts'
import { HYPOTHALAMUS_FILE, hypothalamusRemoval } from './removal.ts'
import { createProtocolService } from './service.ts'

// A removed person's protocol data (ADR-0027 §26): stop disables and cancels, keep writes the dump, export copies it,
// purge deletes that person's rows only.

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 10, 9, 0)
const reminder = ProtocolDefinitionSchema.parse({
  trigger: { kind: 'time', at: NOW + 3_600_000 },
  steps: [{ id: 'say', kind: 'notify', to: 'owner-of-run', text: 'Stand up' }],
  start: 'say',
})

function seeded(): { sqlite: Sqlite; dataDir: string; anaRun: string; benRun: string } {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-hypothalamus-'))
  dirs.push(dataDir)
  const service = createProtocolService({
    protocols: protocolsRepo(sqlite),
    runs: protocolRunsRepo(sqlite),
    settings: { maxPerPerson: () => 20 },
    audit: { record: () => {} },
    now: () => NOW,
  })
  const ana = {
    id: 'ana',
    role: 'member' as const,
    capabilities: new Set(['chat']),
    via: 'tcp' as const,
  }
  const ben = { ...ana, id: 'ben' }
  const anaView = service.save(ana, { name: 'standup', definition: reminder })
  const benView = service.save(ben, { name: 'standup', definition: reminder })
  const runs = protocolRunsRepo(sqlite)
  const run = (id: string, protocolId: string, person: string, status: 'waiting' | 'done') =>
    runs.start(
      {
        id,
        protocolId,
        version: 1,
        person,
        triggerRef: `ref-${id}`,
        step: status === 'waiting' ? 'say' : null,
        status,
        wakeAt: status === 'waiting' ? NOW + 60_000 : null,
        endedAt: status === 'done' ? NOW : null,
      },
      NOW,
    )
  run('run-ana-waiting', anaView.id, 'ana', 'waiting')
  run('run-ana-done', anaView.id, 'ana', 'done')
  run('run-ben-waiting', benView.id, 'ben', 'waiting')
  protocolProposalsRepo(sqlite).create(
    {
      id: 'prop-ana',
      person: 'ana',
      definition: JSON.stringify(reminder),
      reason: 'stand up',
      source: '{}',
      expiresAt: NOW + 1,
    },
    NOW,
  )
  agendaRepo(sqlite).add(
    { id: 'ag-ana', person: 'ana', what: 'call', startsAt: NOW, status: 'confirmed' },
    NOW,
  )
  agendaRepo(sqlite).add(
    { id: 'ag-ben', person: 'ben', what: 'call', startsAt: NOW, status: 'confirmed' },
    NOW,
  )
  return { sqlite, dataDir, anaRun: 'run-ana-waiting', benRun: 'run-ben-waiting' }
}

const count = (sqlite: Sqlite, table: string, person: string): number =>
  (sqlite.query(`SELECT COUNT(*) AS n FROM ${table} WHERE person = ?`).get(person) as { n: number })
    .n

describe('hypothalamus removal', () => {
  test('stop disables the protocols and cancels the open runs of the person only', () => {
    const { sqlite, dataDir } = seeded()
    hypothalamusRemoval({ sqlite, dataDir, now: () => NOW }).stop?.('ana')
    const protocols = sqlite.query('SELECT owner, enabled FROM protocols ORDER BY owner').all()
    expect(protocols).toEqual([
      { owner: 'ana', enabled: 0 },
      { owner: 'ben', enabled: 1 },
    ])
    const runs = sqlite
      .query(
        "SELECT id, status, wake_at FROM protocol_runs WHERE person IN ('ana', 'ben') ORDER BY id",
      )
      .all()
    expect(runs).toEqual([
      { id: 'run-ana-done', status: 'done', wake_at: null },
      { id: 'run-ana-waiting', status: 'cancelled', wake_at: null },
      { id: 'run-ben-waiting', status: 'waiting', wake_at: NOW + 60_000 },
    ])
  })

  test('keep writes one dump of the person rows into the kept folder; the live rows stay', () => {
    const { sqlite, dataDir } = seeded()
    const folder = join(dataDir, 'kept')
    mkdirSync(folder, { recursive: true })
    const hooks = hypothalamusRemoval({ sqlite, dataDir, now: () => NOW })
    expect(hooks.keep('ana', folder)).toBeUndefined()
    const dump = JSON.parse(readFileSync(join(folder, HYPOTHALAMUS_FILE), 'utf8'))
    expect(dump.personId).toBe('ana')
    expect(dump.protocols.map((p: { owner: string }) => p.owner)).toEqual(['ana'])
    expect(dump.protocol_versions).toHaveLength(1)
    expect(dump.protocol_runs.map((r: { id: string }) => r.id).sort()).toEqual([
      'run-ana-done',
      'run-ana-waiting',
    ])
    expect(dump.agenda_items.map((a: { id: string }) => a.id)).toEqual(['ag-ana'])
    expect(dump.protocol_proposals.map((p: { id: string }) => p.id)).toEqual(['prop-ana'])
    expect(count(sqlite, 'protocol_runs', 'ana')).toBe(2)
  })

  test('export of a live person writes the rows as they are; of a removed person it copies the kept dump', () => {
    const { sqlite, dataDir } = seeded()
    const hooks = hypothalamusRemoval({ sqlite, dataDir, now: () => NOW })
    const live = join(dataDir, 'export-live')
    mkdirSync(live, { recursive: true })
    hooks.export('ana', live)
    expect(JSON.parse(readFileSync(join(live, HYPOTHALAMUS_FILE), 'utf8')).personId).toBe('ana')

    const folder = removedFolderOf(dataDir, 'ana')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'manifest.json'), '{}')
    writeFileSync(join(folder, HYPOTHALAMUS_FILE), '{"personId":"ana","kept":true}\n')
    const removed = join(dataDir, 'export-removed')
    mkdirSync(removed, { recursive: true })
    hooks.export('ana', removed)
    expect(readFileSync(join(removed, HYPOTHALAMUS_FILE), 'utf8')).toBe(
      '{"personId":"ana","kept":true}\n',
    )
    expect(existsSync(folder)).toBe(true)
  })

  test('purge deletes the person rows in dependency order and leaves the other person untouched', () => {
    const { sqlite, dataDir } = seeded()
    hypothalamusRemoval({ sqlite, dataDir, now: () => NOW }).purge?.('ana', join(dataDir, 'kept'))
    expect(count(sqlite, 'protocol_runs', 'ana')).toBe(0)
    expect(count(sqlite, 'protocol_proposals', 'ana')).toBe(0)
    expect(count(sqlite, 'agenda_items', 'ana')).toBe(0)
    expect(sqlite.query('SELECT owner FROM protocols').all()).toEqual([{ owner: 'ben' }])
    expect(sqlite.query('SELECT COUNT(*) AS n FROM protocol_versions').get()).toEqual({ n: 1 })
    expect(count(sqlite, 'protocol_runs', 'ben')).toBe(1)
    expect(count(sqlite, 'agenda_items', 'ben')).toBe(1)
  })
})
