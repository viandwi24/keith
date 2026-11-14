import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dbState, refusalOf } from '../../../platform/db.ts'
import type { DoctorCheck } from '../types.ts'

/** Migrated database. Skipped when the data folder is missing (the data dir check already failed). */
export const databaseCheck: DoctorCheck = ({ config }) => {
  if (!existsSync(config.dataDir)) return []
  const state = dbState(config.dbFile)
  if (state.kind === 'ready') return [{ level: 'ok', name: 'database', hint: 'migrated' }]
  if (state.kind === 'missing' || state.kind === 'behind')
    return [
      {
        level: 'fail',
        name: 'database',
        hint: 'missing or behind: run keith-core db migrate (or setup)',
      },
    ]
  // ahead, diverged and unreadable: one line each, the refusal text is the hint
  return [{ level: 'fail', name: 'database', hint: refusalOf(state, config) ?? state.kind }]
}

/** Where the secret key comes from. Skipped when the data folder is missing. */
export const secretKeyCheck: DoctorCheck = ({ config }) => {
  if (!existsSync(config.dataDir)) return []
  const keyFile = join(config.dataDir, 'secret.key')
  return [
    config.secretKey !== undefined
      ? { level: 'ok', name: 'secret key', hint: 'KEITH_SECRET_KEY is set' }
      : existsSync(keyFile)
        ? {
            level: 'warn',
            name: 'secret key',
            hint: `dev key file ${keyFile}: set KEITH_SECRET_KEY for a real install`,
          }
        : {
            level: 'warn',
            name: 'secret key',
            hint: 'none yet: created on first start (dev key file)',
          },
  ]
}
