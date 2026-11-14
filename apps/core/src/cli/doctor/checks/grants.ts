import { OWNER_ONLY_CAPABILITIES } from '@keith/contracts'
import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * A grant of an owner-only capability (`audit.read` since P23) to a member is ignored by the core. Older versions
 * allowed it, so a stored grant may remain: one note per person tells the owner it does nothing now.
 */
export const grantsCheck: DoctorCheck = (ctx) => {
  if (ctx.checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const sqlite = openReadOnlyDatabase(ctx.config.dbFile)
  try {
    const marks = OWNER_ONLY_CAPABILITIES.map(() => '?').join(', ')
    const rows = sqlite
      .query<{ name: string; capability: string }, string[]>(
        `SELECT COALESCE(p.username, p.name) AS name, g.capability AS capability
           FROM person_grants g JOIN people p ON p.id = g.person_id
          WHERE p.role != 'owner' AND g.capability IN (${marks})
          ORDER BY name, g.capability`,
      )
      .all(...OWNER_ONLY_CAPABILITIES)
    return rows.map(
      (r): Check => ({
        level: 'warn',
        name: 'grants',
        hint: `${r.capability} granted to ${r.name}: ignored since P23 (owner only); revoke it with keith-core people revoke-grant`,
      }),
    )
  } finally {
    sqlite.close()
  }
}
