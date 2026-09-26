import { describe, expect, test } from 'bun:test'
import {
  frontmatter,
  globsOverlap,
  lint,
  type RawTask,
  ready,
  renderBoard,
  staticPrefix,
  validTasks,
} from './plans.ts'

function raw(id: string, extra: Record<string, unknown> = {}): RawTask {
  return {
    file: `${id}.md`,
    data: {
      id,
      title: `Task ${id}`,
      phase: 1,
      wave: 1,
      lane: 'A',
      status: 'todo',
      owner: null,
      depends: [],
      owns: [],
      reads: [],
      updates: [],
      scenarios: [],
      ...extra,
    },
  }
}

describe('frontmatter', () => {
  test('parses the YAML block at the top of a markdown file', () => {
    const md = '---\nid: P9-A1\ndepends: [P0-04]\nowns:\n  - a/**\n---\n\n# Title\n'
    expect(frontmatter(md)).toEqual({ id: 'P9-A1', depends: ['P0-04'], owns: ['a/**'] })
  })
  test('returns null without frontmatter', () => {
    expect(frontmatter('# Just a doc\n')).toBeNull()
  })
})

describe('globsOverlap', () => {
  test('static prefix stops at the first glob character', () => {
    expect(staticPrefix('packages/core/src/**')).toBe('packages/core/src/')
    expect(staticPrefix('package.json')).toBe('package.json')
  })
  test.each([
    ['packages/core/src/**', 'packages/core/src/mind/**', true],
    ['packages/core/src/mind/**', 'packages/core/src/memory/**', false],
    ['packages/core/src/builtins/task.ts', 'packages/core/src/builtins/memory.ts', false],
    ['packages/core/src/builtins/task.ts', 'packages/core/src/builtins/task.ts', true],
    ['packages/core/**', 'packages/core/package.json', true],
    ['package.json', 'packages/core/package.json', false],
    ['apps/tui', 'apps/tui/src/index.ts', true],
  ])('%s vs %s → %p', (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected)
    expect(globsOverlap(b, a)).toBe(expected)
  })
})

describe('lint', () => {
  test('detects an overlapping owns in one wave', () => {
    const problems = lint([
      raw('P1-A1', { owns: ['packages/core/src/**'] }),
      raw('P1-B1', { owns: ['packages/core/src/storage/**'] }),
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('P1-A1')
    expect(problems[0]).toContain('P1-B1')
  })
  test('allows the same paths in different waves', () => {
    expect(lint([raw('P1-A1', { owns: ['x/**'] }), raw('P1-I1', { wave: 2, owns: ['x/**'] })])).toEqual([])
  })
  test('ignores bun.lock, which every task may change', () => {
    expect(lint([raw('P1-A1', { owns: ['bun.lock'] }), raw('P1-B1', { owns: ['bun.lock'] })])).toEqual([])
  })
  test('detects unknown depends', () => {
    expect(lint([raw('P1-A1', { depends: ['P0-99'] })])).toEqual(['P1-A1.md: depends on unknown task P0-99'])
  })
  test('detects missing and invalid fields', () => {
    const bad = raw('P1-A1', { status: 'started' })
    delete bad.data.owns
    const problems = lint([bad])
    expect(problems).toContain("P1-A1.md: missing field 'owns'")
    expect(problems.some((p) => p.includes("'status' must be one of"))).toBe(true)
  })
  test('detects duplicate ids', () => {
    expect(lint([raw('P1-A1'), raw('P1-A1')])[0]).toContain('duplicate id P1-A1')
  })
})

describe('ready', () => {
  test('lists todo tasks whose depends are done', () => {
    const tasks = validTasks([
      raw('P0-01', { status: 'done' }),
      raw('P0-02', { depends: ['P0-01'] }),
      raw('P0-03', { depends: ['P0-02'] }),
    ])
    expect(ready(tasks).map((t) => t.id)).toEqual(['P0-02'])
  })
  test('excludes tasks whose owns overlap an in-progress task', () => {
    const tasks = validTasks([
      raw('P1-A1', { status: 'in-progress', owns: ['packages/core/**'] }),
      raw('P1-B1', { owns: ['packages/core/src/storage/**'] }),
      raw('P1-C1', { owns: ['apps/tui/**'] }),
    ])
    expect(ready(tasks).map((t) => t.id)).toEqual(['P1-C1'])
  })
})

test('renderBoard groups by phase and wave', () => {
  const board = renderBoard(
    validTasks([raw('P1-B1', { wave: 2 }), raw('P0-01', { phase: 0, status: 'done' })]),
  )
  expect(board.split('\n')).toEqual([
    'Phase 0',
    '  Wave 1',
    '    P0-01  done         Task P0-01',
    '',
    'Phase 1',
    '  Wave 2',
    '    P1-B1  todo         Task P1-B1',
  ])
})
