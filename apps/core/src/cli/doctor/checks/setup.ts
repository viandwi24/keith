import { identifiersRepo, secretsRepo, settingsRepo, tokensRepo } from '@keith/db'
import { effectiveNetwork, isSetUp } from '../../../modules/admin/index.ts'
import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

/** Setup done and the owner can sign in; also reads the stored network settings into `ctx.net`. Needs a migrated database; read only. */
export const setupCheck: DoctorCheck = (ctx) => {
  const { config, checks } = ctx
  if (checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const out: Check[] = []
  const sqlite = openReadOnlyDatabase(config.dbFile)
  try {
    const settings = settingsRepo(sqlite)
    ctx.net = effectiveNetwork(config, settings)
    out.push(
      isSetUp(settings)
        ? { level: 'ok', name: 'setup', hint: 'done' }
        : { level: 'fail', name: 'setup', hint: 'not run: keith-core setup' },
    )
    const owner = tokensRepo(sqlite).owner()
    const kinds = owner === undefined ? [] : secretsRepo(sqlite).kinds(owner.id)
    // a secret that the owner's sign-in switch refuses (people.can_login = 0) is no sign-in (FD13-08)
    const canLogin = owner !== undefined && identifiersRepo(sqlite).canLogin(owner.id)
    if (kinds.length === 0)
      out.push({
        level: 'fail',
        name: 'owner sign-in',
        hint: 'not set: nobody can sign in on this machine. Stop core and run: keith-core setup (or open keith: it offers to set a PIN)',
      })
    else if (!canLogin)
      out.push({
        level: 'fail',
        name: 'owner sign-in',
        hint: `set: ${kinds.join(' and ')}, but the owner cannot sign in (sign-in is off): remote sign-in is refused. Give the owner role to a member who can sign in: keith-core people transfer-owner <username>`,
      })
    else out.push({ level: 'ok', name: 'owner sign-in', hint: `set: ${kinds.join(' and ')}` })
  } finally {
    sqlite.close()
  }
  return out
}
