import { CliError, defineCommand, printTable } from '@keith/cli'
import { probeSocket, socketPathFor } from '../modules/local-socket/index.ts'
import { type CliDeps, configOf, connectLocal } from './context.ts'
import { money } from './prompt-helpers.ts'

export function statusCommand(deps: CliDeps) {
  return defineCommand({
    name: 'status',
    summary: 'Is core up, where, which models, budget and nodes',
    run: async (ctx) => {
      const config = configOf(deps)
      const socketPath = socketPathFor(config.dataDir)
      if (!(await probeSocket(socketPath))) {
        ctx.io.stdout.write(`core: down (no answer on ${socketPath})\n`)
        return 1
      }
      const { client } = await connectLocal(deps)
      const [health, access, roles, budget, nodes] = await Promise.all([
        client.rpc.health.get(),
        client.rpc.admin.access.get(),
        client.rpc.models.roles.get(),
        client.rpc.budget.get(),
        client.rpc.nodes.list(),
      ]).catch((error: Error) => {
        throw new CliError(`core answered but a status call failed: ${error.message}`)
      })
      const online = nodes.filter((n) => n.status === 'online').length
      printTable(ctx.io, [
        ['core', `up (keith ${health.version}, ${health.sha})`],
        [
          'url',
          `http://${access.host.includes(':') ? `[${access.host}]` : access.host}:${access.port}`,
        ],
        ['socket', socketPath],
        ['public url', access.publicUrl ?? '(none)'],
        [
          'access',
          access.mode +
            (access.restartRequired ? ' (restart needed to apply the bind address)' : ''),
        ],
        ['front model', roles.front ?? '(not set)'],
        ['cortex model', roles.cortex ?? '(not set)'],
        [
          'budget',
          budget.limitUsd === null
            ? `${money(budget.spentUsd)} USD spent, no limit`
            : `${money(budget.spentUsd)} / ${money(budget.limitUsd)} USD this month`,
        ],
        ['nodes', `${online} online / ${nodes.length} total`],
      ])
      return 0
    },
  })
}
