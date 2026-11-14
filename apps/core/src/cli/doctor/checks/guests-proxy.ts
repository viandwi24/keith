import { openOfflineAdmin } from '../../../modules/admin/index.ts'
import { createGuestSettings } from '../../../modules/guests/index.ts'
import type { Config } from '../../../platform/config.ts'
import type { CliDeps } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * A public guest zone with no trusted proxy: behind a reverse proxy every visitor shares one address and one window
 * (guests.md, "Behind a proxy"). Read only; `--offline` does not change it.
 */
export async function guestsProxyChecks(config: Config, deps: CliDeps): Promise<Check[]> {
  const admin = await openOfflineAdmin(config, { ...deps.offline, readOnly: true }).catch(
    () => undefined,
  )
  if (admin === undefined) return []
  try {
    const settings = createGuestSettings(admin.settings).get()
    if (!settings.zones.includes('public') || settings.trustedProxy !== 'none') return []
    return [
      {
        level: 'warn',
        name: 'guests proxy',
        hint: 'the public guest zone has no trusted proxy: behind a proxy all visitors share one window (keith-core guests set --trusted-proxy x-forwarded-for --proxy-addr <proxy>)',
      },
    ]
  } finally {
    admin.close()
  }
}

/** Needs a migrated database. */
export const guestsProxyCheck: DoctorCheck = ({ config, deps, checks }) =>
  checks.find((c) => c.name === 'database')?.level === 'ok' ? guestsProxyChecks(config, deps) : []
