import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryBase, memoryDir } from '../hippocampus.ts'
import {
  ARCHIVE_TIER,
  assertOutsideMemory,
  checkedPersonId,
  diaryTier,
  memoryFileOf,
  outsideDirOf,
  PROFILE_TIER,
  RECENT_TIER,
  readMemoryBytes,
  readMemoryFile,
  removeMemoryFile,
  stagedFileOf,
  tierOfPath,
  tierPath,
  topicTier,
  undoDirOf,
  writeFileAtomic,
  writeMemoryFile,
} from './files.ts'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-files-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('tier paths', () => {
  test('each tier names its file inside the person folder', () => {
    expect(tierPath(PROFILE_TIER)).toBe('profile.md')
    expect(tierPath(RECENT_TIER)).toBe('recent.md')
    expect(tierPath(ARCHIVE_TIER)).toBe('archive.md')
    expect(tierPath(topicTier('garden-plants.md'))).toBe('garden-plants.md')
    expect(tierPath(diaryTier('2026-11-11'))).toBe('dreams/2026-11-11.md')
    expect(memoryFileOf(dataDir, 'owner', diaryTier('2026-11-11'))).toBe(
      join(memoryDir(dataDir, 'owner'), 'dreams', '2026-11-11.md'),
    )
  })

  test.each([
    '..',
    '../x.md',
    'a/b.md',
    'a\\b.md',
    '/etc/passwd.md',
    'Upper.md',
    '-lead.md',
    'x.txt',
    'a..b.md',
    '',
  ])('refuses the topic name %j', (name) => {
    expect(() => topicTier(name)).toThrow()
  })

  test('the names of the fixed tiers are not topic names', () => {
    expect(() => topicTier('profile.md')).toThrow()
    expect(() => topicTier('recent.md')).toThrow()
    expect(() => topicTier('archive.md')).toThrow()
  })

  test('a topic name of 40 characters before .md is the longest allowed', () => {
    expect(() => topicTier(`${'a'.repeat(40)}.md`)).not.toThrow()
    expect(() => topicTier(`${'a'.repeat(41)}.md`)).toThrow()
  })

  test('a diary date must be a date', () => {
    expect(() => diaryTier('2026/11/11')).toThrow()
    expect(() => diaryTier('../2026-11-11')).toThrow()
  })

  test('tierOfPath reads back the paths tierPath writes, and nothing else', () => {
    for (const tier of [
      PROFILE_TIER,
      RECENT_TIER,
      ARCHIVE_TIER,
      topicTier('x.md'),
      diaryTier('2026-01-02'),
    ]) {
      expect(tierOfPath(tierPath(tier))).toEqual(tier)
    }
    for (const path of [
      '../profile.md',
      'dreams/../profile.md',
      'dreams/notes.md',
      'sub/x.md',
      'profile.md.bak',
      'x.md.created',
    ]) {
      expect(tierOfPath(path)).toBeUndefined()
    }
  })
})

describe('person ids', () => {
  test.each(['owner', 'a1b2c3d4-0000-7000-8000-000000000001', 'x_y-z'])('accepts %s', (id) => {
    expect(checkedPersonId(id)).toBe(id)
  })

  test.each(['', '..', '../owner', 'a/b', 'a\\b', 'with space', 'a'.repeat(65)])(
    'refuses %j',
    (id) => {
      expect(() => checkedPersonId(id)).toThrow()
      expect(() => memoryFileOf(dataDir, id, PROFILE_TIER)).toThrow()
      expect(() => outsideDirOf(dataDir, id)).toThrow()
    },
  )
})

describe('the outside folders', () => {
  test('staged and undo folders are under <dataDir>/dreams/<personId>, never under the memory folder', () => {
    const staged = stagedFileOf(dataDir, 'owner', 'run-1')
    const undo = undoDirOf(dataDir, 'owner', 'run-1')
    expect(staged).toBe(join(dataDir, 'dreams', 'owner', 'staged', 'run-1.json'))
    expect(undo).toBe(join(dataDir, 'dreams', 'owner', 'undo', 'run-1'))
    for (const path of [staged, undo, outsideDirOf(dataDir, 'owner')]) {
      expect(path.startsWith(memoryBase(dataDir))).toBe(false)
      expect(() => assertOutsideMemory(dataDir, path)).not.toThrow()
    }
  })

  test('assertOutsideMemory refuses the memory base and anything under it', () => {
    expect(() => assertOutsideMemory(dataDir, memoryBase(dataDir))).toThrow()
    expect(() =>
      assertOutsideMemory(dataDir, join(memoryBase(dataDir), 'owner', 'x.json')),
    ).toThrow()
    expect(() => assertOutsideMemory(dataDir, join(dataDir, 'memory-other'))).not.toThrow()
  })

  test('a run id with a separator is refused', () => {
    expect(() => stagedFileOf(dataDir, 'owner', '../run')).toThrow()
    expect(() => undoDirOf(dataDir, 'owner', 'a/b')).toThrow()
  })
})

describe('reading and writing memory files', () => {
  test('bytes round trip exactly, including non-UTF-8 bytes', () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 10])
    writeMemoryFile(dataDir, 'owner', topicTier('garden.md'), bytes)
    expect(readMemoryBytes(dataDir, 'owner', topicTier('garden.md'))).toEqual(bytes)
  })

  test('text is written in the person folder, creating the diary folder', () => {
    writeMemoryFile(dataDir, 'owner', diaryTier('2026-11-11'), '# day\n')
    expect(readMemoryFile(dataDir, 'owner', diaryTier('2026-11-11'))).toBe('# day\n')
    expect(existsSync(join(memoryDir(dataDir, 'owner'), 'dreams', '2026-11-11.md'))).toBe(true)
  })

  test('a missing file reads as undefined and removing it is a no-op', () => {
    expect(readMemoryFile(dataDir, 'owner', RECENT_TIER)).toBeUndefined()
    expect(() => removeMemoryFile(dataDir, 'owner', RECENT_TIER)).not.toThrow()
  })

  test('removeMemoryFile deletes the file only', () => {
    writeMemoryFile(dataDir, 'owner', PROFILE_TIER, 'pinned\n')
    writeMemoryFile(dataDir, 'owner', RECENT_TIER, 'short\n')
    removeMemoryFile(dataDir, 'owner', PROFILE_TIER)
    expect(readMemoryFile(dataDir, 'owner', PROFILE_TIER)).toBeUndefined()
    expect(readMemoryFile(dataDir, 'owner', RECENT_TIER)).toBe('short\n')
  })

  test('one person never reads or writes another folder', () => {
    writeMemoryFile(dataDir, 'ana', PROFILE_TIER, 'Ana profile\n')
    expect(readMemoryFile(dataDir, 'ben', PROFILE_TIER)).toBeUndefined()
    expect(readdirSync(memoryDir(dataDir, 'ana'))).toEqual(['profile.md'])
    mkdirSync(memoryDir(dataDir, 'ben'), { recursive: true })
    expect(readdirSync(memoryDir(dataDir, 'ben'))).toEqual([])
  })
})

describe('atomic writes (P35.6.1): a memory file is never half written', () => {
  test('a write replaces the file and leaves no temporary file in its folder', () => {
    const path = join(dataDir, 'profile.md')
    writeFileAtomic(path, 'old\n')
    writeFileAtomic(path, 'new\n')
    expect(readFileSync(path, 'utf8')).toBe('new\n')
    expect(readdirSync(dataDir)).toEqual(['profile.md'])
  })

  test('a failure between the temporary write and the rename leaves the old file intact and no temporary file', () => {
    const path = join(dataDir, 'recent.md')
    writeFileAtomic(path, '- old fact\n')
    expect(() =>
      writeFileAtomic(path, '- new fact\n', {
        beforeRename: () => {
          throw new Error('killed between write and rename')
        },
      }),
    ).toThrow('killed between write and rename')
    expect(readFileSync(path, 'utf8')).toBe('- old fact\n')
    expect(readdirSync(dataDir)).toEqual(['recent.md'])
  })

  test('a memory write through writeMemoryFile keeps the old bytes when the rename fails', () => {
    writeMemoryFile(dataDir, 'ana', RECENT_TIER, '- kept\n')
    const path = memoryFileOf(dataDir, 'ana', RECENT_TIER)
    expect(() =>
      writeFileAtomic(path, '- lost\n', {
        beforeRename: () => {
          throw new Error('crash')
        },
      }),
    ).toThrow('crash')
    expect(readMemoryFile(dataDir, 'ana', RECENT_TIER)).toBe('- kept\n')
  })
})
