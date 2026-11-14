import { describe, expect, test } from 'bun:test'
import { credentialsRepo, migrateDatabase, openDatabase, tokensRepo } from '@keith/db'
import type { HarnessAgent } from 'eharness'
import { createCredential, createToken, ensureOwner } from '../auth/index.ts'
import { createApp } from './app.ts'

const health = { status: 'ok' as const, version: '0', sha: 'x', boot: 'b' }

async function setup(generation = 0) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const real = tokensRepo(sqlite)
  ensureOwner(real)
  const realCredentials = credentialsRepo(sqlite)
  const legacy = (await createToken(real, 'owner', 't')).token
  const { token } = await createCredential(realCredentials, {
    personId: 'owner',
    kind: 'token',
    label: 't',
  })
  let lookups = 0
  const tokens = {
    ...real,
    findByHash: (hash: string) => {
      lookups++
      return real.findByHash(hash)
    },
  }
  const credentials = {
    ...realCredentials,
    find: (id: string) => {
      lookups++
      return realCredentials.find(id)
    },
  }
  const app = createApp({
    generations: { current: () => generation },
    agent: {} as HarnessAgent,
    tokens,
    credentials,
    router: {},
    health: () => health,
  })
  return { app, token, legacy, lookups: () => lookups }
}

describe('principal resolved once per request', () => {
  test('/rpc looks the token up once', async () => {
    const { app, token, lookups } = await setup()
    await app.request('/rpc/x', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    expect(lookups()).toBe(1)
  })

  test('a legacy token is also looked up once', async () => {
    const { app, legacy, lookups } = await setup()
    await app.request('/rpc/x', { method: 'POST', headers: { authorization: `Bearer ${legacy}` } })
    expect(lookups()).toBe(1)
  })

  test('/sessions (authorize hook behind the middleware) looks it up once', async () => {
    const { app, token, lookups } = await setup()
    const res = await app.request('/sessions/front:other/messages', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404) // another person's session
    expect(lookups()).toBe(1)
  })

  test('/sessions serves only the current generation: an older id is 404 after a reset (ADR-0030 §6)', async () => {
    const { app, token } = await setup(2)
    const headers = { authorization: `Bearer ${token}` }
    expect((await app.request('/sessions/front:owner/messages', { headers })).status).toBe(404)
    expect((await app.request('/sessions/front:owner:g1/messages', { headers })).status).toBe(404)
    expect((await app.request('/sessions/front:owner:g2/messages', { headers })).status).not.toBe(
      404,
    )
  })

  test('a local request needs no lookup and no token', async () => {
    const { app, lookups } = await setup()
    const res = await app.request('/sessions/front:other/messages', {}, { via: 'local' })
    expect(res.status).toBe(404) // authorized as owner, wrong session
    expect(lookups()).toBe(0)
  })

  test('a TCP request without a token is 401', async () => {
    const { app } = await setup()
    expect((await app.request('/sessions/front:owner/messages')).status).toBe(401)
    expect((await app.request('/rpc/x', { method: 'POST' })).status).toBe(401)
  })
})
