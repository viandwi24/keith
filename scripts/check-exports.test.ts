import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentExports, diffExports } from './check-exports.ts'

describe('diffExports', () => {
  test('equal snapshots have no problems', () => {
    expect(diffExports({ '@k/a': ['x'] }, { '@k/a': ['x'] })).toEqual([])
  })

  test('reports new, removed and changed exports', () => {
    const problems = diffExports({ '@k/a': ['x'], '@k/gone': [] }, { '@k/a': ['y'], '@k/new': [] })
    expect(problems).toEqual([
      '@k/a: + y (new export)',
      '@k/a: - x (removed)',
      '@k/gone: entry removed',
      '@k/new: new entry, not in the snapshot',
    ])
  })
})

describe('currentExports', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('reads the runtime exports of every workspace package with exports', async () => {
    const base = await mkdtemp(join(tmpdir(), 'keith-exports-'))
    dirs.push(base)
    await Bun.write(
      join(base, 'packages/a/package.json'),
      JSON.stringify({ name: '@k/a', exports: './src/index.ts' }),
    )
    await Bun.write(
      join(base, 'packages/a/src/index.ts'),
      'export const b = 1\nexport const a = 2\n',
    )
    await Bun.write(join(base, 'apps/app/package.json'), JSON.stringify({ name: '@k/app' }))
    expect(await currentExports(base)).toEqual({ '@k/a': ['a', 'b'] })
  })
})
