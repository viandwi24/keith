import { describe, expect, test } from 'bun:test'
import { sampleBlocks } from '../../test/samples.ts'
import {
  isAllowedUiUrl,
  STANDARD_BLOCK_TYPES,
  UI_BLOCK_LIMITS,
  UI_BLOCK_TYPES,
  UiBlock,
  type UiBlock as UiBlockType,
  uiBlockDepth,
} from './blocks.ts'

function nest(depth: number): UiBlockType {
  let block: UiBlockType = { type: 'markdown', id: `b${depth}`, text: 'leaf' }
  for (let d = depth - 1; d >= 1; d--)
    block = { type: 'stack', id: `b${d}`, direction: 'vertical', children: [block] }
  return block
}

describe('UiBlock schema', () => {
  test('the standard set is the must-render set, and html is the only optional type', () => {
    expect<string[]>([...STANDARD_BLOCK_TYPES].sort()).toEqual(
      ['actions', 'card', 'image', 'keyValue', 'list', 'markdown', 'stack', 'table'].sort(),
    )
    expect(UI_BLOCK_TYPES.filter((t) => !(STANDARD_BLOCK_TYPES as readonly string[]).includes(t))).toEqual([
      'html',
    ])
  })

  for (const [type, block] of Object.entries(sampleBlocks)) {
    test(`accepts a valid ${type} block`, () => {
      expect(UiBlock.parse(block)).toEqual(block)
    })
  }

  test.each([
    ['unknown type', { type: 'video', id: 'v', url: 'https://x' }],
    ['missing id', { type: 'markdown', text: 'x' }],
    ['uppercase id', { type: 'markdown', id: 'Weather', text: 'x' }],
    ['id over 64 chars', { type: 'markdown', id: 'a'.repeat(65), text: 'x' }],
    ['card without title', { type: 'card', id: 'c' }],
    ['table without columns', { type: 'table', id: 't', columns: [], rows: [] }],
    [
      'table with a boolean cell',
      { type: 'table', id: 't', columns: [{ key: 'a', label: 'A' }], rows: [{ a: true }] },
    ],
    ['actions without actions', { type: 'actions', id: 'a', actions: [] }],
    [
      'action with a bad style',
      { type: 'actions', id: 'a', actions: [{ id: 'x', label: 'X', style: 'huge' }] },
    ],
    ['stack without direction', { type: 'stack', id: 's', children: [] }],
    ['image with a fractional width', { ...sampleBlocks.image, width: 10.5 }],
    ['html with empty html', { type: 'html', id: 'h', html: '' }],
  ])('rejects %s', (_name, block) => {
    expect(UiBlock.safeParse(block).success).toBe(false)
  })
})

describe('UiBlock limits', () => {
  test(`nesting depth ${UI_BLOCK_LIMITS.maxDepth} is allowed, ${UI_BLOCK_LIMITS.maxDepth + 1} is not`, () => {
    expect(uiBlockDepth(nest(4))).toBe(4)
    expect(UiBlock.safeParse(nest(4)).success).toBe(true)
    const deep = UiBlock.safeParse(nest(5))
    expect(deep.success).toBe(false)
    expect(deep.error?.issues[0]?.message).toContain('depth 5')
  })

  test('card children count toward depth', () => {
    const block: UiBlockType = { type: 'card', id: 'c', title: 't', children: [nest(4)] }
    expect(UiBlock.safeParse(block).success).toBe(false)
  })

  test('a block over 256 KB is rejected', () => {
    const ok: UiBlockType = { type: 'markdown', id: 'big', text: 'x'.repeat(UI_BLOCK_LIMITS.maxBytes - 100) }
    const big: UiBlockType = { type: 'markdown', id: 'big', text: 'x'.repeat(UI_BLOCK_LIMITS.maxBytes) }
    expect(UiBlock.safeParse(ok).success).toBe(true)
    expect(UiBlock.safeParse(big).error?.issues[0]?.message).toContain('bytes')
  })

  test('size counts UTF-8 bytes, not characters', () => {
    const text = 'é'.repeat(UI_BLOCK_LIMITS.maxBytes / 2)
    expect(UiBlock.safeParse({ type: 'markdown', id: 'u', text }).success).toBe(false)
  })

  test('table rows are limited to 200', () => {
    const columns = [{ key: 'n', label: 'N' }]
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i }))
    expect(UiBlock.safeParse({ type: 'table', id: 't', columns, rows: rows(200) }).success).toBe(true)
    expect(UiBlock.safeParse({ type: 'table', id: 't', columns, rows: rows(201) }).success).toBe(false)
  })

  test('block ids are unique within the tree', () => {
    const block: UiBlockType = {
      type: 'stack',
      id: 's',
      direction: 'vertical',
      children: [
        { type: 'markdown', id: 'a', text: '1' },
        { type: 'markdown', id: 'a', text: '2' },
      ],
    }
    expect(UiBlock.safeParse(block).error?.issues[0]?.message).toContain("duplicate block id 'a'")
  })

  test.each([
    ['https URL', 'https://example.com/a.png', true],
    ['data image URI', 'data:image/png;base64,AAAA', true],
    ['core file path', '/v1/files/fil_01J8ZQ3K4M5N6P7Q8R9S0T1V31', true],
    ['http URL', 'http://example.com/a.png', false],
    ['javascript URL', 'javascript:alert(1)', false],
    ['data text URI', 'data:text/html,<script>', false],
    ['other core path', '/v1/me', false],
    ['path traversal', '/v1/files/../me', false],
    ['bare files prefix', '/v1/files/', false],
    ['relative path', 'files/a.png', false],
  ])('url scheme: %s', (_name, url, allowed) => {
    expect(isAllowedUiUrl(url)).toBe(allowed)
    expect(UiBlock.safeParse({ type: 'image', id: 'i', url, alt: '' }).success).toBe(allowed)
  })

  test('card image URLs are checked too', () => {
    const card = { type: 'card', id: 'c', title: 't', image: { url: 'http://x/a.png', alt: '' } }
    expect(UiBlock.safeParse(card).success).toBe(false)
  })
})
