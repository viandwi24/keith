import type { Assurance, PersonRole } from '@keith/contracts'
import type { TokensRepo } from '@keith/db'
import { uuidv7 } from 'eharness'

export const OWNER_ID = 'owner'

/** Which credential a request came in with (absent on the local socket). */
export interface CredentialRef {
  id: string
  /** `legacy` is a pre-credentials `keith_<b64>` token. */
  kind: 'device' | 'token' | 'legacy'
  /** What the session proves (0 possession, 1 PIN, 2 password); absent on a legacy token. */
  assurance?: Assurance
  /** The methods that made it (`password`, `pin`, `device`, `token`; `legacy` on an older row). */
  methods?: string[]
}

export interface Principal {
  personId: string
  role: PersonRole
  /** Login name; absent in tests that build a principal by hand. */
  username?: string | null
  /** Display name; absent in tests that build a principal by hand. */
  name?: string
  credential?: CredentialRef
  /**
   * Stepped up: the local socket always is; a session is for 10 minutes after a PIN or password
   * (`credentials.elevated_until`). Absent counts as false (a principal built by hand, a legacy token).
   */
  elevated?: boolean
}

/** Only an active person has access: suspended and left people are denied (no guest in P9). */
export const isActive = (person: { status: string }): boolean => person.status === 'active'

/** SHA-256 hex of a token: the only form that is stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(digest).toString('hex')
}

/** A new random token: `keith_` + 32 bytes base64url. */
export function newToken(): string {
  return `keith_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
}

/** Shape of a legacy token: `keith_` + 32 bytes base64url. Node tokens and `keith_s_` never match. */
const LEGACY_RE = /^keith_[A-Za-z0-9_-]{43}$/

/** Make sure the owner person exists. It never issues a token (setup and the socket are the way in). */
export function ensureOwner(repo: TokensRepo): void {
  if (repo.owner() === undefined) repo.createOwner({ id: OWNER_ID, name: 'Owner', role: 'owner' })
}

/** Issue a legacy token (kept for the legacy-path tests: `token create` now issues credentials). */
export async function createToken(
  repo: TokensRepo,
  personId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const token = newToken()
  const id = uuidv7()
  repo.addToken({ id, personId, label, hash: await hashToken(token) })
  return { id, token }
}

/** The principal of a legacy `Authorization: Bearer keith_<b64>` header, or undefined. */
export async function verifyAuthorization(
  repo: TokensRepo,
  header: string | null,
): Promise<Principal | undefined> {
  const token = bearerOf(header)
  if (token === undefined || !LEGACY_RE.test(token)) return undefined
  const found = repo.findByHash(await hashToken(token))
  if (found === undefined || !isActive(found.person)) return undefined
  return {
    personId: found.personId,
    role: found.person.role,
    username: found.person.username,
    name: found.person.name,
    credential: { id: found.id, kind: 'legacy' },
    elevated: false,
  }
}

/** The bearer token of an `Authorization` header, or undefined. */
export function bearerOf(header: string | null): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1]
}
