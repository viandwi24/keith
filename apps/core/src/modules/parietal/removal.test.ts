import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientsRepo,
  migrateDatabase,
  openDatabase,
  presenceDisclosureRepo,
  presenceSignalsRepo,
  presenceStatusRepo,
  type Sqlite,
} from '@keith/db'
import { removedFolderOf } from '../people/index.ts'
import { PRESENCE_FILE, parietalRemoval } from './removal.ts'

// A removed person's presence (ADR-0027 §26): keep writes the rows into the kept folder and leaves the live rows,
// export writes the same record, purge deletes the live rows of that person only.

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function seeded(): { sqlite: Sqlite; dataDir: string } {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-parietal-'))
  dirs.push(dataDir)
  const uuid = '00000000-0000-4000-8000-000000000001'
  clientsRepo(sqlite).register(
    'ana',
    { id: uuid, kind: 'tui', label: 'laptop', capabilities: ['chat'], version: '1' },
    100,
  )
  clientsRepo(sqlite).register(
    'ben',
    {
      id: '00000000-0000-4000-8000-000000000002',
      kind: 'tui',
      label: 'desk',
      capabilities: ['chat'],
      version: '1',
    },
    100,
  )
  presenceSignalsRepo(sqlite).record({ personId: 'ana', type: 'activity', at: 200 })
  presenceSignalsRepo(sqlite).record({ personId: 'ben', type: 'activity', at: 200 })
  presenceStatusRepo(sqlite).set('ana', { note: 'lunch', until: null, setAt: 150 })
  presenceDisclosureRepo(sqlite).set('ana', 'owner', 'detail')
  return { sqlite, dataDir }
}

const count = (sqlite: Sqlite, table: string, personId: string): number =>
  sqlite
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE person_id = ?`)
    .get(personId)?.n ?? 0

describe('the parietal part of a removal', () => {
  test('keep writes the presence rows into the kept folder and leaves the live rows', async () => {
    const { sqlite, dataDir } = seeded()
    const hooks = parietalRemoval({ sqlite, dataDir })
    const folder = removedFolderOf(dataDir, 'ana')
    mkdirSync(folder, { recursive: true })
    await hooks.keep('ana', folder)

    const kept = JSON.parse(readFileSync(join(folder, PRESENCE_FILE), 'utf8')) as Record<
      string,
      unknown[]
    >
    expect(kept.clients).toHaveLength(1)
    expect(kept.presence_signals).toHaveLength(1)
    expect(kept.presence_status).toHaveLength(1)
    expect(kept.presence_disclosure).toHaveLength(1)
    expect(count(sqlite, 'clients', 'ana')).toBe(1)
  })

  test('purge deletes the live rows of that person only', async () => {
    const { sqlite, dataDir } = seeded()
    const hooks = parietalRemoval({ sqlite, dataDir })
    await hooks.purge('ana', removedFolderOf(dataDir, 'ana'))
    for (const table of ['clients', 'presence_signals', 'presence_status', 'presence_disclosure'])
      expect(count(sqlite, table, 'ana')).toBe(0)
    expect(count(sqlite, 'clients', 'ben')).toBe(1)
    expect(count(sqlite, 'presence_signals', 'ben')).toBe(1)
  })

  test('export of a removed person copies the kept record', async () => {
    const { sqlite, dataDir } = seeded()
    const hooks = parietalRemoval({ sqlite, dataDir })
    const folder = removedFolderOf(dataDir, 'ana')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'manifest.json'), '{}')
    await hooks.keep('ana', folder)
    const dest = join(folder, 'export')
    mkdirSync(dest)
    await hooks.export('ana', dest)
    expect(readFileSync(join(dest, PRESENCE_FILE), 'utf8')).toBe(
      readFileSync(join(folder, PRESENCE_FILE), 'utf8'),
    )
    expect(existsSync(join(dest, PRESENCE_FILE))).toBe(true)
  })

  test('export of a live person writes the rows as they are now', async () => {
    const { sqlite, dataDir } = seeded()
    const hooks = parietalRemoval({ sqlite, dataDir })
    const dest = mkdtempSync(join(tmpdir(), 'keith-parietal-export-'))
    dirs.push(dest)
    await hooks.export('ben', dest)
    const written = JSON.parse(readFileSync(join(dest, PRESENCE_FILE), 'utf8')) as {
      personId: string
      clients: unknown[]
    }
    expect(written.personId).toBe('ben')
    expect(written.clients).toHaveLength(1)
  })
})
