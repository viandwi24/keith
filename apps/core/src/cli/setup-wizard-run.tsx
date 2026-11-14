import { CliError, type CliIo, type CommandContext } from '@keith/cli'
import { LockHeldError, openOfflineAdmin } from '../modules/admin/index.ts'
import { createHasher } from '../modules/auth/index.ts'
import type { Config } from '../platform/config.ts'
import type { WizardOutcome } from './console-types.ts'
import type { CliDeps } from './context.ts'
import { runInk } from './ink-run.tsx'
import { SetupWizard } from './setup-wizard.tsx'

/** The flags that answer a question: with any of them the line-prompt flow runs, not the wizard. */
const ANSWER_FLAGS = [
  'owner-name',
  'owner-username',
  'provider',
  'front-model',
  'cortex-model',
  'budget',
  'access',
  'public-url',
  'bind',
] as const
const ANSWER_SWITCHES = [
  'api-key-stdin',
  'skip-test',
  'owner-pin-stdin',
  'owner-password-stdin',
] as const

export function wizardWanted(ctx: CommandContext): boolean {
  return (
    ANSWER_FLAGS.every((f) => ctx.string(f) === undefined) &&
    ANSWER_SWITCHES.every((f) => !ctx.bool(f))
  )
}

/** Open the offline admin, run the wizard on this terminal, close the admin. */
export async function runSetupWizard(
  _io: CliIo,
  deps: CliDeps,
  config: Config,
): Promise<WizardOutcome> {
  const custom = deps.console?.ui?.wizard
  if (custom !== undefined) return custom(_io, config)
  let admin: Awaited<ReturnType<typeof openOfflineAdmin>>
  try {
    admin = await openOfflineAdmin(config, { migrate: true, ...deps.offline })
  } catch (error) {
    if (error instanceof LockHeldError) throw new CliError(`${error.message}; stop it first`)
    throw error
  }
  try {
    const hasher = createHasher(deps.hasher)
    return await runInk<WizardOutcome>(config, { status: 'cancelled' }, (done) => (
      <SetupWizard admin={admin} config={config} hasher={hasher} onDone={done} />
    ))
  } finally {
    admin.close()
  }
}
