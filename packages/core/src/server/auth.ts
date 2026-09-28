// Person-token auth (phase 1) and invite links (phase 5). See docs/architecture/nodes.md#auth-phase-1
// and docs/architecture/nodes.md#adding-people.
//
// Tokens are 32 random bytes (base64url). Only their SHA-256 hash is stored (R-14), with an expiry
// of `auth.tokenTtlDays`. An expired token is deleted the first time it is presented.

import type { InviteAcceptRequest } from '@keith/protocol'
import type { KeithConfig } from '../config/types.ts'
import type { Clock, PersonDto } from '../shared/types.ts'
import type { AuthTokenRecord, PersonRecord, Repositories } from '../storage/types.ts'
import { toPersonDto } from './dto.ts'

const DAY_MS = 86_400_000

/** A valid, unexpired token and who it belongs to. */
export type AuthSession = { tokenHash: string; token: AuthTokenRecord; person: PersonRecord }

export type LoginResult = { token: string; person: PersonDto; expiresAt: number }

/** Why an invite was refused: the HTTP error code and message to answer. */
export type InviteRefusal = { code: 'UNAUTHORIZED' | 'INVALID_REQUEST'; message: string }

export type InviteResult = { ok: true; login: LoginResult } | ({ ok: false } & InviteRefusal)

/** One answer for a wrong, used or expired code (ADR-0017). */
const BAD_INVITE: InviteRefusal = { code: 'UNAUTHORIZED', message: 'invalid or expired invite code' }
const USERNAME_TAKEN: InviteRefusal = { code: 'INVALID_REQUEST', message: 'username taken' }

export interface Auth {
  /** Null when the username is unknown, cannot sign in, or the password is wrong. */
  login(username: string, password: string): Promise<LoginResult | null>
  /** Null for an unknown or expired token, or a token whose person no longer exists. */
  resolve(token: string): Promise<AuthSession | null>
  logout(tokenHash: string): Promise<void>
  /**
   * Phase 5: accepts an invite link (`POST /v1/auth/invite`): sets the person's username and
   * password and signs them in. The request is already schema-checked.
   */
  acceptInvite(req: InviteAcceptRequest): Promise<InviteResult>
}

export type AuthDeps = {
  config: Pick<KeithConfig, 'auth'>
  clock: Clock
  repos: Pick<Repositories, 'persons' | 'authTokens' | 'inviteLinks'>
}

/** SHA-256 hex of the UTF-8 string. Used for auth tokens and invite codes alike. */
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

  const issue = async (person: PersonRecord): Promise<LoginResult> => {
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
  }

  return {
    async login(username, password) {
      const person = await persons.getByUsername(username)
      if (!person?.passwordHash) {
        await Bun.password.verify(password, await dummy())
        return null
      }
      if (!(await Bun.password.verify(password, person.passwordHash))) return null
      return issue(person)
    },
    async acceptInvite(req) {
      const username = req.username.trim()
      // Hashed before the code is checked, so a wrong code costs as long as a right one.
      const passwordHash = await Bun.password.hash(req.password)
      const codeHash = hashToken(req.code)
      const link = await deps.repos.inviteLinks.get(codeHash)
      const now = deps.clock.now()
      if (!link || link.usedAt !== null || link.expiresAt <= now) return { ok: false, ...BAD_INVITE }
      const person = await persons.get(link.personId)
      if (!person) return { ok: false, ...BAD_INVITE }
      if (username === '') return { ok: false, code: 'INVALID_REQUEST', message: 'username is empty' }
      const holder = await persons.getByUsername(username)
      if (holder && holder.id !== person.id) return { ok: false, ...USERNAME_TAKEN }
      // Conditional: of two requests with one code, only one gets past this line.
      if (!(await deps.repos.inviteLinks.markUsed(codeHash, now))) return { ok: false, ...BAD_INVITE }
      try {
        await persons.setCredentials(person.id, { username, passwordHash })
      } catch {
        // Another invite took the username since the check above (the unique index).
        return { ok: false, ...USERNAME_TAKEN }
      }
      // Old sessions end (a password reset must lock out whoever had the old password).
      await authTokens.deleteForPerson(person.id)
      return { ok: true, login: await issue({ ...person, username, passwordHash }) }
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
