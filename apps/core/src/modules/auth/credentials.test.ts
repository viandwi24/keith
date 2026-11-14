import { describe, expect, test } from 'bun:test'
import { credentialsRepo, migrateDatabase, openDatabase, tokensRepo } from '@keith/db'
import {
  createCredential,
  formatCredential,
  LAST_SEEN_EVERY_MS,
  newSecret,
  parseCredential,
  verifyCredential,
} from './credentials.ts'
import { createPrincipalResolver } from './principal.ts'
import { recoverOwner } from './recover.ts'
import { createToken, ensureOwner, newToken, verifyAuthorization } from './tokens.ts'

function repos(now: () => number = Date.now) {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const tokens = tokensRepo(sqlite)
  ensureOwner(tokens)
  return { tokens, credentials: credentialsRepo(sqlite, { now }) }
}
const bearer = (token: string) =>
  new Request('http://x/', { headers: { authorization: `Bearer ${token}` } })
/** A node token as pairing builds it, assembled at runtime (secret scanners flag literals). */
const nodeToken = () => `keith_node_${newToken().slice('keith_'.length)}`

describe('credentials', () => {
  test('format: keith_s_<id>_<secret>, secret 32 bytes base64url, parses back', async () => {
    const { credentials } = repos()
    const { id, token } = await createCredential(credentials, {
      personId: 'owner',
      kind: 'token',
      label: 'a',
    })
    expect(token).toMatch(/^keith_s_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
    expect(parseCredential(token)?.id).toBe(id)
    expect(formatCredential(id, parseCredential(token)?.secret ?? '')).toBe(token)
    // only the hash is stored
    expect(credentials.find(id)?.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toContain(credentials.find(id)?.secretHash ?? 'x')
  })

  test('verify: right secret passes; wrong secret, unknown id, malformed and revoked do not', async () => {
    const { credentials } = repos()
    const { id, token } = await createCredential(credentials, {
      personId: 'owner',
      kind: 'device',
      label: 'phone',
    })
    expect(await verifyCredential(credentials, token)).toMatchObject({
      personId: 'owner',
      role: 'owner',
      credential: { id, kind: 'device' },
    })
    expect(await verifyCredential(credentials, formatCredential(id, newSecret()))).toBeUndefined()
    expect(
      await verifyCredential(credentials, formatCredential('0'.repeat(12), newSecret())),
    ).toBeUndefined()
    expect(await verifyCredential(credentials, 'keith_s_nope')).toBeUndefined()
    credentials.revoke(id)
    expect(await verifyCredential(credentials, token)).toBeUndefined()
  })

  test('last_seen and last_ip are written at most once a minute', async () => {
    let t = 1_000_000
    const { credentials } = repos(() => t)
    const { id, token } = await createCredential(credentials, {
      personId: 'owner',
      kind: 'token',
      label: 'a',
    })
    const now = () => t
    await verifyCredential(credentials, token, { now, ip: '10.0.0.1' })
    expect(credentials.find(id)).toMatchObject({ lastSeenAt: t, lastIp: '10.0.0.1' })
    const first = t
    t += LAST_SEEN_EVERY_MS - 1
    await verifyCredential(credentials, token, { now, ip: '10.0.0.2' })
    expect(credentials.find(id)).toMatchObject({ lastSeenAt: first, lastIp: '10.0.0.1' })
    t += 1
    await verifyCredential(credentials, token, { now, ip: '10.0.0.2' })
    expect(credentials.find(id)).toMatchObject({ lastSeenAt: t, lastIp: '10.0.0.2' })
  })
})

describe('the resolver and the two token families', () => {
  test('a credential and a legacy token both work; each is resolved once per request', async () => {
    const { tokens, credentials } = repos()
    const resolver = createPrincipalResolver(tokens, credentials)
    const legacy = (await createToken(tokens, 'owner', 'old')).token
    const modern = (
      await createCredential(credentials, { personId: 'owner', kind: 'token', label: 'n' })
    ).token
    expect((await resolver.resolve(bearer(legacy)))?.credential?.kind).toBe('legacy')
    expect((await resolver.resolve(bearer(modern)))?.credential?.kind).toBe('token')
    const same = bearer(modern)
    expect(await resolver.resolve(same)).toBe(await resolver.resolve(same))
  })

  test('a node token matches neither parser', async () => {
    const { tokens, credentials } = repos()
    const resolver = createPrincipalResolver(tokens, credentials)
    const node = nodeToken()
    expect(parseCredential(node)).toBeUndefined()
    expect(await verifyAuthorization(tokens, `Bearer ${node}`)).toBeUndefined()
    expect(await resolver.resolve(bearer(node))).toBeUndefined()
    // even when its hash sits in client_tokens, the legacy parser refuses its shape
    const { hashToken } = await import('./tokens.ts')
    tokens.addToken({ id: 'x', personId: 'owner', label: 'sneaky', hash: await hashToken(node) })
    expect(await resolver.resolve(bearer(node))).toBeUndefined()
  })

  test('a credential string is not read as a legacy token and vice versa', async () => {
    const { tokens, credentials } = repos()
    const modern = (
      await createCredential(credentials, { personId: 'owner', kind: 'token', label: 'n' })
    ).token
    expect(await verifyAuthorization(tokens, `Bearer ${modern}`)).toBeUndefined()
    const legacy = (await createToken(tokens, 'owner', 'old')).token
    expect(parseCredential(legacy)).toBeUndefined()
  })
})

describe('token recover', () => {
  test('revokes every credential and legacy token and issues one new token credential', async () => {
    const { tokens, credentials } = repos()
    const resolver = createPrincipalResolver(tokens, credentials)
    const legacy = (await createToken(tokens, 'owner', 'old')).token
    const a = (
      await createCredential(credentials, { personId: 'owner', kind: 'token', label: 'a' })
    ).token
    const b = (
      await createCredential(credentials, { personId: 'owner', kind: 'device', label: 'b' })
    ).token
    const fresh = await recoverOwner(tokens, credentials)
    expect(fresh.revoked).toBe(3)
    for (const old of [legacy, a, b]) expect(await resolver.resolve(bearer(old))).toBeUndefined()
    expect((await resolver.resolve(bearer(fresh.token)))?.role).toBe('owner')
    expect(credentials.list('owner').filter((c) => c.revokedAt === null)).toHaveLength(1)
  })
})
