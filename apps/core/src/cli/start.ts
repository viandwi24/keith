import { existsSync } from 'node:fs'
import {
  askHidden,
  CliError,
  type CliIo,
  confirm,
  defineCommand,
  isInteractive,
  UsageError,
} from '@keith/cli'
import { openDatabase, secretsRepo, settingsRepo, tokensRepo } from '@keith/db'
import { isSetUp, withOfflineAdmin } from '../modules/admin/index.ts'
import { createHasher } from '../modules/auth/index.ts'
import { bootstrap } from '../platform/bootstrap.ts'
import { dbState, refusalOf } from '../platform/db.ts'
import { exitOnSignals, installCrashHandlers, runCore, StartError } from '../run-core.ts'
import { type CliDeps, configOf } from './context.ts'
import { setupCommand } from './setup.ts'
import { recordOwnerSignIn, saveOwnerPin } from './setup-steps.ts'

/** Whether setup completed here; false for a missing or unmigrated database. */
export function configured(dbFile: string): boolean {
  if (!existsSync(dbFile)) return false
  const sqlite = openDatabase(dbFile)
  try {
    return isSetUp(settingsRepo(sqlite))
  } catch {
    return false // settings table missing: not migrated yet
  } finally {
    sqlite.close()
  }
}

/** Whether the owner has a PIN or a password: without one nobody can sign in to the socket (`local trust: none`). */
export function ownerHasSignIn(dbFile: string): boolean {
  if (!existsSync(dbFile)) return false
  const sqlite = openDatabase(dbFile)
  try {
    const owner = tokensRepo(sqlite).owner()
    return owner !== undefined && secretsRepo(sqlite).kinds(owner.id).length > 0
  } catch {
    return false
  } finally {
    sqlite.close()
  }
}

export const NOT_SET_UP = 'this data folder is not set up: run `keith-core setup`'

export const NO_SIGN_IN =
  'the owner has no way to sign in (no PIN or password): run `keith-core setup`, or `keith-core start` on a terminal'

/**
 * Before core serves a socket: a set-up data folder whose owner has no PIN and no password gets one now
 * (a terminal: the PIN is asked twice, hidden), or a one-line instruction (no terminal; the first `keith`
 * start then offers the same). Returns true when the owner can sign in afterwards.
 */
export async function ensureOwnerSignIn(io: CliIo, deps: CliDeps): Promise<boolean> {
  const config = configOf(deps)
  if (ownerHasSignIn(config.dbFile)) return true
  if (!configured(config.dbFile) || !isInteractive(io)) {
    io.stderr?.write(`${NO_SIGN_IN}\n`)
    return false
  }
  const yes = await confirm('The owner has no way to sign in. Set a PIN now?', {
    default: true,
    io,
  })
  if (!yes) {
    io.stderr?.write(`${NO_SIGN_IN}\n`)
    return false
  }
  let pin = ''
  for (;;) {
    pin = await askHidden('Owner PIN (6 to 12 digits)', {
      io,
      validate: (v) => (v === '' ? 'a PIN is needed' : undefined),
    })
    if (pin === (await askHidden('Owner PIN, again', { io }))) break
    io.stdout.write('They differ. Try again.\n')
  }
  const hasher = deps.hasher === undefined ? undefined : createHasher(deps.hasher)
  const problem = await withOfflineAdmin(
    config,
    { migrate: false, ...deps.offline },
    async (admin) => {
      const refused = await saveOwnerPin(admin, pin, hasher)
      if (refused === undefined) recordOwnerSignIn(admin, ['pin'])
      return refused
    },
  )
  if (problem !== undefined) throw new CliError(`the PIN was refused: ${problem}`)
  return true
}

/** Run core in this process until a signal (what `keith-core start` does once setup is known). */
export async function startCore(io: CliIo, deps: CliDeps): Promise<number> {
  const config = configOf(deps)
  const { logger } = deps.start?.logger
    ? { logger: deps.start.logger }
    : bootstrap(deps.env ?? process.env)
  installCrashHandlers(logger)
  try {
    const running = await runCore({
      config,
      logger,
      ...(deps.start?.core === undefined ? {} : { core: deps.start.core }),
      ...(deps.start?.port === undefined ? {} : { port: deps.start.port }),
    })
    io.stdout.write(`keith core is up: ${running.url}  (owner socket ${running.socketPath})\n`)
    exitOnSignals(running, logger)
    await new Promise<never>(() => undefined) // runs until a signal
  } catch (error) {
    if (error instanceof StartError) throw new CliError(error.message)
    throw error
  }
  return 0
}

export function startCommand(deps: CliDeps) {
  return defineCommand({
    name: 'start',
    summary: 'Run core (TCP, plus the local owner socket)',
    flags: {
      'no-setup-check': { type: 'boolean', description: 'Start even when setup was never run' },
    },
    run: async (ctx) => {
      const config = configOf(deps)
      // a database another build wrote, or one that cannot be read, is never an un-setup folder: say why
      const refusal = refusalOf(dbState(config.dbFile), config)
      if (refusal !== undefined) throw new CliError(refusal)
      if (!ctx.bool('no-setup-check') && !configured(config.dbFile)) {
        if (!isInteractive(ctx.io)) {
          throw new UsageError(NOT_SET_UP)
        }
        const yes = await confirm('Keith is not set up yet. Run setup now?', {
          default: true,
          io: ctx.io,
        })
        if (!yes) throw new CliError('not set up: run `keith-core setup`')
        const code = await setupCommand(deps).run?.(ctx)
        if (code !== undefined && code !== 0) return code
      }
      // an un-setup core must not serve a socket that has no way to sign in
      await ensureOwnerSignIn(ctx.io, deps)
      return startCore(ctx.io, deps)
    },
  })
}
