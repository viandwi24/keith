import { describe, expect, test } from 'bun:test'
import { cellsOf, markdownNodes, safeHref } from './markdown-nodes.ts'

describe('safeHref', () => {
  test('follows http, https and mailto only', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeHref('HTTP://example.com')).toBe('HTTP://example.com')
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref(' JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,x')).toBeUndefined()
    expect(safeHref('/relative')).toBeUndefined()
  })
})

describe('markdownNodes', () => {
  test('headings, paragraphs and inline marks', () => {
    const nodes = markdownNodes('## Title\n\nSome **bold** and `code` and [a](https://x.dev).')
    expect(nodes[0]).toEqual({ t: 'heading', level: 2, inline: [{ t: 'text', s: 'Title' }] })
    expect(nodes[1]).toEqual({
      t: 'para',
      lines: [
        [
          { t: 'text', s: 'Some ' },
          { t: 'bold', s: 'bold' },
          { t: 'text', s: ' and ' },
          { t: 'code', s: 'code' },
          { t: 'text', s: ' and ' },
          { t: 'link', s: 'a', href: 'https://x.dev' },
          { t: 'text', s: '.' },
        ],
      ],
    })
  })

  test('a link with an unsafe scheme has no href', () => {
    const [node] = markdownNodes('[click](javascript:void)')
    expect(node).toEqual({
      t: 'para',
      lines: [[{ t: 'link', s: 'click', href: undefined }]],
    })
  })

  test('raw HTML stays text', () => {
    const [node] = markdownNodes('<script>alert(1)</script>')
    expect(node).toEqual({ t: 'para', lines: [[{ t: 'text', s: '<script>alert(1)</script>' }]] })
  })

  test('list items group into one list, a deeper item nests', () => {
    const [list] = markdownNodes('- a\n- b\n  - b1\n  - b2\n- c')
    expect(list?.t).toBe('list')
    if (list?.t !== 'list') return
    expect(list.ordered).toBe(false)
    expect(list.items.map((i) => i.inline[0])).toEqual([
      { t: 'text', s: 'a' },
      { t: 'text', s: 'b' },
      { t: 'text', s: 'c' },
    ])
    expect(list.items[1]?.children[0]?.items.length).toBe(2)
  })

  test('an ordered list is ordered', () => {
    const [list] = markdownNodes('1. one\n2. two')
    expect(list?.t === 'list' && list.ordered).toBe(true)
  })

  test('a fenced block is code; an unclosed fence is code so far', () => {
    expect(markdownNodes('```ts\nconst a = 1\n```')).toEqual([
      { t: 'code', lang: 'ts', text: 'const a = 1' },
    ])
    expect(markdownNodes('```\nstill typing')).toEqual([
      { t: 'code', lang: '', text: 'still typing' },
    ])
  })

  test('a table gets its head, alignment and rows', () => {
    const [table] = markdownNodes('| a | b |\n| :-- | --: |\n| 1 | **2** |')
    expect(table?.t).toBe('table')
    if (table?.t !== 'table') return
    expect(table.align).toEqual(['left', 'right'])
    expect(table.head).toEqual([[{ t: 'text', s: 'a' }], [{ t: 'text', s: 'b' }]])
    expect(table.rows[0]?.[1]).toEqual([{ t: 'bold', s: '2' }])
  })

  test('a table without a separator row has only body rows', () => {
    const [table] = markdownNodes('| a | b |\n| c | d |')
    expect(table?.t === 'table' && table.head).toEqual([])
    expect(table?.t === 'table' && table.rows.length).toBe(2)
  })

  test('a quote keeps its lines', () => {
    expect(markdownNodes('> one\n> two')).toEqual([
      {
        t: 'quote',
        lines: [[{ t: 'text', s: 'one' }], [{ t: 'text', s: 'two' }]],
      },
    ])
  })
})

describe('cellsOf', () => {
  test('drops the outer pipes and keeps an escaped pipe', () => {
    expect(cellsOf('| a | b \\| c |')).toEqual(['a', 'b | c'])
  })
})
