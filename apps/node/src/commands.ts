import { CliError, type Command, defineCommand, type FlagDef } from '@keith/cli'
import { checkCoreUrl } from './core-url.ts'
import { driverCommand } from './driver-command.ts'
import { joinCommand } from './join-command.ts'
import { loadConfig, resolveConfigPath } from './platform/config.ts'
import { createLogger, print } from './platform/logger.ts'
import { runNode } from './run.ts'
import { setupCommand } from './setup.ts'

export const configFlag: FlagDef = {
  type: 'string',
  placeholder: 'path',
  description: 'Node config file (default: $KEITH_NODE_CONFIG or ~/.keith/node.json)',
}
export const insecureFlag: FlagDef = {
  type: 'boolean',
  default: false,
  description: 'Accept plain http to a host that is not loopback or Tailscale',
}

function runCommand(signal: AbortSignal | undefined): Command {
  return defineCommand({
    name: 'run',
    summary: 'Connect to the core and serve commands until stopped',
    flags: { insecure: insecureFlag, config: configFlag },
    examples: ['keith-node run'],
    run: async (ctx) => {
      const configPath = resolveConfigPath(ctx.string('config'))
      const config = await loadConfig(configPath)
      const checked = checkCoreUrl(config.core, ctx.bool('insecure'))
      if (!checked.ok) throw new CliError(checked.error)
      const logger = createLogger()
      if (checked.warning !== undefined) logger.warn(checked.warning)
      return await runNode(config, { logger, configPath, ...(signal ? { signal } : {}) })
    },
  })
}

const statusCommand = defineCommand({
  name: 'status',
  summary: 'Show the saved node config (without the token)',
  flags: { config: configFlag },
  run: async (ctx) => {
    const configPath = resolveConfigPath(ctx.string('config'))
    const { token: _token, ...safe } = await loadConfig(configPath)
    print(JSON.stringify({ configPath, ...safe }, null, 2))
    return 0
  },
})

export function nodeCommands(signal?: AbortSignal): Command[] {
  return [setupCommand, joinCommand, runCommand(signal), statusCommand, driverCommand()]
}
