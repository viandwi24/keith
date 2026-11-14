import { USERNAME_RE } from '@keith/contracts'
import { openReadOnlyDatabase } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * Usernames made before P23.1.16 may hold digits only (they could equal a phone alias). They keep
 * signing in; this lists them as a note so the owner can rename them (`keith-core people rename`).
 */
export const usernamesCheck: DoctorCheck = (ctx) => {
  if (ctx.checks.find((c) => c.name === 'database')?.level !== 'ok') return []
  const sqlite = openReadOnlyDatabase(ctx.config.dbFile)
  try {
    const rows = sqlite
      .query<{ username: string }, []>(
        'SELECT username FROM people WHERE username IS NOT NULL ORDER BY username',
      )
      .all()
    const old = rows.filter((r) => !USERNAME_RE.test(r.username) && /^[0-9._-]+$/.test(r.username))
    if (old.length === 0) return []
    const note: Check = {
      level: 'warn',
      name: 'usernames',
      hint: `digits-only username${old.length === 1 ? '' : 's'} (${old.map((r) => r.username).join(', ')}) could equal a phone number: they still sign in; rename with keith-core people rename <username> <new-username>`,
    }
    return [note]
  } finally {
    sqlite.close()
  }
}
