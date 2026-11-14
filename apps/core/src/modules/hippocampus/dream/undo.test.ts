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
import { join } from 'node:path'
import { memoryDir } from '../hippocampus.ts'
import {
  ARCHIVE_TIER,
  diaryTier,
  memoryFileOf,
  PROFILE_TIER,
  RECENT_TIER,
  readMemoryBytes,
  topicTier,
  UNDO_WINDOW_MS,
  undoDirOf,
  writeMemoryFile,
} from './files.ts'
import {
  decideUndo,
  openRunWriter,
  preimagesOf,
  restoreRun,
  undoUntilFrom,
  WRITTEN_FILE,
} from './undo.ts'

const RUN = 'run-0001'
const PERSON = 'owner'
const text = (value: string) => new TextEncoder().encode(value)
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-undo-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('preimages', () => {
  test('a changed file keeps its exact previous bytes in the undo folder', () => {
    const original = new Uint8Array([0, 200, 255, 10, 13, 10, 97])
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, original)
    openRunWriter(dataDir, PERSON, RUN).write(PROFILE_TIER, '# new profile\n')
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('# new profile\n'))
    expect(preimagesOf(dataDir, PERSON, RUN)).toEqual([
      { path: 'profile.md', tier: PROFILE_TIER, created: false },
    ])
    const saved = readFileSync(join(undoDirOf(dataDir, PERSON, RUN), 'profile.md'))
    expect(new Uint8Array(saved)).toEqual(original)
  })

  test('a file the run creates gets a .created marker, not a preimage', () => {
    openRunWriter(dataDir, PERSON, RUN).write(diaryTier('2026-11-11'), '# day\n')
    expect(preimagesOf(dataDir, PERSON, RUN)).toEqual([
      { path: 'dreams/2026-11-11.md', tier: diaryTier('2026-11-11'), created: true },
    ])
    expect(
      existsSync(join(undoDirOf(dataDir, PERSON, RUN), 'dreams', '2026-11-11.md.created')),
    ).toBe(true)
  })

  test('a second write of the same file in the same run takes no second preimage', () => {
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, 'first original\n')
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(RECENT_TIER, 'edit one\n')
    writer.write(RECENT_TIER, 'edit two\n')
    // a second writer on the same run (as after a restart) takes none either
    openRunWriter(dataDir, PERSON, RUN).write(RECENT_TIER, 'edit three\n')
    expect(preimagesOf(dataDir, PERSON, RUN)).toHaveLength(1)
    restoreRun(dataDir, PERSON, RUN)
    expect(readMemoryBytes(dataDir, PERSON, RECENT_TIER)).toEqual(text('first original\n'))
  })

  test('a created file that is written again keeps only the created marker', () => {
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(topicTier('garden.md'), 'a\n')
    writer.write(topicTier('garden.md'), 'b\n')
    expect(preimagesOf(dataDir, PERSON, RUN)).toEqual([
      { path: 'garden.md', tier: topicTier('garden.md'), created: true },
    ])
  })

  test('a removal takes the preimage first, so undo puts the file back', () => {
    writeMemoryFile(dataDir, PERSON, ARCHIVE_TIER, 'kept\n')
    openRunWriter(dataDir, PERSON, RUN).remove(ARCHIVE_TIER)
    expect(readMemoryBytes(dataDir, PERSON, ARCHIVE_TIER)).toBeUndefined()
    restoreRun(dataDir, PERSON, RUN)
    expect(readMemoryBytes(dataDir, PERSON, ARCHIVE_TIER)).toEqual(text('kept\n'))
  })

  test('the preimage is the bytes before the first write, not before a later one', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'v0\n')
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(PROFILE_TIER, 'v1\n')
    writer.write(PROFILE_TIER, 'v2\n')
    restoreRun(dataDir, PERSON, RUN)
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('v0\n'))
  })

  test('opening a writer writes nothing', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'v0\n')
    openRunWriter(dataDir, PERSON, RUN)
    expect(preimagesOf(dataDir, PERSON, RUN)).toEqual([])
    expect(existsSync(undoDirOf(dataDir, PERSON, RUN))).toBe(false)
  })
})

describe('restoreRun', () => {
  test('restores the exact bytes of a changed file and deletes a created one', () => {
    const original = new Uint8Array([1, 2, 3, 0, 254])
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, original)
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(PROFILE_TIER, 'changed\n')
    writer.write(diaryTier('2026-11-11'), '# created\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 1, removed: 1, skipped: [] })
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(original)
    expect(existsSync(memoryFileOf(dataDir, PERSON, diaryTier('2026-11-11')))).toBe(false)
  })

  test('the undo folder is consumed: a second restore changes nothing', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    openRunWriter(dataDir, PERSON, RUN).write(PROFILE_TIER, 'changed\n')
    restoreRun(dataDir, PERSON, RUN)
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'later edit\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 0, removed: 0, skipped: [] })
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('later edit\n'))
    expect(existsSync(undoDirOf(dataDir, PERSON, RUN))).toBe(false)
  })

  test('a path in the undo folder that no tier names is refused before anything is written', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    openRunWriter(dataDir, PERSON, RUN).write(PROFILE_TIER, 'changed\n')
    const folder = undoDirOf(dataDir, PERSON, RUN)
    mkdirSync(join(folder, 'sub'), { recursive: true })
    writeFileSync(join(folder, 'sub', 'evil.md'), 'x')
    expect(() => restoreRun(dataDir, PERSON, RUN)).toThrow()
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('changed\n'))
    expect(existsSync(folder)).toBe(true)
  })

  test('a run with no undo folder restores nothing', () => {
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 0, removed: 0, skipped: [] })
  })

  test('a file changed by a chat write after the run is kept and named; the other files are restored', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, 'recent orig\n')
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(PROFILE_TIER, 'changed\n')
    writer.write(RECENT_TIER, 'recent changed\n')
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, 'typed after the dream\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({
      restored: 1,
      removed: 0,
      skipped: ['recent.md'],
    })
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('orig\n'))
    expect(readMemoryBytes(dataDir, PERSON, RECENT_TIER)).toEqual(text('typed after the dream\n'))
    expect(existsSync(undoDirOf(dataDir, PERSON, RUN))).toBe(false)
  })

  test('a file the run created and that changed after the run is kept, not deleted', () => {
    const diary = diaryTier('2026-11-11')
    openRunWriter(dataDir, PERSON, RUN).write(diary, '# created\n')
    writeMemoryFile(dataDir, PERSON, diary, '# typed\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({
      restored: 0,
      removed: 0,
      skipped: ['dreams/2026-11-11.md'],
    })
    expect(readMemoryBytes(dataDir, PERSON, diary)).toEqual(text('# typed\n'))
  })

  test('a run written before the record (no written.json) restores every file, as before', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    openRunWriter(dataDir, PERSON, RUN).write(PROFILE_TIER, 'changed\n')
    rmSync(join(undoDirOf(dataDir, PERSON, RUN), WRITTEN_FILE))
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'typed after the dream\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 1, removed: 0, skipped: [] })
    expect(readMemoryBytes(dataDir, PERSON, PROFILE_TIER)).toEqual(text('orig\n'))
  })

  test('a restore that stopped midway can be repeated: the files already back are restored again, not skipped', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, 'recent orig\n')
    const writer = openRunWriter(dataDir, PERSON, RUN)
    writer.write(PROFILE_TIER, 'changed\n')
    writer.write(RECENT_TIER, 'recent changed\n')
    // the first attempt put one file back, then stopped
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 2, removed: 0, skipped: [] })
    expect(readMemoryBytes(dataDir, PERSON, RECENT_TIER)).toEqual(text('recent orig\n'))
  })

  test('restore touches only the run files of this person', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, 'orig\n')
    writeMemoryFile(dataDir, 'ben', PROFILE_TIER, 'ben profile\n')
    openRunWriter(dataDir, PERSON, RUN).write(PROFILE_TIER, 'changed\n')
    restoreRun(dataDir, PERSON, RUN)
    expect(readMemoryBytes(dataDir, 'ben', PROFILE_TIER)).toEqual(text('ben profile\n'))
    expect(readdirSync(memoryDir(dataDir, PERSON)).sort()).toEqual(['profile.md'])
  })
})

describe('decideUndo (undo_until is a pure check)', () => {
  const writtenAt = Date.UTC(2026, 10, 11, 3)
  const until = undoUntilFrom(writtenAt)

  test('the undo window is 7 days from the write', () => {
    expect(until - writtenAt).toBe(UNDO_WINDOW_MS)
    expect(UNDO_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test.each([
    ['inside the window', { now: writtenAt + 1, undoUntil: until, hasPreimages: true }, true],
    ['exactly at undo_until', { now: until, undoUntil: until, hasPreimages: true }, true],
    ['after undo_until', { now: until + 1, undoUntil: until, hasPreimages: true }, false],
    [
      'no undo_until (nothing written)',
      { now: writtenAt, undoUntil: null, hasPreimages: true },
      false,
    ],
    ['no preimages', { now: writtenAt, undoUntil: until, hasPreimages: false }, false],
  ] as const)('%s', (_name, input, ok) => {
    const decision = decideUndo({ ...input })
    expect(decision.ok).toBe(ok)
    if (!decision.ok) expect(decision.reason).toBe('nothing-to-undo')
  })
})
