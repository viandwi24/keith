import { afterEach, describe, expect, test } from 'bun:test'
import type { Node } from '@keith/contracts'
import { MEMBER } from '../../testing/fake-core.ts'
import { node } from '../../testing/fixtures.ts'
import { frameUntil, typeLine } from '../../testing/ink.ts'
import { setupApp, stopCores } from '../../testing/setup-app.tsx'

afterEach(stopCores)

/** Fake `nodes.*` over a mutable registry. */
function registry(rows: Node[]) {
  const calls = { list: 0, revoke: [] as unknown[] }
  return {
    rows,
    calls,
    rpc: {
      'nodes/list': () => {
        calls.list++
        return rows
      },
      'nodes/revoke': (input: unknown) => {
        calls.revoke.push(input)
        const row = rows.find((n) => n.id === (input as { id: string }).id)
        if (row !== undefined) row.status = 'revoked'
        return { ok: true }
      },
    },
  }
}

describe('/nodes', () => {
  const rows = () => [
    node({
      id: 'n1',
      name: 'laptop-e',
      allowShell: true,
      drivers: [
        { name: 'system', version: '0.1.0' },
        { name: 'shell', version: '0.1.0' },
      ],
    }),
    node({
      id: 'n2',
      name: 'desktop-b',
      os: 'linux',
      arch: 'x64',
      status: 'offline',
      allowShell: false,
      capabilities: ['system.info'],
      drivers: [{ name: 'system', version: '0.1.0' }],
      refused: [{ id: 'iot.switch', schemaVersion: 1, reason: 'unknown-capability' }],
      lastSeenAt: Date.now() - 180_000,
    }),
    node({ id: 'n3', name: 'lama', status: 'revoked' }),
  ]

  test('lists status, os/arch, capabilities, shell policy and last seen', async () => {
    const reg = registry(rows())
    const { lastFrame, stdin, unmount } = await setupApp({ columns: 99, rpc: reg.rpc })
    await frameUntil(lastFrame, (f) => f.includes('nodes 1/2'))
    await typeLine(stdin, '/nodes')
    const frame = await frameUntil(lastFrame, (f) => f.includes('2 nodes · 1 online'))
    expect(frame).toMatch(/● laptop-e\s+online\s+darwin\/arm64\s+v0\.0\.0\s+just now/)
    expect(frame).toMatch(/name\s+status\s+platform\s+version\s+last seen/) // the dim header
    expect(frame).toContain('system 0.1.0 · info')
    expect(frame).toContain('shell 0.1.0 · exec')
    expect(frame).toContain('shell allowed')
    expect(frame).toMatch(/○ desktop-b\s+offline\s+linux\/x64/)
    expect(frame).toContain('3 min ago')
    expect(frame).toContain('system 0.1.0 · info')
    expect(frame).toContain('refused: iot.switch (unknown capability)')
    expect(frame).toContain('shell off')
    expect(frame).toMatch(/✕ lama\s+revoked/)
    unmount()
  })

  test('is read only: no selection, r does nothing and the screen points to keith-core', async () => {
    const reg = registry(rows())
    const { lastFrame, stdin, unmount } = await setupApp({ columns: 99, rpc: reg.rpc })
    await frameUntil(lastFrame, (f) => f.includes('nodes 1/2'))
    await typeLine(stdin, '/nodes')
    const frame = await frameUntil(lastFrame, (f) => f.includes('2 nodes · 1 online'))
    expect(frame).toContain('╭─ Nodes ─╮')
    expect(frame).toContain('keith-core nodes revoke')
    expect(frame).toContain('[esc] back')
    expect(frame).not.toMatch(/(^|\s)r revoke/)
    expect(frame).not.toContain('› ●') // no selection marker
    stdin.write('r')
    await Bun.sleep(100)
    expect(lastFrame()).not.toContain('Revoke node')
    expect(reg.calls.revoke).toEqual([])
    unmount()
  })

  test('shows online/total and each node; updates on node-changed; revoked nodes drop out', async () => {
    const reg = registry([node({ id: 'n1', name: 'laptop-e' })])
    const { lastFrame, core, unmount } = await setupApp({ rpc: reg.rpc })
    const first = await frameUntil(lastFrame, (f) => f.includes('● laptop-e'))
    expect(first).toMatch(/Nodes ─+ 1\/1 online/)

    core.emit({
      type: 'node-changed',
      payload: { node: node({ id: 'n1', name: 'laptop-e', status: 'offline' }) },
    })
    await frameUntil(
      lastFrame,
      (f) => /○ laptop-e\s+just now/.test(f) && /Nodes ─+ 0\/1 online/.test(f),
    )

    core.emit({
      type: 'node-changed',
      payload: { node: node({ id: 'n2', name: 'desktop-b', status: 'online' }) },
    })
    await frameUntil(lastFrame, (f) => f.includes('● desktop-b') && /Nodes ─+ 1\/2 online/.test(f))

    core.emit({
      type: 'node-changed',
      payload: { node: node({ id: 'n1', name: 'laptop-e', status: 'revoked' }) },
    })
    await frameUntil(lastFrame, (f) => !f.includes('laptop-e') && /Nodes ─+ 1\/1 online/.test(f))
    unmount()
  })

  test('a feed resync refetches the registry; with none the panel says how to pair', async () => {
    const reg = registry([])
    const { lastFrame, core, unmount } = await setupApp({ rpc: reg.rpc })
    await frameUntil(lastFrame, (f) => f.includes('no nodes · keith-core pair'))
    const before = reg.calls.list
    reg.rows.push(node())
    core.resync()
    await frameUntil(lastFrame, (f) => f.includes('● laptop-e'))
    expect(reg.calls.list).toBeGreaterThan(before)
    unmount()
  })

  test('a member with nodes.read sees the same drivers and refused lines', async () => {
    const reg = registry(rows())
    const { lastFrame, stdin, unmount } = await setupApp({
      columns: 99,
      whoami: MEMBER,
      rpc: reg.rpc,
    })
    await typeLine(stdin, '/nodes')
    const frame = await frameUntil(lastFrame, (f) => f.includes('2 nodes · 1 online'))
    expect(frame).toContain('system 0.1.0 · info')
    expect(frame).toContain('shell 0.1.0 · exec')
    expect(frame).toContain('refused: iot.switch (unknown capability)')
    expect(frame).not.toContain('Revoke')
    unmount()
  })

  test('the Nodes panel sits beside the chat at 100 columns; at 99 the strip counts them', async () => {
    const wide = await setupApp({ columns: 100, rpc: registry([node()]).rpc })
    const wideLines = (await frameUntil(wide.lastFrame, (f) => /Nodes ─+ 1\/1/.test(f))).split('\n')
    const wideRow = wideLines.find((l) => /Nodes ─+ 1\/1/.test(l)) ?? ''
    expect(wideRow.indexOf('╭─ Nodes')).toBeGreaterThan(60) // the right column
    wide.unmount()
    stopCores()

    const narrow = await setupApp({ columns: 99, rpc: registry([node()]).rpc })
    const frame = await frameUntil(narrow.lastFrame, (f) => f.includes('nodes 1/1'))
    expect(frame).not.toMatch(/Nodes ─+ 1\/1/)
    narrow.unmount()
  })
})
