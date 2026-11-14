import { type Command, defineCommand, printTable, stripControl, UsageError } from '@keith/cli'
import type { PluginInfo, PluginToggle } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'
import { askFirst, yesFlag } from './prompt-helpers.ts'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** `enabled`, `disabled` or `failed`, with `(restart)` when the setting differs from what this process runs. */
export function stateText(p: Pick<PluginInfo, 'state' | 'nextBoot' | 'restartPending'>): string {
  return p.restartPending ? `${p.state} (${p.nextBoot} at next boot)` : p.state
}

function summary(done: PluginToggle, enabled: boolean): string {
  const p = done.plugin
  const verb = enabled ? 'enabled' : 'disabled'
  const head = done.changed ? `${p.id}: ${verb}` : `${p.id}: already ${verb} in the settings`
  return p.restartPending
    ? `${head}. This takes effect at the next boot of the core: restart keith-core.\n`
    : `${head}.\n`
}

/** `keith-core plugin ...`: the plugin layer for the operator (docs/specs/plugins.md), over the socket. */
export function pluginCommand(deps: CliDeps): Command {
  const idOf = (positionals: string[]): string => {
    const id = positionals[0]
    if (id === undefined) throw new UsageError('missing plugin id (see `keith-core plugin list`)')
    return id
  }
  const toggle = (enabled: boolean): Command =>
    defineCommand({
      name: enabled ? 'enable' : 'disable',
      summary: enabled
        ? 'Turn a plugin on (saved now, applied at the next boot)'
        : 'Turn a plugin off (saved now, applied at the next boot)',
      usage: '<id> [--yes]',
      positionals: true,
      flags: yesFlag,
      run: async (ctx) => {
        const id = idOf(ctx.positionals)
        await askFirst(
          ctx.io,
          enabled ? 'plugin enable' : 'plugin disable',
          enabled
            ? `enable plugin ${stripControl(id)}? It takes effect at the next boot.`
            : `disable plugin ${stripControl(id)}? It is off at the next boot.`,
          ctx.bool('yes'),
        )
        const { client } = await connectLocal(deps)
        const api = client.rpc.admin.plugins
        const done = enabled ? await api.enable({ id }) : await api.disable({ id })
        ctx.io.stdout.write(summary(done, enabled))
        return 0
      },
    })
  return defineCommand({
    name: 'plugin',
    summary:
      'The built-in plugins: list, show, enable, disable (owner only; changes apply at next boot)',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Every built-in plugin: status, version and reviews waiting',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const rows = await client.rpc.admin.plugins.list()
          printTable(
            ctx.io,
            rows.map((p) => [
              p.id,
              stateText(p),
              p.version,
              String(p.pendingReviews),
              p.title ?? '',
            ]),
            { header: ['ID', 'STATUS', 'VERSION', 'REVIEWS', 'TITLE'] },
          )
          return 0
        },
      }),
      defineCommand({
        name: 'show',
        summary: 'One plugin: status, capabilities, operations, timers, reviews waiting',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const p = await client.rpc.admin.plugins.show({ id: idOf(ctx.positionals) })
          const out = ctx.io.stdout
          out.write(`${p.id} ${p.version}${p.title === null ? '' : ` (${p.title})`}\n`)
          if (p.description !== null) out.write(`${p.description}\n`)
          out.write(`status: ${stateText(p)}\n`)
          if (p.reason !== null) out.write(`reason: ${p.reason}\n`)
          out.write(`reviews waiting: ${p.pendingReviews}\n`)
          if (p.schedules === null) out.write('timers: (not loaded)\n')
          else
            out.write(
              `timers: ${p.schedules.active} waiting${
                p.schedules.nextAt === null ? '' : `, next ${when(p.schedules.nextAt)} UTC`
              }\n`,
            )
          out.write('\ncapabilities:\n')
          if (p.capabilities.length === 0) out.write('  (none of its own)\n')
          for (const c of p.capabilities)
            out.write(
              `  ${c.id}  ${c.description}${c.roles.length === 0 ? '' : ` [default: ${c.roles.join(', ')}]`}\n`,
            )
          out.write('\noperations:\n')
          printTable(
            ctx.io,
            p.operations.map((o) => [
              o.name,
              o.capability,
              o.audience,
              o.risk,
              o.review ? 'review' : '',
              [o.ai ? 'ai' : '', o.http ? 'http' : ''].filter(Boolean).join(','),
            ]),
            { header: ['NAME', 'CAPABILITY', 'AUDIENCE', 'RISK', 'REVIEW', 'EXPOSED'] },
          )
          return 0
        },
      }),
      toggle(true),
      toggle(false),
    ],
  })
}
