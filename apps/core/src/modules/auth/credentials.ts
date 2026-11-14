import { timingSafeEqual } from 'node:crypto'
import type { CredentialKind, CredentialsRepo } from '@keith/db'
import { isActive, type Principal } from './tokens.ts'

/** Prefix of a session credential: `keith_s_<id>_<secret>`. */
export const CREDENTIAL_PREFIX = 'keith_s_'

const CREDENTIAL_RE = /^keith_s_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

/** Credentials stay accurate to the minute: `last_seen` is written at most this often. */
export const LAST_SEEN_EVERY_MS = 60_000

const sha256 = async (text: string): Promise<Buffer> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** SHA-256 hex of a credential secret: the only form that is stored. */
export async function hashSecret(secret: string): Promise<string> {
  return (await sha256(secret)).toString('hex')
}

/** A random id (12 hex chars) for a credential. */
export const newCredentialId = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')

/** A random secret: 32 bytes base64url (43 characters). */
export const newSecret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

export const formatCredential = (id: string, secret: string): string =>
  `${CREDENTIAL_PREFIX}${id}_${secret}`

/** The id and secret of a `keith_s_` string, or undefined for anything else (other parsers own it). */
export function parseCredential(token: string): { id: string; secret: string } | undefined {
  const match = CREDENTIAL_RE.exec(token)
  return match === null ? undefined : { id: match[1] as string, secret: match[2] as string }
}

/** A new credential for a person. The returned `token` is shown once; only its hash is stored. */
export async function createCredential(
  repo: CredentialsRepo,
  input: {
    personId: string
    kind: CredentialKind
    label: string
    /** Default `[kind]`. */
    methods?: string[]
    assurance?: 0 | 1 | 2
    /** Lifetimes in ms from now (`AuthRule.idleMs`, `absoluteMs`); 0 or absent = no limit. */
    idleMs?: number
    absoluteMs?: number
    userAgent?: string | undefined
  },
): Promise<{ id: string; token: string }> {
  const id = newCredentialId()
  const secret = newSecret()
  repo.create({ id, ...input, secretHash: await hashSecret(secret) })
  return { id, token: formatCredential(id, secret) }
}

export interface VerifyOptions {
  now?: () => number
  ip?: string | undefined
}

/**
 * The principal of a `keith_s_` token: parse, look the id up, compare SHA-256 digests in constant
 * time, refuse a revoked one. Updates `last_seen` / `last_ip` at most once a minute. A token that
 * is not in this format is `undefined` (the legacy parser may take it).
 */
export async function verifyCredential(
  repo: CredentialsRepo,
  token: string,
  options: VerifyOptions = {},
): Promise<Principal | undefined> {
  const parsed = parseCredential(token)
  if (parsed === undefined) return undefined
  const found = repo.find(parsed.id)
  // same work for an unknown id, so timing does not tell whether the id exists
  const stored = Buffer.from(found?.secretHash ?? '0'.repeat(64), 'hex')
  const given = await sha256(parsed.secret)
  const same = stored.length === given.length && timingSafeEqual(stored, given)
  if (found === undefined || !same || found.revokedAt !== null) return undefined
  const now = (options.now ?? Date.now)()
  // a session past its idle or absolute end is over; a row without limits (older ones) never ends by time
  if (found.absoluteExpiresAt !== null && found.absoluteExpiresAt <= now) return undefined
  if (found.idleExpiresAt !== null && found.idleExpiresAt <= now) return undefined
  // a suspended or left person is denied whatever their credentials say (docs/specs/auth.md)
  if (!isActive(found.person)) return undefined
  if (found.lastSeenAt === null || now - found.lastSeenAt >= LAST_SEEN_EVERY_MS) {
    try {
      repo.touch(found.id, options.ip, now)
    } catch {
      // bookkeeping only: a failed write never refuses a valid credential
    }
  }
  return {
    personId: found.personId,
    role: found.person.role,
    username: found.person.username,
    name: found.person.name,
    credential: {
      id: found.id,
      kind: found.kind,
      assurance: found.assurance,
      methods: found.methods,
    },
    elevated: found.elevatedUntil !== null && found.elevatedUntil > now,
  }
}
