import { afterEach, describe, expect, test } from 'bun:test'
import { Markdown } from './markdown.tsx'
import { cleanup } from './testing/render.ts'
import { type Depth, show } from './testing/show.tsx'

afterEach(cleanup)

describe('Markdown', () => {
  const md = async (text: string, width = 40, depth: Depth = 'none') =>
    (await show(<Markdown text={text} width={width} />, { columns: width, depth })).frame()

  test('headings are bold with no # drawn and a blank row before them', async () => {
    const f = await md('Intro text\n\n## Heading\n\nbody')
    expect(f.split('\n')).toEqual(['Intro text', '', 'Heading', '', 'body'])
  })
  test('bullets become •, numbered lists keep their numbers, nesting indents by 2', async () => {
    const f = await md('- one\n- two\n  - nested\n\n1. first\n2. second')
    expect(f.split('\n')).toEqual([
      '  • one',
      '  • two',
      '    • nested',
      '  1. first',
      '  2. second',
    ])
  })
  test('inline: **bold** loses its stars, links show text (url), code keeps backticks without colour', async () => {
    expect(await md('a **bold** word')).toBe('a bold word')
    expect(await md('see [docs](https://x.io/a) now')).toBe('see docs (https://x.io/a) now')
    expect(await md('run `ls -la` now')).toBe('run `ls -la` now')
    // with colour the code span is an accent word (nothing is painted behind it) and the backticks are gone
    expect(await md('run `ls -la` now', 40, 'truecolor')).toBe('run ls -la now')
    // _em_ stays as written; images and html show as their text
    expect(await md('keep _this_ and ![logo](x.png)')).toBe('keep _this_ and logo')
  })
  test('a block quote has a muted │ gutter', async () => {
    expect(await md('> quoted line')).toBe('│ quoted line')
  })
  test('a fenced block shows its language and does not wrap: long lines truncate with …', async () => {
    const f = await md(`\`\`\`ts\nconst answer = 42\n${'x'.repeat(60)}\n\`\`\``, 30)
    const rows = f.split('\n')
    expect(rows[0]).toContain('ts')
    expect(rows.some((r) => r.includes('const answer = 42'))).toBe(true)
    expect(rows.some((r) => r.includes('…'))).toBe(true)
    expect(rows.every((r) => Bun.stringWidth(r) <= 30)).toBe(true)
  })
  test('a block over 30 lines shows 25 and says how many more', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    const f = await md(`\`\`\`\n${lines.join('\n')}\n\`\`\``, 30)
    expect(f).toContain('line 25')
    expect(f).not.toContain('line 26')
    expect(f).toContain('… 15 more lines')
  })
  test('a table that fits passes through as text; one that does not becomes a code block', async () => {
    const fits = await md('| a | b |\n| - | - |\n| 1 | 2 |', 40)
    expect(fits).toContain('| a | b |')
    const wide = await md(`| ${'long '.repeat(12)}|\n| - |`, 30)
    expect(wide).toContain('…')
  })
  test('an unclosed fence (a streaming answer) is a code block so far', async () => {
    expect(await md('```\npartial', 30)).toContain('partial')
  })
})
