import { describe, expect, test } from 'bun:test'
import { sampleBlocks } from '../../test/samples.ts'
import { UI_BLOCK_TYPES, type UiBlock } from './blocks.ts'
import { uiBlockToText } from './to-text.ts'

const expected: Record<UiBlock['type'], string> = {
  markdown: '**31°C**, humid.',
  card: ['Surabaya (Now)', '**31°C**, humid.', '[image: sun]', 'Humidity: 78%', 'Source: BMKG'].join('\n'),
  list: ['1. Riverside Hall — downtown (4000)', '2. Harbor Center'].join('\n'),
  table: ['Venue | Capacity', 'Riverside Hall | 4000', 'Harbor Center | 6500'].join('\n'),
  keyValue: 'Wind: 12 km/h',
  image: '[image: map]',
  actions: '[Book Riverside] [Show more]',
  stack: 'Left · Right',
  html: '[interactive content]',
}

describe('uiBlockToText', () => {
  test('covers every block type', () => {
    expect(Object.keys(expected).sort()).toEqual([...UI_BLOCK_TYPES].sort())
  })

  for (const type of UI_BLOCK_TYPES) {
    test(`renders ${type}`, () => {
      expect(uiBlockToText(sampleBlocks[type])).toBe(expected[type])
    })
  }

  test('unordered list uses dashes', () => {
    expect(uiBlockToText({ type: 'list', id: 'l', items: [{ title: 'a' }, { title: 'b' }] })).toBe('- a\n- b')
  })

  test('vertical stack joins children with newlines', () => {
    const block: UiBlock = {
      type: 'stack',
      id: 's',
      direction: 'vertical',
      children: [
        { type: 'markdown', id: 'a', text: 'one' },
        { type: 'keyValue', id: 'b', pairs: [{ key: 'k', value: 'v' }] },
      ],
    }
    expect(uiBlockToText(block)).toBe('one\nk: v')
  })

  test('table cells missing from a row render empty', () => {
    const block: UiBlock = {
      type: 'table',
      id: 't',
      columns: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      rows: [{ a: 1 }],
    }
    expect(uiBlockToText(block)).toBe('A | B\n1 |')
  })

  test('image without alt text', () => {
    expect(uiBlockToText({ type: 'image', id: 'i', url: 'https://x.dev/a.png', alt: '' })).toBe('[image]')
  })
})
