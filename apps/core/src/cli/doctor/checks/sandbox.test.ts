import { expect, test } from 'bun:test'
import type { Node } from '@keith/contracts'
import { NO_SANDBOX_HINT, sandboxLines } from './sandbox.ts'

const node = (name: string, over: Partial<Node> = {}): Node =>
  ({
    id: `id-${name}`,
    name,
    os: 'linux',
    arch: 'arm64',
    drivers: [],
    refused: [],
    version: '1',
    capabilities: ['sandbox.run'],
    allowShell: false,
    status: 'online',
    lastSeenAt: 1,
    createdAt: 1,
    ...over,
  }) as Node

test('an online node that announces sandbox.run is an ok line', () => {
  expect(sandboxLines([node('sbx-1')])).toEqual([
    { level: 'ok', name: 'sandbox', hint: 'node sbx-1 online' },
  ])
})

test('no sandbox node is a warning that says code cannot run', () => {
  expect(sandboxLines([])).toEqual([{ level: 'warn', name: 'sandbox', hint: NO_SANDBOX_HINT }])
  expect(NO_SANDBOX_HINT).toBe(
    'no sandbox node: code cannot run (the core never runs code for a worker)',
  )
})

test('an offline sandbox node, or a node without sandbox.run, does not count', () => {
  const lines = sandboxLines([
    node('sbx-off', { status: 'offline' }),
    node('laptop-e', { capabilities: ['system.info', 'shell.exec'] }),
  ])
  expect(lines).toEqual([{ level: 'warn', name: 'sandbox', hint: NO_SANDBOX_HINT }])
})
