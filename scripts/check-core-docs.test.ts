import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepo, checkSync, declarationsOf, normalize, parseDocSections } from './check-core-docs.ts'

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const repoRoot = join(import.meta.dir, '..')

const FILE = [
  '// Header comment. Not compared.',
  '// Second header line.',
  '',
  "import type { ThreadId } from '@keith/protocol'",
  'import type {',
  '  Lane,',
  '  Viewer,',
  "} from '../shared/types.ts'",
  '',
  "export type { Lane } from '../shared/types.ts'",
  '',
  '/** Runs jobs. */',
  'export interface Scheduler {',
  '  /**',
  '   * Queues a job',
  '   * on a lane.',
  '   */',
  '  run(lane: Lane, viewer: Viewer, threadId: ThreadId): Promise<void>',
  '}',
  '',
].join('\n')

const DOC = [
  '# Core',
  '',
  '### Scheduler (`scheduler/types.ts`), implemented by `scheduler/`',
  '',
  'Some prose.',
  '',
  '```ts',
  "export type { Lane } from '../shared/types.ts'",
  '',
  '/** Runs jobs. */',
  'export interface Scheduler {',
  '  /** Queues a job on a lane. */',
  '  run(',
  '    lane: Lane,',
  '    viewer: Viewer,',
  '    threadId: ThreadId,',
  '  ): Promise<void>',
  '}',
  '```',
  '',
  '```ts',
  'const example = "a later block is prose"',
  '```',
  '',
  '### Construction order',
  '',
].join('\n')

async function fixtureRepo(typesSource: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'keith-core-docs-'))
  temps.push(root)
  await Bun.write(join(root, 'docs/architecture/core.md'), DOC)
  await Bun.write(join(root, 'packages/core/src/scheduler/types.ts'), typesSource)
  return root
}

describe('parseDocSections', () => {
  test('finds each types.ts section and its first ts block only', () => {
    const sections = parseDocSections(DOC)
    expect(sections).toHaveLength(1)
    expect(sections[0]?.folder).toBe('scheduler')
    expect(sections[0]?.line).toBe(3)
    expect(sections[0]?.code).toContain('export interface Scheduler')
    expect(sections[0]?.code).not.toContain('later block')
  })
  test('a section without a block has code null', () => {
    const doc = '### Memory (`memory/types.ts`)\n\nNo code.\n\n### Next\n\n```ts\nx\n```\n'
    expect(parseDocSections(doc)).toEqual([{ folder: 'memory', line: 1, code: null }])
  })
})

describe('declarationsOf', () => {
  test('drops the header comment and imports, keeps re-exports and JSDoc', () => {
    const out = declarationsOf(FILE)
    expect(out).not.toContain('Header comment')
    expect(out).not.toContain("from '@keith/protocol'")
    expect(out).not.toContain('import')
    expect(out).toContain("export type { Lane } from '../shared/types.ts'")
    expect(out).toContain('/** Runs jobs. */')
  })
})

describe('normalize', () => {
  test('ignores wrapping, indentation, JSDoc line prefixes and trailing commas', () => {
    expect(normalize('f(\n  a,\n  b,\n): { x: 1 }')).toBe(normalize('f(a, b): {x: 1}'))
    expect(normalize('/**\n * a\n * b\n */')).toBe(normalize('/** a b */'))
  })
  test('keeps names, types and comment words', () => {
    expect(normalize('a: string')).not.toBe(normalize('a: number'))
    expect(normalize('/** a */')).not.toBe(normalize('/** b */'))
  })
})

describe('checkSync', () => {
  test('an in-sync block passes', () => {
    expect(checkSync(DOC, new Map([['scheduler', FILE]]))).toEqual([])
  })
  test('a drifted type fails with the section line', () => {
    const drifted = FILE.replace('Promise<void>', 'Promise<boolean>')
    const problems = checkSync(DOC, new Map([['scheduler', drifted]]))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ folder: 'scheduler', line: 3 })
    expect(problems[0]?.message).toContain('Promise<boolean>')
  })
  test('a new member in the file fails', () => {
    const drifted = FILE.replace('\n}\n', '\n  stop(): void\n}\n')
    expect(checkSync(DOC, new Map([['scheduler', drifted]]))).toHaveLength(1)
  })
  test('a types.ts with no section fails', () => {
    const files = new Map([
      ['scheduler', FILE],
      ['memory', 'export type X = 1\n'],
    ])
    expect(checkSync(DOC, files)).toEqual([expect.objectContaining({ folder: 'memory', line: 0 })])
  })
  test('a section whose file is missing fails', () => {
    expect(checkSync(DOC, new Map([['scheduler', null]]))[0]?.message).toContain('does not exist')
  })
  test('a section without a block fails', () => {
    const doc = '### Memory (`memory/types.ts`)\n\nNo code.\n'
    expect(checkSync(doc, new Map([['memory', 'export type X = 1\n']]))[0]?.message).toContain(
      'no ```ts block',
    )
  })
})

describe('checkRepo', () => {
  test('the real core.md matches the real types.ts files', async () => {
    expect(await checkRepo(repoRoot)).toEqual([])
  })

  test('every real section has code', async () => {
    const markdown = await Bun.file(join(repoRoot, 'docs/architecture/core.md')).text()
    const sections = parseDocSections(markdown)
    expect(sections.length).toBeGreaterThanOrEqual(10)
    for (const s of sections) expect(s.code?.length ?? 0).toBeGreaterThan(0)
  })

  test('a fixture repo with a drifted block fails', async () => {
    const root = await fixtureRepo(FILE.replace('Queues a job', 'Queues one job'))
    const problems = await checkRepo(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ folder: 'scheduler', line: 3 })
  })

  test('the same fixture repo in sync passes', async () => {
    expect(await checkRepo(await fixtureRepo(FILE))).toEqual([])
  })
})
