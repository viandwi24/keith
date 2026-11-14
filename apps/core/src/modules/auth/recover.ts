import type { CredentialsRepo, TokensRepo } from '@keith/db'
import { createCredential } from './credentials.ts'
import { OWNER_ID } from './tokens.ts'

/**
 * `token recover` (offline): revoke every credential and legacy token of the owner and issue one
 * new `token` credential. The caller audits it.
 */
export async function recoverOwner(
  tokens: TokensRepo,
  credentials: CredentialsRepo,
): Promise<{ id: string; token: string; revoked: number }> {
  if (tokens.owner() === undefined)
    tokens.createOwner({ id: OWNER_ID, name: 'Owner', role: 'owner' })
  // the current owner, who is not `owner` after a transfer
  const ownerId = tokens.owner()?.id ?? OWNER_ID
  const revoked = tokens.revokeAll(ownerId) + credentials.revokeAll(ownerId)
  const created = await createCredential(credentials, {
    personId: ownerId,
    kind: 'token',
    label: 'recover',
  })
  return { ...created, revoked }
}
