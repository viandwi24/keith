import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'

// FR3-08: a register that came through Tailscale Funnel is `public` (the RPC context carries the funnel fact to the
// network rule; the login path already read the header). Over TCP the Funnel header is sent by the test client, behind a Serve proxy (where the bug showed).

let booted: BootedCore

afterAll(async () => {
  await booted?.stop()
})

describe('a client registered through Tailscale Funnel', () => {
  test('its network is public, a plain TCP register from the same peer is not', async () => {
    booted = await bootCore({ KEITH_ALLOWED_HOSTS: 'localhost' })
    // behind `tailscale serve` a loopback peer with a forwarding header would be tailscale, unless it is a Funnel request
    await booted.local.rpc.admin.access.set({ mode: 'local', proxy: 'tailscale-serve' })
    const member = await booted.local.rpc.admin.people.add({ username: 'funny' })
    const config = { dataDir: booted.dir, dbFile: join(booted.dir, 'keith.db') } as never
    const token = await issueOwnerToken(config, 'funny', { personId: member.id })
    const base = (globalThis as { fetch: typeof fetch }).fetch
    const funnelFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // a Request keeps its own headers (the bearer token): merge them with the init's before adding the Funnel one
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, name) => {
        headers.set(name, value)
      })
      headers.set('tailscale-funnel-request', '1')
      return base(input, { ...init, headers })
    }) as typeof fetch
    const funnel = createKeithClient({ baseUrl: booted.url, token, fetch: funnelFetch })
    const direct = createKeithClient({ baseUrl: booted.url, token })

    await funnel.rpc.presence.clients.register({
      id: '00000000-0000-4000-8000-0000000000f1',
      kind: 'tui',
      label: 'funnel',
      capabilities: ['chat'],
      version: '0.1.0',
    })
    await direct.rpc.presence.clients.register({
      id: '00000000-0000-4000-8000-0000000000f2',
      kind: 'tui',
      label: 'plain',
      capabilities: ['chat'],
      version: '0.1.0',
    })

    const clients = await direct.rpc.presence.clients.list()
    const byLabel = (label: string) => clients.find((c) => c.label === label)
    expect(byLabel('funnel')?.network).toBe('public')
    expect(byLabel('plain')?.network).toBe('loopback')
  })
})
