// Person-token auth (phase 1). See docs/architecture/nodes.md#auth-phase-1.
//
// Tokens are 32 random bytes (base64url). Only their SHA-256 hash is stored (R-14), with an expiry
// of `auth.tokenTtlDays`. An expired token is deleted the first time it is presented.

import type { KeithConfig } from '../config/types.ts'
import type { Clock, PersonDto } from '../shared/types.ts'
import type { AuthTokenRecord, PersonRecord, Repositories } from '../storage/types.ts'
import { toPersonDto } from './dto.ts'

const DAY_MS = 86_400_000

/** A valid, unexpired token and who it belongs to. */
export type AuthSession = { tokenHash: string; token: AuthTokenRecord; person: PersonRecord }

export type LoginResult = { token: string; person: PersonDto; expiresAt: number }

export interface Auth {
  /** Null when the username is unknown, cannot sign in, or the password is wrong. */
  login(username: string, password: string): Promise<LoginResult | null>
  /** Null for an unknown or expired token, or a token whose person no longer exists. */
  resolve(token: string): Promise<AuthSession | null>
  logout(tokenHash: string): Promise<void>
}

export type AuthDeps = {
  config: Pick<KeithConfig, 'auth'>
  clock: Clock
  repos: Pick<Repositories, 'persons' | 'authTokens'>
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

export function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

/** Reads `Authorization: Bearer <token>`. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? null
}

export function createAuth(deps: AuthDeps): Auth {
  const { persons, authTokens } = deps.repos
  // Verified when the username is unknown, so a miss costs about as long as a wrong password.
  let dummyHash: Promise<string> | null = null
  const dummy = () => {
    dummyHash ??= Bun.password.hash('keith-dummy-password')
    return dummyHash
  }

  return {
    async login(username, password) {
      const person = await persons.getByUsername(username)
      if (!person?.passwordHash) {
        await Bun.password.verify(password, await dummy())
        return null
      }
      if (!(await Bun.password.verify(password, person.passwordHash))) return null
      const token = generateToken()
      const now = deps.clock.now()
      const expiresAt = now + deps.config.auth.tokenTtlDays * DAY_MS
      await authTokens.create({
        tokenHash: hashToken(token),
        personId: person.id,
        nodeId: null,
        expiresAt,
        createdAt: now,
      })
      return { token, person: toPersonDto(person), expiresAt }
    },
    async resolve(token) {
      const tokenHash = hashToken(token)
      const record = await authTokens.get(tokenHash)
      if (!record) return null
      if (record.expiresAt <= deps.clock.now()) {
        await authTokens.delete(tokenHash)
        return null
      }
      const person = await persons.get(record.personId)
      if (!person) return null
      return { tokenHash, token: record, person }
    },
    async logout(tokenHash) {
      await authTokens.delete(tokenHash)
    },
  }
}
