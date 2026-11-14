import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase, tokensRepo } from '@keith/db'
import { createToken, ensureOwner, hashToken, verifyAuthorization } from './tokens.ts'

const repo = () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return tokensRepo(sqlite)
}

describe('owner tokens', () => {
  test('ensureOwner creates the owner without a token; a created token authorizes as owner', async () => {
    const tokens = repo()
    ensureOwner(tokens)
    ensureOwner(tokens) // idempotent
    expect(tokens.list('owner')).toEqual([])
    const { token } = await createToken(tokens, 'owner', 'cli')
    expect(token).toStartWith('keith_')
    expect(await verifyAuthorization(tokens, `Bearer ${token}`)).toMatchObject({
      personId: 'owner',
      role: 'owner',
      credential: { id: expect.any(String), kind: 'legacy' },
    })
  })

  test('missing, malformed and unknown tokens are refused', async () => {
    const tokens = repo()
    ensureOwner(tokens)
    expect(await verifyAuthorization(tokens, null)).toBeUndefined()
    expect(await verifyAuthorization(tokens, 'Basic abc')).toBeUndefined()
    expect(await verifyAuthorization(tokens, 'Bearer keith_wrong')).toBeUndefined()
  })

  test('tokens can be listed and revoked one by one', async () => {
    const tokens = repo()
    ensureOwner(tokens)
    const a = await createToken(tokens, 'owner', 'a')
    await createToken(tokens, 'owner', 'b')
    expect(tokens.list('owner').map((t) => t.label)).toEqual(['b', 'a'])
    expect(tokens.revoke(a.id)).toBe(true)
    expect(tokens.revoke(a.id)).toBe(false)
    expect(await verifyAuthorization(tokens, `Bearer ${a.token}`)).toBeUndefined()
  })

  test('only the hash is stored', async () => {
    expect(await hashToken('keith_x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
