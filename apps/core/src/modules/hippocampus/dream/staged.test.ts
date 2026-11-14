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
import { memoryBase } from '../hippocampus.ts'
import { PROFILE_TIER, RECENT_TIER, stagedFileOf, writeMemoryFile } from './files.ts'
import {
  changedSince,
  contentHash,
  memoryBaseOf,
  readStagedPlan,
  removeStagedPlan,
  type StagedPlan,
  writeStagedPlan,
} from './staged.ts'

const PERSON = 'owner'
const RUN = 'run-0001'
let dataDir: string

const plan = (): StagedPlan => ({
  runId: RUN,
  personId: PERSON,
  stagedAt: Date.UTC(2026, 10, 11, 3),
  plan: {
    candidates: [
      {
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Prefers short answers',
        reason: 'said once',
        importance: 4,
        sourceMessageId: 'm7',
      },
      {
        id: 'c2',
        action: 'supersede',
        target: 'profile',
        text: 'Lives in Jakarta',
        reason: 'moved',
        importance: 8,
        sourceMessageId: 'm9',
        supersedes: 'Lives in Bandung',
      },
    ],
  },
  candidates: [
    {
      id: 'c1',
      text: 'Prefers short answers',
      role: 'user',
      sessionId: 'front:owner',
      messageId: 'm7',
      day: '2026-11-11',
    },
    {
      id: 'c2',
      text: 'Lives in Jakarta',
      role: 'user',
      sessionId: 'front:owner',
      messageId: 'm9',
      day: '2026-11-11',
    },
  ],
  base: { 'profile.md': contentHash(new TextEncoder().encode('# profile\n')), 'recent.md': null },
})

/** The bytes of every file under the memory base, as a sorted list: a snapshot to compare. */
function memorySnapshot(): string[] {
  if (!existsSync(memoryBase(dataDir))) return []
  return Array.from(
    new Bun.Glob('**/*').scanSync({ cwd: memoryBase(dataDir), dot: true, onlyFiles: true }),
  )
    .map((path) => `${path}=${readFileSync(join(memoryBase(dataDir), path), 'latin1')}`)
    .sort()
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-staged-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('staged plan read and write', () => {
  test('a written plan reads back equal', () => {
    writeStagedPlan(dataDir, plan())
    expect(readStagedPlan(dataDir, PERSON, RUN)).toEqual(plan())
  })

  test('the plan file sits outside the memory folder and no temporary file is left', () => {
    writeStagedPlan(dataDir, plan())
    const path = stagedFileOf(dataDir, PERSON, RUN)
    expect(path).toBe(join(dataDir, 'dreams', PERSON, 'staged', `${RUN}.json`))
    expect(path.startsWith(memoryBase(dataDir))).toBe(false)
    expect(readdirSync(join(dataDir, 'dreams', PERSON, 'staged'))).toEqual([`${RUN}.json`])
  })

  test('a plan written again for the same run replaces the first', () => {
    writeStagedPlan(dataDir, plan())
    const second = { ...plan(), stagedAt: plan().stagedAt + 1000 }
    writeStagedPlan(dataDir, second)
    expect(readStagedPlan(dataDir, PERSON, RUN)).toEqual(second)
  })

  test('a plan survives a restart: a new process reads the same plan', () => {
    writeStagedPlan(dataDir, plan())
    const script = `const m = await import(${JSON.stringify(join(import.meta.dir, 'staged.ts'))});
console.log(JSON.stringify(m.readStagedPlan(${JSON.stringify(dataDir)}, ${JSON.stringify(PERSON)}, ${JSON.stringify(RUN)})));`
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.stderr.toString()).toBe('')
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(plan())
  })

  test('a missing plan reads as undefined', () => {
    expect(readStagedPlan(dataDir, PERSON, RUN)).toBeUndefined()
  })

  test('a file that is not a valid plan throws and is left in place', () => {
    writeStagedPlan(dataDir, plan())
    const path = stagedFileOf(dataDir, PERSON, RUN)
    writeFileSync(path, '{"runId": "run-0001", "extra": true}')
    expect(() => readStagedPlan(dataDir, PERSON, RUN)).toThrow()
    expect(existsSync(path)).toBe(true)
    writeFileSync(path, 'not json')
    expect(() => readStagedPlan(dataDir, PERSON, RUN)).toThrow()
  })

  test('a plan whose run or person differs from the path is refused', () => {
    // the plan of run-0001 copied under the path of run-0002
    mkdirSync(join(dataDir, 'dreams', PERSON, 'staged'), { recursive: true })
    writeFileSync(stagedFileOf(dataDir, PERSON, 'run-0002'), JSON.stringify(plan()))
    expect(() => readStagedPlan(dataDir, PERSON, 'run-0002')).toThrow()
  })

  test('writing refuses an invalid plan: a bad candidate field or a base path no tier names', () => {
    const bad = plan()
    expect(() =>
      writeStagedPlan(dataDir, {
        ...bad,
        plan: { candidates: [{ ...bad.plan.candidates[0], target: '../etc/passwd' } as never] },
      }),
    ).toThrow()
    expect(() => writeStagedPlan(dataDir, { ...bad, base: { '../x.md': null } })).toThrow()
    expect(existsSync(stagedFileOf(dataDir, PERSON, RUN))).toBe(false)
  })

  test('remove deletes the plan and a missing plan is not an error', () => {
    writeStagedPlan(dataDir, plan())
    removeStagedPlan(dataDir, PERSON, RUN)
    expect(readStagedPlan(dataDir, PERSON, RUN)).toBeUndefined()
    expect(() => removeStagedPlan(dataDir, PERSON, RUN)).not.toThrow()
  })
})

describe('base hashes and staged-changed', () => {
  test('a plan still applies while its files are unchanged', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, '# profile\n')
    const staged = { ...plan(), base: memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER]) }
    expect(staged.base).toEqual({
      'profile.md': contentHash(new TextEncoder().encode('# profile\n')),
      'recent.md': null,
    })
    expect(changedSince(dataDir, PERSON, staged)).toEqual([])
  })

  test('a file edited or created after staging is reported', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, '# profile\n')
    const staged = { ...plan(), base: memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER]) }
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, '# profile edited\n')
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, 'new short-term\n')
    expect(changedSince(dataDir, PERSON, staged).sort()).toEqual(['profile.md', 'recent.md'])
  })

  test('the hash of no bytes is null, and the hash of bytes is 64 hex characters', () => {
    expect(contentHash(undefined)).toBeNull()
    expect(contentHash(new TextEncoder().encode('x'))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the staged plan writes nothing under memory/', () => {
  test('writing, reading and removing a plan leave the memory folder as it was', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, '# profile\n')
    const before = memorySnapshot()
    writeStagedPlan(dataDir, plan())
    readStagedPlan(dataDir, PERSON, RUN)
    removeStagedPlan(dataDir, PERSON, RUN)
    expect(memorySnapshot()).toEqual(before)
  })
})
