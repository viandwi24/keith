import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ERROR_CODES } from '../src/errors.ts'
import { CORE_FRAME_TYPES, NoticeFrame } from '../src/frames/core-to-node.ts'
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

/** The table rows (cells, without the header and separator) of a protocol.md section. */
function tableRows(markdown: string, heading: string): string[][] {
  const section = markdown.split(`\n${heading}\n`)[1]?.split('\n#')[0] ?? ''
  return section
    .split('\n')
    .filter((row) => row.startsWith('|'))
    .slice(2)
    .map((row) =>
      row
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
}

describe('protocol.md tables added by P3-K2', () => {
  test('the error code table lists exactly ERROR_CODES, in order', async () => {
    const rows = tableRows(await read(join(contracts, 'protocol.md')), '## Error codes')
    expect(rows.map((cells) => cells[0]?.replaceAll('`', ''))).toEqual([...ERROR_CODES])
    for (const cells of rows) expect(cells[1]?.length ?? 0).toBeGreaterThan(0)
  })

  test('every notice case uses a notice level the schema accepts', async () => {
    const rows = tableRows(await read(join(contracts, 'protocol.md')), '### Notices')
    expect(rows.length).toBe(2)
    for (const cells of rows) {
      const data = { level: cells[2]?.replaceAll('`', ''), text: cells[3]?.replaceAll('`', '') }
      const frame = { v: 1, type: 'notice', id: 'n1', ts: 1790000000000, data }
      expect(NoticeFrame.safeParse(frame).success).toBe(true)
    }
  })
})
