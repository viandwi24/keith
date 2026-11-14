import { expect, test } from 'bun:test'
import type { Node } from '@keith/contracts'
import { driverLines } from './drivers.ts'

const node = (over: Partial<Node> = {}): Node => ({
  id: 'n1',
  name: 'laptop-e',
  os: 'darwin',
  arch: 'arm64',
  version: '0.0.0',
  capabilities: [],
  drivers: [],
  refused: [],
  allowShell: false,
  status: 'online',
  lastSeenAt: null,
  createdAt: 1,
  ...over,
})

test('each driver with its capabilities without the prefix; a clean node is ok', () => {
  const lines = driverLines([
    node({
      drivers: [
        { name: 'desktop', version: '0.1.0' },
        { name: 'system', version: '0.1.0' },
      ],
      capabilities: ['desktop.screenshot', 'desktop.input', 'system.info'],
    }),
  ])
  expect(lines).toEqual([
    {
      level: 'ok',
      name: 'node laptop-e',
      hint: 'desktop 0.1.0 · screenshot input; system 0.1.0 · info',
    },
  ])
})

test('a refused capability is a warning that names the id and the reason', () => {
  const [line] = driverLines([
    node({
      drivers: [{ name: 'system', version: '0.1.0' }],
      capabilities: ['system.info'],
      refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' }],
    }),
  ])
  expect(line).toEqual({
    level: 'warn',
    name: 'node laptop-e',
    hint: 'system 0.1.0 · info; refused iot.switch (unknown-capability)',
  })
})

test('a node with no drivers says so; one line per node, in the order given', () => {
  const lines = driverLines([node({ name: 'core' }), node({ name: 'lama' })])
  expect(lines.map((l) => [l.name, l.hint])).toEqual([
    ['node core', 'no drivers announced'],
    ['node lama', 'no drivers announced'],
  ])
})

test('a driver whose capabilities were all refused shows without a capability list', () => {
  const [line] = driverLines([
    node({
      drivers: [{ name: 'iot', version: '0.1.0' }],
      refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'driver-mismatch' }],
    }),
  ])
  expect(line?.hint).toBe('iot 0.1.0; refused iot.switch (driver-mismatch)')
})
