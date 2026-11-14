import { expect, test } from 'bun:test'
import { node } from '../../testing/fixtures.ts'
import {
  countNodes,
  driverLines,
  formatCountdown,
  formatLastSeen,
  mergeNodes,
  nodeChangedOf,
  refusedLines,
  sortNodes,
} from './nodes-state.ts'

test('node-changed records parse; other records and bad payloads do not', () => {
  const n = node()
  expect(nodeChangedOf({ type: 'node-changed', payload: { node: n } })).toEqual(n)
  expect(nodeChangedOf({ type: 'task-changed', payload: { node: n } })).toBeUndefined()
  expect(nodeChangedOf({ type: 'node-changed', payload: { node: { id: 1 } } })).toBeUndefined()
})

test('sorted online, offline, revoked, then by name; revoked nodes are not counted', () => {
  const nodes = [
    node({ id: '1', name: 'b', status: 'revoked' }),
    node({ id: '2', name: 'z', status: 'online' }),
    node({ id: '3', name: 'c', status: 'offline' }),
    node({ id: '4', name: 'a', status: 'online' }),
  ]
  expect(sortNodes(nodes).map((n) => n.name)).toEqual(['a', 'z', 'c', 'b'])
  expect(countNodes(nodes)).toEqual({ online: 2, total: 3 })
})

test('an event during a fetch wins over the response', () => {
  const fetched = [node({ status: 'offline' }), node({ id: 'n2', name: 'x' })]
  const touched = new Map([['n1', node({ status: 'online' })]])
  expect(mergeNodes(fetched, touched).map((n) => `${n.name}:${n.status}`)).toEqual([
    'laptop-e:online',
    'x:online',
  ])
})

test('last seen and countdown formats', () => {
  expect(formatLastSeen(null, 0)).toBe('never')
  expect(formatLastSeen(1000, 2000)).toBe('just now')
  expect(formatLastSeen(0, 30_000)).toBe('30 s ago')
  expect(formatLastSeen(0, 180_000)).toBe('3 min ago')
  expect(formatLastSeen(0, 7_200_000)).toBe('2 h ago')
  expect(formatLastSeen(0, 3 * 86_400_000)).toBe('3 d ago')
  expect(formatCountdown(600_000, 0)).toBe('10:00')
  expect(formatCountdown(61_500, 0)).toBe('01:01')
  expect(formatCountdown(0, 5000)).toBe('00:00')
})

test('each driver as its version and capabilities without the prefix; an unowned capability on one line', () => {
  const laptop = node({
    capabilities: ['desktop.screenshot', 'desktop.input', 'system.info'],
    drivers: [
      { name: 'desktop', version: '0.1.0' },
      { name: 'system', version: '0.1.0' },
    ],
  })
  expect(driverLines(laptop)).toEqual(['desktop 0.1.0 · screenshot input', 'system 0.1.0 · info'])
  expect(driverLines(node({ capabilities: ['system.info'], drivers: [] }))).toEqual(['system.info'])
  expect(driverLines(node({ capabilities: [], drivers: [{ name: 'iot', version: '1' }] }))).toEqual(
    ['iot 1'],
  )
})

test('a refused capability reads as a muted line with its reason in words', () => {
  const lines = refusedLines(
    node({
      refused: [
        { id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' },
        { id: 'desktop.input', schemaVersion: 9, reason: 'unsupported-schema' },
      ],
    }),
  )
  expect(lines).toEqual([
    'refused: iot.switch (unknown capability)',
    'refused: desktop.input (unsupported schema)',
  ])
  expect(refusedLines(node())).toEqual([])
})
