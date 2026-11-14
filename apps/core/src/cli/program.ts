import { type CliIo, isInteractive, runCli } from '@keith/cli'
import { aclCommand } from './acl-command.ts'
import { accessCommand, budgetCommand, modelCommand, providerCommand } from './admin-commands.ts'
import { adminLoginCommands } from './admin-login-command.ts'
import { auditCommand, devicesCommand, tokenCommand } from './auth-commands.ts'
import { authCommand } from './auth-policy-command.ts'
import { backupCommand, restoreCommand } from './backup-commands.ts'
import { runConsole } from './console.tsx'
import type { CliDeps } from './context.ts'
import { doctorCommand } from './doctor.ts'
import { groupsCommand } from './groups-command.ts'
import { guestsCommand } from './guests-command.ts'
import { logsCommand } from './logs-command.ts'
import { noticeCommand } from './notify-command.ts'
import {
  approvalsCommand,
  configCommand,
  dbCommand,
  nodesCommand,
  pairCommand,
} from './ops-commands.ts'
import { peopleCommand } from './people-commands.ts'
import { personaCommand } from './persona-command.ts'
import { pluginCommand } from './plugin-command.ts'
import { presenceCommand } from './presence-command.ts'
import { protocolsCommand } from './protocols-command.ts'
import { reviewsCommand } from './reviews-command.ts'
import { roomsCommand } from './rooms-command.ts'
import { sessionsCommand } from './sessions-command.ts'
import { setupCommand } from './setup.ts'
import { startCommand } from './start.ts'
import { statusCommand } from './status.ts'
import { successionCommand } from './succession-command.ts'

/** Run `keith-core <argv>`; returns the exit code. Tests call it with fake io and deps. */
export function runCoreCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  // no arguments on a terminal: the console (wizard, home screen or the manager); piped or with
  // `--help`, the help text as always
  if (argv.length === 0 && isInteractive(io)) return runConsole(io, deps)
  return runCli({
    program: 'keith-core',
    version: deps.version ?? '0.1.0',
    summary: 'Run and administer the Keith core on this machine',
    argv,
    io,
    commands: [
      setupCommand(deps),
      startCommand(deps),
      statusCommand(deps),
      doctorCommand(deps),
      accessCommand(deps),
      providerCommand(deps),
      modelCommand(deps),
      budgetCommand(deps),
      pairCommand(deps),
      nodesCommand(deps),
      approvalsCommand(deps),
      protocolsCommand(deps),
      successionCommand(deps),
      roomsCommand(deps),
      personaCommand(deps),
      peopleCommand(deps),
      presenceCommand(deps),
      noticeCommand(deps),
      groupsCommand(deps),
      aclCommand(deps),
      pluginCommand(deps),
      guestsCommand(deps),
      reviewsCommand(deps),
      devicesCommand(deps),
      sessionsCommand(deps),
      logsCommand(deps),
      ...adminLoginCommands(deps),
      authCommand(deps),
      tokenCommand(deps),
      auditCommand(deps),
      configCommand(deps),
      dbCommand(deps),
      backupCommand(deps),
      restoreCommand(deps),
    ],
  })
}
