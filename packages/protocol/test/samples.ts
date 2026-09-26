import type { UiBlock } from '../src/ui/blocks.ts'

/** One valid block per type, shared by the UI block tests. */
export const sampleBlocks: Record<UiBlock['type'], UiBlock> = {
  markdown: { type: 'markdown', id: 'md', text: '**31°C**, humid.' },
  card: {
    type: 'card',
    id: 'weather',
    title: 'Surabaya',
    subtitle: 'Now',
    body: '**31°C**, humid.',
    image: { url: 'https://example.com/sun.png', alt: 'sun' },
    footer: 'Source: BMKG',
    children: [{ type: 'keyValue', id: 'details', pairs: [{ key: 'Humidity', value: '78%' }] }],
  },
  list: {
    type: 'list',
    id: 'venues',
    ordered: true,
    items: [{ title: 'Riverside Hall', subtitle: 'downtown', meta: '4000' }, { title: 'Harbor Center' }],
  },
  table: {
    type: 'table',
    id: 'table',
    columns: [
      { key: 'name', label: 'Venue' },
      { key: 'capacity', label: 'Capacity', align: 'right' },
    ],
    rows: [
      { name: 'Riverside Hall', capacity: 4000 },
      { name: 'Harbor Center', capacity: 6500 },
    ],
  },
  keyValue: { type: 'keyValue', id: 'kv', pairs: [{ key: 'Wind', value: '12 km/h' }] },
  image: {
    type: 'image',
    id: 'img',
    url: '/v1/files/fil_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
    alt: 'map',
    width: 640,
  },
  actions: {
    type: 'actions',
    id: 'confirm',
    actions: [
      { id: 'book', label: 'Book Riverside', style: 'primary', value: { venue: 1 } },
      { id: 'more', label: 'Show more' },
    ],
  },
  stack: {
    type: 'stack',
    id: 'row',
    direction: 'horizontal',
    children: [
      { type: 'markdown', id: 'left', text: 'Left' },
      { type: 'markdown', id: 'right', text: 'Right' },
    ],
  },
  html: { type: 'html', id: 'chart', html: '<!doctype html><p>chart</p>', height: 300 },
}
