import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type DreamingRepo,
  dreamingRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import { parseMemoryFile, renderMemoryFile } from './entries.ts'
import { ARCHIVE_TIER, memoryFileOf, stagedFileOf, undoDirOf } from './files.ts'
import { purgeDreamFiles } from './purge.ts'

// The file purge of the dreaming module (P35.5.6): archive entries 30 days after their marker date, undo folders and staged plans
// 7 days after their run ended, each table audited as `data.pruned { table, count }`.

const PERSON = 'ana'
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 11, 12)

let dataDir: string
let sqlite: Sqlite
let repo: DreamingRepo
let clock: number
let audits: Array<{ kind: string; actor: string; via: string; detail?: unknown }>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-purge-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = NOW
  repo = dreamingRepo(sqlite, { now: () => clock })
  audits = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const purge = () =>
  purgeDreamFiles({
    dataDir,
    repo,
    audit: {
      record: (event) => {
        audits.push(event)
      },
    },
    now: () => NOW,
  })

/** A run that ended `daysAgo` days before NOW (the row is written with the repo's clock). */
function endedRun(daysAgo: number): string {
  clock = NOW - daysAgo * DAY
  const id = repo.startRun({ personId: PERSON, trigger: 'schedule', mode: 'propose' })
  repo.endRun(id, { status: 'staged' })
  clock = NOW
  return id
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('purgeDreamFiles', () => {
  test('an undo folder of a run that ended 8 days ago is deleted and audited; a 2-day-old one stays', () => {
    const old = endedRun(8)
    const recent = endedRun(2)
    writeFile(join(undoDirOf(dataDir, PERSON, old), 'recent.md'), 'before')
    writeFile(join(undoDirOf(dataDir, PERSON, recent), 'recent.md'), 'before')

    const counts = purge()

    expect(counts).toEqual({ archive: 0, undo: 1, staged: 0 })
    expect(existsSync(undoDirOf(dataDir, PERSON, old))).toBe(false)
    expect(existsSync(undoDirOf(dataDir, PERSON, recent))).toBe(true)
    expect(audits).toEqual([
      {
        kind: 'data.pruned',
        actor: 'system',
        via: 'local',
        detail: { table: 'dreaming.undo', count: 1 },
      },
    ])
  })

  test('a staged plan of a run that ended 8 days ago is deleted and audited as dreaming.staged', () => {
    const old = endedRun(8)
    writeFile(stagedFileOf(dataDir, PERSON, old), '{}')

    expect(purge()).toEqual({ archive: 0, undo: 0, staged: 1 })
    expect(existsSync(stagedFileOf(dataDir, PERSON, old))).toBe(false)
    expect(audits.map((a) => a.detail)).toEqual([{ table: 'dreaming.staged', count: 1 }])
  })

  test('a run still running has no end, so its folder stays', () => {
    clock = NOW - 20 * DAY
    const running = repo.startRun({ personId: PERSON, trigger: 'manual', mode: 'auto' })
    clock = NOW
    writeFile(join(undoDirOf(dataDir, PERSON, running), 'recent.md'), 'before')

    expect(purge()).toEqual({ archive: 0, undo: 0, staged: 0 })
    expect(existsSync(undoDirOf(dataDir, PERSON, running))).toBe(true)
  })

  test('archive entries older than 30 days by their marker date are removed; the others and the front lines stay', () => {
    const entry = (text: string, date?: string) => ({
      kind: 'dream' as const,
      text,
      source: { sessionId: 's1', messageId: 'm1' },
      ...(date === undefined ? {} : { superseded: { date, reason: 'changed' } }),
    })
    const file = memoryFileOf(dataDir, PERSON, ARCHIVE_TIER)
    writeFile(
      file,
      renderMemoryFile([
        entry('old fact', '2026-09-01'),
        { kind: 'front', line: '- a line the front agent wrote' },
        entry('recent fact', '2026-11-05'),
      ]),
    )

    expect(purge()).toEqual({ archive: 1, undo: 0, staged: 0 })

    const left = parseMemoryFile(readFileSync(file, 'utf8'))
    const texts = left.map((block) => (block.kind === 'dream' ? block.text : block.line))
    expect(texts).toEqual(['- a line the front agent wrote', 'recent fact'])
    expect(audits.map((a) => a.detail)).toEqual([{ table: 'dreaming.archive', count: 1 }])
  })

  test('the archive rewrite goes through the atomic helper: the new file is in place and no temporary file is left', () => {
    const file = memoryFileOf(dataDir, PERSON, ARCHIVE_TIER)
    writeFile(
      file,
      renderMemoryFile([
        {
          kind: 'dream',
          text: 'old fact',
          source: { sessionId: 's1', messageId: 'm1' },
          superseded: { date: '2026-09-01', reason: 'changed' },
        },
        { kind: 'dream', text: 'recent fact', source: { sessionId: 's1', messageId: 'm2' } },
      ]),
    )
    expect(purge()).toEqual({ archive: 1, undo: 0, staged: 0 })
    expect(readFileSync(file, 'utf8')).toBe(
      renderMemoryFile([
        { kind: 'dream', text: 'recent fact', source: { sessionId: 's1', messageId: 'm2' } },
      ]),
    )
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('nothing to remove: no audit row', () => {
    endedRun(1)
    expect(purge()).toEqual({ archive: 0, undo: 0, staged: 0 })
    expect(audits).toEqual([])
  })
})
