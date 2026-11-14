import { defineCommand } from '@keith/cli'
import { effectiveNetwork } from '../modules/admin/index.ts'
import { type CliDeps, configOf } from './context.ts'
import { backupCheck } from './doctor/checks/backup.ts'
import { clockCheck } from './doctor/checks/clock.ts'
import { databaseCheck, secretKeyCheck } from './doctor/checks/database.ts'
import { deliveryCheck } from './doctor/checks/delivery.ts'
import { driversTableCheck } from './doctor/checks/drivers.ts'
import { grantsCheck } from './doctor/checks/grants.ts'
import { guestsProxyCheck } from './doctor/checks/guests-proxy.ts'
import { dataDirCheck } from './doctor/checks/loose-modes.ts'
import { networkTableCheck } from './doctor/checks/network.ts'
import { protocolsCheck } from './doctor/checks/protocols.ts'
import { providersTableCheck } from './doctor/checks/providers.ts'
import { sandboxCheck } from './doctor/checks/sandbox.ts'
import { setupCheck } from './doctor/checks/setup.ts'
import { socketCheck } from './doctor/checks/socket.ts'
import { successionCheck } from './doctor/checks/succession.ts'
import { tailscaleCheck } from './doctor/checks/tailscale.ts'
import { unpricedCheck } from './doctor/checks/unpriced.ts'
import { usernamesCheck } from './doctor/checks/usernames.ts'
import { viewsTableCheck } from './doctor/checks/views.ts'
import { visionCheck } from './doctor/checks/vision.ts'
import {
  type Check,
  type DoctorCheck,
  type DoctorCtx,
  exitCodeOf,
  formatCheck,
} from './doctor/types.ts'

export { viewsCheck } from './doctor/checks/views.ts'
export { type Check, exitCodeOf, formatCheck, type Level, MARK } from './doctor/types.ts'

/** Every doctor check, in the order the lines print. Later plans add a row per check (files in `./doctor/checks/`). */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  dataDirCheck,
  databaseCheck,
  backupCheck,
  secretKeyCheck,
  setupCheck,
  usernamesCheck,
  grantsCheck,
  deliveryCheck,
  protocolsCheck,
  successionCheck,
  providersTableCheck,
  unpricedCheck,
  guestsProxyCheck,
  socketCheck,
  viewsTableCheck,
  driversTableCheck,
  visionCheck,
  sandboxCheck,
  networkTableCheck,
  tailscaleCheck,
  clockCheck,
]

/** Every doctor check, in order; the command prints them and the console shows them on screen. */
export async function runDoctorChecks(deps: CliDeps, offline: boolean): Promise<Check[]> {
  const config = configOf(deps)
  const checks: Check[] = []
  const ctx: DoctorCtx = {
    deps,
    config,
    offline,
    checks,
    net: effectiveNetwork(config, { get: () => undefined, set() {}, delete() {} }),
  }
  for (const check of DOCTOR_CHECKS) checks.push(...(await check(ctx)))
  return checks
}

export function doctorCommand(deps: CliDeps) {
  return defineCommand({
    name: 'doctor',
    summary: 'Check the data folder, database, provider, models, socket and access',
    flags: { offline: { type: 'boolean', description: 'Skip checks that need the network' } },
    run: async (ctx) => {
      const checks = await runDoctorChecks(deps, ctx.bool('offline'))
      for (const c of checks) ctx.io.stdout.write(`${formatCheck(c)}\n`)
      return exitCodeOf(checks)
    },
  })
}
