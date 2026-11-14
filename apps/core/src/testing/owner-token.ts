import { credentialsRepo, tokensRepo } from '@keith/db'
import { createCredential, ensureOwner } from '../modules/auth/index.ts'
import type { Config } from '../platform/config.ts'
import { openKeithDatabase } from '../platform/db.ts'

/**
 * Tests: a live owner `token` credential minted straight in the database (boot issues none). It is
 * for `options.personId` (default the owner; the person must exist), already stepped up for ten minutes (`elevated: false` for a test of the step-up itself), so the
 * tests that manage settings or nodes over TCP need no PIN round trip.
 */
export async function issueOwnerToken(
  config: Config,
  label = 'test',
  options: { elevated?: boolean; personId?: string } = {},
): Promise<string> {
  const sqlite = await openKeithDatabase(config.dataDir, config.dbFile)
  try {
    const repo = tokensRepo(sqlite)
    ensureOwner(repo)
    const credentials = credentialsRepo(sqlite)
    const created = await createCredential(credentials, {
      personId: options.personId ?? 'owner',
      kind: 'token',
      label,
    })
    if (options.elevated !== false) credentials.setElevated(created.id, Date.now() + 10 * 60_000)
    return created.token
  } finally {
    sqlite.close()
  }
}
