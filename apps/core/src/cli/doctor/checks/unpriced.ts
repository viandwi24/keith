import { openOfflineAdmin } from '../../../modules/admin/index.ts'
import type { Config } from '../../../platform/config.ts'
import type { CliDeps } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * A model of a role with no catalog price: its spend is not counted (ADR-0027 §23). Read from the
 * role picks and the catalog, so this process needs no state of the running core. Needs the network
 * to read the catalog, so `--offline` skips it.
 */
export async function unpricedChecks(
  config: Config,
  deps: CliDeps,
  offline: boolean,
): Promise<Check[]> {
  if (offline) return []
  const admin = await openOfflineAdmin(config, { ...deps.offline, readOnly: true }).catch(
    () => undefined,
  )
  if (admin === undefined) return []
  try {
    const out: Check[] = []
    for (const role of ['front', 'cortex', 'guest'] as const) {
      const { ref, priced } = await admin.providers.rolePricing(role)
      if (ref === null || priced) continue
      out.push({
        level: 'warn',
        name: `price ${ref}`,
        hint: `no price for ${ref}: spend is not counted; set one with keith-core model price set ${ref} --in <usd> --out <usd>`,
      })
    }
    return out
  } finally {
    admin.close()
  }
}

/** Needs a migrated database. */
export const unpricedCheck: DoctorCheck = ({ config, deps, offline, checks }) =>
  checks.find((c) => c.name === 'database')?.level === 'ok'
    ? unpricedChecks(config, deps, offline)
    : []
