import { openOfflineAdmin } from '../../../modules/admin/index.ts'
import type { Config } from '../../../platform/config.ts'
import type { CliDeps } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

export async function providerChecks(
  config: Config,
  deps: CliDeps,
  offline: boolean,
): Promise<Check[]> {
  const out: Check[] = []
  // read only (P23.4.6): no lock, no secret.key, no audit row; a key this process cannot open is a note
  const admin = await openOfflineAdmin(config, { ...deps.offline, readOnly: true }).catch(
    (error: Error) => {
      out.push({ level: 'fail', name: 'provider', hint: error.message })
      return undefined
    },
  )
  if (admin === undefined) return out
  try {
    const all = await admin.providers.list()
    const unreadable = all.filter((x) => x.needsReentry === true)
    for (const c of unreadable) {
      out.push({
        level: 'warn',
        name: `provider ${c.id}`,
        hint: 'doctor cannot read the key the core uses: run it with the same KEITH_SECRET_KEY',
      })
    }
    const connections = all.filter((c) => c.enabled)
    if (connections.length === 0) {
      // with keys this process cannot read, "none configured" would be a false failure
      if (unreadable.length === 0)
        out.push({
          level: 'fail',
          name: 'provider',
          hint: 'none configured: keith-core provider add',
        })
    } else if (offline) {
      out.push({
        level: 'ok',
        name: 'provider',
        hint: `${connections.map((c) => c.id).join(', ')} (network skipped)`,
      })
    } else {
      for (const c of connections) {
        const r = await admin.providers
          .test(c.id)
          .catch((e: Error) => ({ ok: false, message: e.message, latencyMs: undefined }))
        out.push(
          r.ok
            ? {
                level: 'ok',
                name: `provider ${c.id}`,
                hint: `reachable${r.latencyMs === undefined ? '' : ` (${r.latencyMs} ms)`}`,
              }
            : {
                level: 'fail',
                name: `provider ${c.id}`,
                hint: `${r.message ?? 'not reachable'}: check the key and the network (keith-core provider test ${c.id})`,
              },
        )
      }
    }
    const roles = await admin.providers.roles()
    out.push(
      roles.front === null
        ? { level: 'fail', name: 'front model', hint: 'not set: keith-core model set front <id>' }
        : { level: 'ok', name: 'front model', hint: roles.front },
    )
  } finally {
    admin.close()
  }
  return out
}

/** Needs a migrated database. */
export const providersTableCheck: DoctorCheck = ({ config, deps, offline, checks }) =>
  checks.find((c) => c.name === 'database')?.level === 'ok'
    ? providerChecks(config, deps, offline)
    : []
