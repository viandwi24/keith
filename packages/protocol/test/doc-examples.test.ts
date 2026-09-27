import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { CORE_FRAME_TYPES } from '../src/frames/core-to-node.ts'
import { NODE_FRAME_TYPES } from '../src/frames/node-to-core.ts'
import { checkDocExamples, extractExamples } from './doc-examples.ts'

const contracts = join(import.meta.dir, '..', '..', '..', 'docs', 'contracts')
const read = (path: string) => Bun.file(path).text()

describe('contract doc examples parse (contracts/README.md rule 4)', () => {
  for (const doc of ['protocol.md', 'ui-blocks.md']) {
    test(`${doc}: every example parses`, async () => {
      const markdown = await read(join(contracts, doc))
      expect(extractExamples(markdown).length).toBeGreaterThan(0)
      expect(checkDocExamples(markdown)).toEqual([])
    })
  }

  test('a broken example fails the check (fixture)', async () => {
    const failures = checkDocExamples(await read(join(import.meta.dir, 'fixtures', 'broken-examples.md')))
    expect(failures.map((f) => [f.kind, f.line])).toEqual([
      ['frame', 5],
      ['block', 15],
      ['block', 19],
    ])
    expect(failures[2]?.reason).toContain('invalid JSON')
  })
})

/** Frame types listed in a protocol.md table section whose Phase column is 1, 2 or 3. */
function tableFrameTypes(markdown: string, heading: string): string[] {
  const section = markdown.split(`## ${heading}`)[1]?.split('\n## ')[0] ?? ''
  const types: string[] = []
  for (const row of section.split('\n')) {
    const cells = row.split('|').map((c) => c.trim())
    const phase = cells.at(-2)
    const first = cells[1]
    if (!first || !['1', '2', '3'].includes(phase ?? '')) continue
    for (const match of first.matchAll(/`([a-z.]+)`/g)) if (match[1]) types.push(match[1])
  }
  return types
}

describe('every phase-1/2/3 frame in the protocol tables has a schema', () => {
  test('node → core', async () => {
    const types = tableFrameTypes(await read(join(contracts, 'protocol.md')), 'Node → core frames')
    expect(types.length).toBeGreaterThan(0)
    expect([...types].sort()).toEqual([...NODE_FRAME_TYPES].sort())
  })
  test('core → node', async () => {
    const types = tableFrameTypes(await read(join(contracts, 'protocol.md')), 'Core → node frames')
    expect(types.length).toBeGreaterThan(0)
    expect([...types].sort()).toEqual([...CORE_FRAME_TYPES].sort())
  })
})
