import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import { ORPCError } from '@orpc/server'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'

// P27.2.4: the owner's raw read of a person (`admin.presence.read`): the raw record, audited as `presence.read` with the
// person as subject; a member is refused (`audit.read` is owner only).

let booted: BootedCore
let memberId = ''
let memberClient: ReturnType<typeof createKeithClient>

afterAll(async () => {
  await booted?.stop()
})

describe('the owner reads a member', () => {
  test('the raw record comes back, the read is audited, a member and an unknown name are refused', async () => {
    booted = await bootCore()
    const member = await booted.local.rpc.admin.people.add({ username: 'duta' })
    memberId = member.id
    const config = { dataDir: booted.dir, dbFile: join(booted.dir, 'keith.db') } as never
    const token = await issueOwnerToken(config, 'duta', { personId: member.id })
    memberClient = createKeithClient({ baseUrl: booted.url, token })

    // the member registers a client and sends nothing: the raw record shows the client and the status
    await memberClient.rpc.presence.clients.register({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'tui',
      label: 'desk',
      capabilities: ['chat', 'notify'],
      version: '0.1.0',
      environment: {
        host: 'duta-raw-host',
        os: 'macos',
        osVersion: '16.0',
        arch: 'arm64',
        device: 'laptop',
        timezone: 'Asia/Jakarta',
        locale: 'id-ID',
      },
    })
    await memberClient.rpc.presence.setStatus({ busy: true, note: 'in a meeting', minutes: 30 })

    const raw = await booted.local.rpc.admin.presence.read({ person: 'duta' })
    expect(raw.presence).toMatchObject({ personId: memberId, state: 'busy', note: 'in a meeting' })
    expect(raw.clients).toHaveLength(1)
    expect(raw.clients[0]).toMatchObject({ label: 'desk', online: true })
    expect(raw.status.busy).toBe(true)
    // only the raw record: no disclosure rows
    expect(Object.keys(raw).sort()).toEqual(['clients', 'presence', 'status'])
    // another person's client environment is never listed to anyone (ADR-0033 §3): no environment, no network
    expect(Object.keys(raw.clients[0] ?? {})).not.toContain('environment')
    expect(Object.keys(raw.clients[0] ?? {})).not.toContain('network')
    expect(JSON.stringify(raw)).not.toContain('duta-raw-host')
    expect(JSON.stringify(raw)).not.toContain('Asia/Jakarta')
    // the person still reads the environment of their own client
    const mine = await memberClient.rpc.presence.mine()
    expect(mine.clients[0]?.environment?.host).toBe('duta-raw-host')

    const audit = await booted.local.rpc.admin.audit.list({ limit: 200 })
    const read = audit.find((e) => e.kind === 'presence.read')
    expect(read?.detail).toMatchObject({ subject: memberId })
    expect(JSON.stringify(read?.detail)).not.toContain('desk')

    const refusal = await memberClient.rpc.admin.presence.read({ person: 'duta' }).catch((e) => e)
    expect(refusal).toBeInstanceOf(ORPCError)
    expect((refusal as ORPCError<string, unknown>).code).toBe('FORBIDDEN')

    const unknown = await booted.local.rpc.admin.presence.read({ person: 'nobody' }).catch((e) => e)
    expect((unknown as ORPCError<string, unknown>).code).toBe('NOT_FOUND')
  })
})
