import { ask, CliError, confirm, defineCommand, printNextSteps, UsageError } from '@keith/cli'
import { checkCoreUrl } from './core-url.ts'
import { joinNode } from './join.ts'
import { sharedJoinFlags } from './join-command.ts'
import { defaultNodeName } from './manifest.ts'
import { defaultWorkdir, loadConfig, resolveConfigPath } from './platform/config.ts'

export const setupCommand = defineCommand({
  name: 'setup',
  summary: 'Interactive join: ask for the core, pairing code and policy, then pair',
  flags: {
    ...sharedJoinFlags,
    'non-interactive': {
      type: 'boolean',
      default: false,
      description: 'Never prompt; a missing --core or --code is a usage error',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Re-join without asking when a node config already exists',
    },
  },
  examples: [
    'keith-node setup',
    'keith-node setup --non-interactive --core http://127.0.0.1:7420 --code ABCD-EFGH',
  ],
  run: async (ctx) => {
    const { io } = ctx
    const interactive = !ctx.bool('non-interactive')
    const configPath = resolveConfigPath(ctx.string('config'))
    const insecure = ctx.bool('insecure')
    const out = (text: string): void => {
      io.stdout.write(`${text}\n`)
    }

    // An existing config: show it and confirm before re-joining.
    const existing = await loadConfig(configPath).catch(() => undefined)
    if (existing !== undefined || (await Bun.file(configPath).exists())) {
      if (existing !== undefined) {
        out(`A node config already exists at ${configPath}:`)
        out(`  core ${existing.core}, name ${existing.name}, node ${existing.nodeId}`)
        out(
          `  shell ${existing.policy.allowShell ? 'allowed' : 'off'}, workdir ${existing.policy.workdir}`,
        )
      } else out(`A file already exists at ${configPath} (not a valid node config).`)
      if (!ctx.bool('force')) {
        if (!interactive) throw new UsageError('node config exists; pass --force to re-join')
        if (!(await confirm('Re-join and replace it?', { default: false, io }))) {
          out('Nothing changed.')
          return 0
        }
      }
    }

    const validateCore = (value: string): string | undefined => {
      const checked = checkCoreUrl(value.trim().replace(/\/+$/, ''), insecure)
      return checked.ok ? undefined : checked.error
    }
    let core = ctx.string('core')
    if (core === undefined || core === '') {
      if (!interactive) throw new UsageError('missing --core')
      core = await ask('Core URL', {
        validate: (v) => (v.trim() === '' ? 'required' : validateCore(v)),
        io,
      })
    }
    core = core.trim()
    const coreCheck = checkCoreUrl(core.replace(/\/+$/, ''), insecure)
    if (!coreCheck.ok) throw new CliError(coreCheck.error)

    let code = ctx.string('code')
    if (code === undefined || code === '') {
      if (!interactive) throw new UsageError('missing --code')
      out('Run `keith-core pair` on the core machine to get a pairing code.')
      code = await ask('Pairing code', {
        validate: (v) => (v.trim() === '' ? 'required' : undefined),
        io,
      })
    }
    code = code.trim()

    let name = ctx.string('name')
    if (name === undefined || name === '') {
      name = interactive
        ? (await ask('Node name', { default: defaultNodeName(), io })).trim()
        : defaultNodeName()
    }

    let allowShell = ctx.bool('allow-shell')
    if (!allowShell && interactive) {
      out(
        'Shell access lets the core run commands here; each command still needs the owner approval.',
      )
      allowShell = await confirm('Allow shell commands on this node?', { default: false, io })
    }

    let workdir = ctx.string('workdir')
    if (workdir === undefined || workdir === '') {
      workdir = interactive
        ? (await ask('Work folder', { default: defaultWorkdir(), io })).trim()
        : defaultWorkdir()
    }

    let config: Awaited<ReturnType<typeof joinNode>>
    try {
      config = await joinNode({
        core,
        code,
        name,
        allowShell,
        workdir,
        insecure,
        warn: (message) => io.stderr?.write(`${message}\n`),
        configPath,
      })
    } catch (error) {
      throw new CliError((error as Error).message)
    }
    out(
      `Joined ${config.core} as ${config.name} (${config.nodeId}). Config saved to ${configPath}.`,
    )
    const configArg = ctx.string('config') ? ` --config ${configPath}` : ''
    printNextSteps(io, [
      `keith-node run${configArg}`,
      'To keep it running, start `keith-node run` under a service manager (systemd, launchd).',
    ])
    return 0
  },
})
