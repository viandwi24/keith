import { CliError, defineCommand, type FlagDef } from '@keith/cli'
import { joinNode } from './join.ts'
import { resolveConfigPath } from './platform/config.ts'

export const coreFlag: FlagDef = {
  type: 'string',
  placeholder: 'url',
  description: 'Core URL, e.g. http://127.0.0.1:7420',
}
export const codeFlag: FlagDef = {
  type: 'string',
  placeholder: 'code',
  description: 'Pairing code from `keith-core pair` on the core machine',
}
export const nameFlag: FlagDef = {
  type: 'string',
  placeholder: 'slug',
  description: 'Node name (default: the host name)',
}
export const allowShellFlag: FlagDef = {
  type: 'boolean',
  default: false,
  description: 'Allow shell.exec on this node (each command still needs the owner approval)',
}
export const workdirFlag: FlagDef = {
  type: 'string',
  placeholder: 'dir',
  description: 'Work folder for commands (default: ~/.keith/workspace)',
}
export const sharedJoinFlags: Record<string, FlagDef> = {
  core: coreFlag,
  code: codeFlag,
  name: nameFlag,
  'allow-shell': allowShellFlag,
  workdir: workdirFlag,
  insecure: {
    type: 'boolean',
    default: false,
    description: 'Accept plain http to a host that is not loopback or Tailscale',
  },
  config: {
    type: 'string',
    placeholder: 'path',
    description: 'Node config file (default: $KEITH_NODE_CONFIG or ~/.keith/node.json)',
  },
}

export const joinCommand = defineCommand({
  name: 'join',
  summary: 'Pair with a core using a pairing code (non-interactive; see setup)',
  flags: sharedJoinFlags,
  examples: ['keith-node join --core http://127.0.0.1:7420 --code ABCD-EFGH --allow-shell'],
  run: async (ctx) => {
    const core = ctx.require('core')
    const code = ctx.require('code')
    const configPath = resolveConfigPath(ctx.string('config'))
    const name = ctx.string('name')
    const workdir = ctx.string('workdir')
    let config: Awaited<ReturnType<typeof joinNode>>
    try {
      config = await joinNode({
        core,
        code,
        allowShell: ctx.bool('allow-shell'),
        insecure: ctx.bool('insecure'),
        warn: (message) => ctx.io.stderr?.write(`${message}\n`),
        configPath,
        ...(name ? { name } : {}),
        ...(workdir ? { workdir } : {}),
      })
    } catch (error) {
      throw new CliError((error as Error).message)
    }
    ctx.io.stdout.write(
      `Joined ${config.core} as ${config.name} (${config.nodeId}). Config saved to ${configPath}.\n` +
        `Next: keith-node run${ctx.string('config') ? ` --config ${configPath}` : ''}\n`,
    )
    return 0
  },
})
