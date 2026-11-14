import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'

// docs/decisions/0033: the environment a client reports is kept with its record, the network is derived by the core, and a
// person reads only their own clients. Client context is always on: there is no setting to change.

let booted: BootedCore
let memberClient: ReturnType<typeof createKeithClient>
const MEMBER_CLIENT = '00000000-0000-4000-8000-0000000000a1'
const OWNER_CLIENT = '00000000-0000-4000-8000-0000000000b1'
const ENV = {
  host: 'duta-mbp\u001b[2J',
  os: 'macos' as const,
  osVersion: '16.0',
  arch: 'arm64',
  device: 'laptop' as const,
  timezone: 'Asia/Jakarta',
  locale: 'id-ID',
}

afterAll(async () => {
  await booted?.stop()
})

describe('client context over the core', () => {
  test('the environment is kept, the network is derived, another person sees nothing, and the setting is audited', async () => {
    booted = await bootCore()
    const member = await booted.local.rpc.admin.people.add({ username: 'duta' })
    const config = { dataDir: booted.dir, dbFile: join(booted.dir, 'keith.db') } as never
    const token = await issueOwnerToken(config, 'duta', { personId: member.id })
    memberClient = createKeithClient({ baseUrl: booted.url, token })

    // the member's terminal registers over TCP (the test runs on loopback); the control character is stripped
    const registered = await memberClient.rpc.presence.clients.register({
      id: MEMBER_CLIENT,
      kind: 'tui',
      label: 'desk',
      capabilities: ['chat', 'notify'],
      version: '0.1.0',
      environment: ENV,
    })
    expect(registered.network).toBe('loopback')
    expect(registered.environment?.host).toBe('duta-mbp[2J')

    // the owner's terminal over the local socket: the network is the local socket, whatever the client says
    await booted.local.rpc.presence.clients.register({
      id: OWNER_CLIENT,
      kind: 'tui',
      label: 'owner-desk',
      capabilities: ['chat', 'notify'],
      version: '0.1.0',
    })
    const ownerList = await booted.local.rpc.presence.clients.list()
    expect(ownerList.map((c) => c.id)).toEqual([OWNER_CLIENT])
    expect(ownerList[0]?.network).toBe('local-socket')

    // the member sees only their own client, with its environment; the owner's client is not in the list
    const memberList = await memberClient.rpc.presence.clients.list()
    expect(memberList.map((c) => c.id)).toEqual([MEMBER_CLIENT])
    expect(memberList[0]?.environment?.timezone).toBe('Asia/Jakarta')

    // the owner's raw read carries neither the environment nor the network, and never an address (ADR-0033 §3)
    const raw = await booted.local.rpc.admin.presence.read({ person: 'duta' })
    expect(raw.clients[0]).toMatchObject({ label: expect.any(String), online: true })
    expect(Object.keys(raw.clients[0] ?? {})).not.toContain('environment')
    expect(Object.keys(raw.clients[0] ?? {})).not.toContain('network')
    expect(JSON.stringify(raw)).not.toContain('Asia/Jakarta')
    expect(JSON.stringify(raw)).not.toMatch(/127\.0\.0\.1|::1/)

    // there is no per-person switch: the setting procedures are gone (ADR-0033 §4, amended Nov 12, 2026)
    expect(Object.keys(memberClient.rpc.presence)).not.toContain('clientContext')
  })
})
