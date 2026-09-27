import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { backupDatabase } from './backup.ts'
import { openDb } from './db.ts'
import { person } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'

const dbs: TestDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): TestDb {
  const db = createTestDb()
  dbs.push(db)
  return db
}

function integrity(path: string): string {
  const db = new Database(path, { readonly: true })
  try {
    return String(db.query('PRAGMA integrity_check').values()[0]?.[0])
  } finally {
    db.close()
  }
}

// Inserts 1, 2, 3 … one transaction each, posting every committed n, until told to stop.
const WRITER = `
import { Database } from 'bun:sqlite'
let db = null
let n = 0
let stop = false
self.onmessage = (e) => {
  if (e.data === 'stop') { stop = true; return }
  db = new Database(e.data)
  db.run('PRAGMA busy_timeout = 5000')
  const insert = db.prepare('INSERT INTO backup_probe (n) VALUES (?)')
  const loop = () => {
    if (stop) { db.close(); process.exit(0) }
    for (let i = 0; i < 20; i++) insert.run(++n)
    postMessage(n)
    setTimeout(loop, 0)
  }
  loop()
}
`

describe('backupDatabase', () => {
  test('snapshots a live WAL database while another connection keeps writing', async () => {
    const db = testDb()
    for (let n = 1; n <= 20; n++) await db.repos.persons.create(person(n))
    // Rows committed through the WAL, not yet checkpointed into the main file.
    expect(existsSync(`${db.path}-wal`)).toBe(true)

    // Another connection on another thread keeps committing rows, as a running Keith would.
    const setup = new Database(db.path, { strict: true })
    setup.run('CREATE TABLE backup_probe (n INTEGER PRIMARY KEY)')
    setup.close()
    const worker = new Worker(URL.createObjectURL(new Blob([WRITER], { type: 'application/javascript' })))
    const progress: number[] = []
    worker.onmessage = (e: MessageEvent<number>) => progress.push(e.data)
    worker.postMessage(db.path)
    while (progress.length < 5) await Bun.sleep(1)
    const committedBefore = progress.at(-1) ?? 0

    const dest = join(db.dir, 'snapshot.db')
    await backupDatabase(db.path, dest, new AbortController().signal)
    worker.postMessage('stop')
    await new Promise((resolve) => worker.addEventListener('close', resolve))

    expect(integrity(dest)).toBe('ok')
    const copy = openDb(dest)
    try {
      expect((await copy.repos.persons.list()).length).toBe(20)
    } finally {
      copy.close()
    }
    const raw = new Database(dest, { readonly: true })
    try {
      const rows = raw
        .query('SELECT n FROM backup_probe ORDER BY n')
        .values()
        .map((r) => Number(r[0]))
      // Every row committed before the backup started, and no gaps: a single consistent snapshot.
      expect(rows.length).toBeGreaterThanOrEqual(committedBefore)
      expect(rows).toEqual(rows.map((_, i) => i + 1))
    } finally {
      raw.close()
    }
    expect(readdirSync(db.dir).filter((f) => f.includes('.partial-'))).toEqual([])
  })

  test('an aborted signal rejects and leaves no file', async () => {
    const db = testDb()
    await db.repos.persons.create(person(1))
    const dest = join(db.dir, 'snapshot.db')
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(backupDatabase(db.path, dest, controller.signal)).rejects.toThrow('stop')
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(db.dir).filter((f) => f.startsWith('snapshot'))).toEqual([])
  })

  test('refuses an existing target and a missing source', async () => {
    const db = testDb()
    const dest = join(db.dir, 'snapshot.db')
    await Bun.write(dest, 'keep me')
    await expect(backupDatabase(db.path, dest, new AbortController().signal)).rejects.toThrow(
      'already exists',
    )
    expect(await Bun.file(dest).text()).toBe('keep me')
    await expect(
      backupDatabase(join(db.dir, 'missing.db'), join(db.dir, 'x.db'), new AbortController().signal),
    ).rejects.toThrow('not found')
  })
})
