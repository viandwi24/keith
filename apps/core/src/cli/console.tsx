// `keith-core` with no arguments on a terminal: the console launcher (docs/specs/core-cli.md).
import type { CliIo } from '@keith/cli'
import { probeSocket, socketPathFor } from '../modules/local-socket/index.ts'
import type { Config } from '../platform/config.ts'
import { ConsoleHome } from './console-home.tsx'
import type { HomeChoice, HomeProps } from './console-types.ts'
import { type CliDeps, configOf } from './context.ts'
import { runDoctorChecks } from './doctor.ts'
import { runInk } from './ink-run.tsx'
import { runSetupWizard } from './setup-wizard-run.tsx'
import { configured, ensureOwnerSignIn, startCore } from './start.ts'

/** Where a launch goes first (exported for tests): the wizard, the home screen or the manager. */
export type Landing = 'wizard' | 'home' | 'manage'

export async function landingOf(deps: CliDeps, config: Config): Promise<Landing> {
  const socketPath = socketPathFor(config.dataDir)
  if (await (deps.console?.probe ?? probeSocket)(socketPath)) return 'manage'
  const isConfigured = deps.console?.configured ?? ((c: Config) => configured(c.dbFile))
  return isConfigured(config) ? 'home' : 'wizard'
}

/** Hand the terminal to `keith manage` against the running core, or say how to get `keith`. */
async function handOff(io: CliIo, deps: CliDeps, socketPath: string): Promise<number> {
  const core = `unix:${socketPath}`
  const keith = (deps.console?.which ?? Bun.which)('keith')
  if (keith === null) {
    io.stdout.write(
      `core is running. Manage it with:\n\n  keith manage --core ${core}\n\n` +
        '`keith` is not on your PATH. From a checkout, run `bun run link` once.\n',
    )
    return 0
  }
  const spawn =
    deps.console?.spawn ??
    (async (command: string[]) =>
      await Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited)
  return await spawn([keith, 'manage', '--core', core])
}

async function runHome(deps: CliDeps, config: Config, notice?: string): Promise<HomeChoice> {
  const props: HomeProps = { notice, doctor: () => runDoctorChecks(deps, false) }
  const custom = deps.console?.ui?.home
  if (custom !== undefined) return custom(props, config)
  return runInk<HomeChoice>(config, 'quit', (done) => <ConsoleHome {...props} onChoose={done} />)
}

/** The console loop: wizard until set up, then the home screen, or the manager when core runs. */
export async function runConsole(io: CliIo, deps: CliDeps): Promise<number> {
  const config = configOf(deps)
  let notice: string | undefined
  for (;;) {
    const landing = await landingOf(deps, config)
    if (landing === 'manage') return handOff(io, deps, socketPathFor(config.dataDir))
    if (landing === 'wizard') {
      const outcome = await runSetupWizard(io, deps, config)
      if (outcome.status === 'cancelled') {
        io.stdout.write('Setup cancelled; nothing was saved.\n')
        return 0
      }
      notice = 'Setup saved.'
      continue
    }
    const choice = await runHome(deps, config, notice)
    notice = undefined
    if (choice === 'quit') return 0
    if (choice === 'start') {
      // the same owner sign-in offer as `keith-core start`, asked after the Ink screen has returned
      await (deps.console?.ownerSignIn ?? ((i) => ensureOwnerSignIn(i, deps)))(io)
      return (deps.console?.start ?? ((i) => startCore(i, deps)))(io)
    }
    const outcome = await runSetupWizard(io, deps, config)
    if (outcome.status === 'saved') notice = 'Setup saved.'
  }
}
