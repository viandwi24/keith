import { describe, expect, test } from 'bun:test'
import type { Node } from '@keith/contracts'
import { needsPoll, nodeRowsOf, nodesSummary } from './nodes-view.ts'

const node = (over: Partial<Node>): Node => ({
  id: 'n1',
  name: 'desk',
  os: 'darwin',
  arch: 'arm64',
  version: '0.4.0',
  capabilities: ['desktop.screenshot', 'desktop.input'],
  drivers: [{ name: 'desktop', version: '0.1.0' }],
  refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' }],
  allowShell: false,
  status: 'online',
  lastSeenAt: 1000,
  createdAt: 0,
  ...over,
})

describe('node rows', () => {
  test('a row carries the TUI words for drivers, refusals and the shell policy', () => {
    const [row] = nodeRowsOf([node({})], 3000)
    expect(row).toMatchObject({
      name: 'desk',
      platform: 'darwin/arm64',
      version: 'v0.4.0',
      seen: 'just now',
      shell: 'shell off',
      shellOn: false,
      tone: 'success',
    })
    expect(row?.drivers).toEqual(['desktop 0.1.0 · screenshot input'])
    expect(row?.refused).toEqual(['refused: iot.switch (unknown capability)'])
  })
  test('online first, revoked last, by name inside a group', () => {
    const rows = nodeRowsOf(
      [
        node({ id: 'a', name: 'zed', status: 'revoked' }),
        node({ id: 'b', name: 'beta', status: 'offline' }),
        node({ id: 'c', name: 'alpha', status: 'online', allowShell: true }),
      ],
      0,
    )
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta', 'zed'])
    expect(rows[0]?.shell).toBe('shell allowed')
    expect(rows[2]?.tone).toBe('danger')
  })
  test('the summary leaves revoked nodes out', () => {
    expect(nodesSummary([node({}), node({ id: 'x', status: 'revoked' })])).toBe('1 node · 1 online')
  })
  test('only a member polls', () => {
    expect(needsPoll('member')).toBe(true)
    expect(needsPoll('owner')).toBe(false)
    expect(needsPoll(undefined)).toBe(false)
  })
})
