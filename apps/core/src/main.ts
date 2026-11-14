// `bun run --filter @keith/core start` / `dev`: run the core (same as `keith-core start`, without
// the setup check). Wiring only: the work is in run-core.ts.
import { processIo } from '@keith/cli'
import { configured, ensureOwnerSignIn, NOT_SET_UP } from './cli/start.ts'
import { bootstrap } from './platform/bootstrap.ts'
import { dbState, refusalOf } from './platform/db.ts'
import { exitOnSignals, installCrashHandlers, runCore } from './run-core.ts'

const { config, logger } = bootstrap()
installCrashHandlers(logger)
try {
  const refusal = refusalOf(dbState(config.dbFile), config)
  if (refusal !== undefined) {
    logger.error(refusal)
    await logger.flush()
    process.exit(1)
  }
  // an un-setup core must not serve a socket that has no way to sign in
  if (!configured(config.dbFile)) {
    logger.error(NOT_SET_UP)
    await logger.flush()
    process.exit(2)
  }
  await ensureOwnerSignIn(processIo(), { env: process.env })
  exitOnSignals(await runCore({ config, logger }), logger)
} catch (error) {
  // expected boot failures (not migrated, bad key, already running) are one readable line
  logger.error(error instanceof Error ? error.message : String(error))
  await logger.flush()
  process.exit(1)
}
