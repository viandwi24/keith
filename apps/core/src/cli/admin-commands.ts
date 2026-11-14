import {
  askHidden,
  CliError,
  type Command,
  type CommandContext,
  defineCommand,
  isInteractive,
  printTable,
  UsageError,
} from '@keith/cli'
import type { ModelRole } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'
import { budgetFlag, money } from './prompt-helpers.ts'

const PROVIDER_FLAGS = {
  id: {
    type: 'string',
    placeholder: 'id',
    description: 'Connection id (default: the provider id)',
  },
  label: { type: 'string', placeholder: 'text', description: 'Label' },
  'api-key-stdin': { type: 'boolean', description: 'Read the API key from stdin' },
} as const

export function accessCommand(deps: CliDeps) {
  return defineCommand({
    name: 'access',
    summary: 'Show or change who can reach core: local or remote',
    usage: '[local|remote] [--public-url <url>] [--bind <host>] [--proxy <none|tailscale-serve>]',
    positionals: true,
    flags: {
      'public-url': { type: 'string', placeholder: 'url', description: 'URL other devices use' },
      bind: { type: 'string', placeholder: 'host', description: 'Bind address' },
      proxy: {
        type: 'string',
        placeholder: 'none|tailscale-serve',
        description: 'What sits in front of core',
      },
    },
    examples: [
      'keith-core access remote --public-url https://mac.tailnet.ts.net --proxy tailscale-serve',
      'keith-core access local',
    ],
    run: async (ctx) => {
      const { client } = await connectLocal(deps)
      const proxy = ctx.string('proxy')
      if (proxy !== undefined && proxy !== 'none' && proxy !== 'tailscale-serve')
        throw new UsageError('--proxy takes none or tailscale-serve')
      // `--proxy` alone keeps the current mode
      const mode =
        ctx.positionals[0] ??
        (proxy === undefined ? undefined : (await client.rpc.admin.access.get()).mode)
      if (mode !== undefined) {
        if (mode !== 'local' && mode !== 'remote')
          throw new UsageError('access takes local or remote')
        const url = ctx.string('public-url')
        const bind = ctx.string('bind')
        const set = await client.rpc.admin.access.set({
          mode,
          ...(url === undefined
            ? mode === 'local'
              ? { publicUrl: null }
              : {}
            : { publicUrl: url }),
          ...(bind === undefined ? {} : { host: bind }),
          ...(proxy === undefined ? {} : { proxy }),
        })
        ctx.io.stdout.write(
          `access: ${set.mode}, bind ${set.host}, public url ${set.publicUrl ?? '(none)'}, proxy ${set.proxy}\n`,
        )
        if (set.restartRequired)
          ctx.io.stdout.write(
            'restart needed: the bind address changed (stop core, then keith-core start)\n',
          )
        return 0
      }
      const a = await client.rpc.admin.access.get()
      ctx.io.stdout.write(
        `access: ${a.mode}, bind ${a.host}:${a.port}, public url ${a.publicUrl ?? '(none)'}, proxy ${a.proxy}\n`,
      )
      return 0
    },
  })
}

async function readKey(ctx: CommandContext, label: string): Promise<string> {
  if (!ctx.bool('api-key-stdin') && !isInteractive(ctx.io))
    throw new UsageError('missing --api-key-stdin')
  return askHidden(`${label} API key`, {
    io: ctx.io,
    validate: (v) => (v === '' ? 'a value is needed' : undefined),
  })
}

export function providerCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'provider',
    summary: 'Model provider connections',
    subcommands: [
      defineCommand({
        name: 'add',
        summary: 'Add or update a connection (and test it)',
        usage: '<openrouter|openai|deepseek|id>',
        positionals: true,
        flags: PROVIDER_FLAGS,
        run: async (ctx) => {
          const providerId = ctx.positionals[0]
          if (providerId === undefined)
            throw new UsageError('missing provider (openrouter, openai or deepseek)')
          const { client } = await connectLocal(deps)
          const described = (await client.rpc.providers.describe()).find((d) => d.id === providerId)
          if (described === undefined) throw new UsageError(`unknown provider ${providerId}`)
          const needsKey = described.fields.some((f) => f.path === 'apiKey' && f.secret)
          const key = needsKey ? await readKey(ctx, described.label) : undefined
          const id = ctx.string('id')
          const label = ctx.string('label')
          const saved = await client.rpc.providers.put({
            providerId,
            ...(id === undefined ? {} : { id }),
            ...(label === undefined ? {} : { label }),
            ...(key === undefined ? {} : { settings: { apiKey: key } }),
          })
          const test = await client.rpc.providers.test({ id: saved.id })
          ctx.io.stdout.write(
            `${saved.id}: saved; ${test.ok ? 'connection works' : `connection test failed (${test.message ?? 'no answer'})`}\n`,
          )
          return test.ok ? 0 : 1
        },
      }),
      defineCommand({
        name: 'list',
        summary: 'List connections',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const rows = (await client.rpc.providers.list()).map((c) => [
            c.id,
            c.providerId,
            c.source,
            c.enabled ? 'enabled' : 'disabled',
          ])
          if (rows.length === 0) ctx.io.stdout.write('no connections: keith-core provider add\n')
          else printTable(ctx.io, rows, { header: ['ID', 'PROVIDER', 'SOURCE', 'STATE'] })
          return 0
        },
      }),
      defineCommand({
        name: 'remove',
        summary: 'Remove a connection',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing connection id')
          const { client } = await connectLocal(deps)
          await client.rpc.providers.remove({ id })
          ctx.io.stdout.write(`${id}: removed\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'test',
        summary: 'Test a connection',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing connection id')
          const { client } = await connectLocal(deps)
          const r = await client.rpc.providers.test({ id })
          ctx.io.stdout.write(
            `${id}: ${r.ok ? `ok${r.latencyMs === undefined ? '' : ` (${r.latencyMs} ms)`}` : `failed (${r.message ?? 'no answer'})`}\n`,
          )
          return r.ok ? 0 : 1
        },
      }),
    ],
  })
}

export function modelCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'model',
    summary: 'Models of the front agent and the cortex workers',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Show the current picks and the models of each connection',
        flags: {
          connection: { type: 'string', placeholder: 'id', description: 'Only this connection' },
          filter: {
            type: 'string',
            placeholder: 'text',
            description: 'Only ids containing this text',
          },
          limit: {
            type: 'string',
            placeholder: 'n',
            description: 'At most n per connection (default 40)',
          },
        },
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const roles = await client.rpc.models.roles.get()
          ctx.io.stdout.write(
            `front   ${roles.front ?? '(not set)'}\ncortex  ${roles.cortex ?? '(not set)'}\nguest   ${roles.guest ?? '(not set: guests stay off until a priced model is picked)'}\n`,
          )
          const only = ctx.string('connection')
          const filter = ctx.string('filter')?.toLowerCase()
          const limit = Number(ctx.string('limit') ?? 40)
          for (const c of (await client.rpc.providers.list()).filter(
            (c) => c.enabled && (only === undefined || c.id === only),
          )) {
            const models = (await client.rpc.providers.models({ id: c.id }).catch(() => [])).filter(
              (m) => filter === undefined || m.id.toLowerCase().includes(filter),
            )
            ctx.io.stdout.write(
              `\n${c.id} (${models.length} models${models.length > limit ? `, first ${limit}` : ''})\n`,
            )
            printTable(
              ctx.io,
              models.slice(0, limit).map((m) => [`  ${c.id}:${m.id}`, m.name]),
            )
          }
          return 0
        },
      }),
      defineCommand({
        name: 'set',
        summary: 'Pick the model of a role',
        usage: '<front|cortex|guest> <model> [--connection <id>]',
        positionals: true,
        flags: {
          connection: {
            type: 'string',
            placeholder: 'id',
            description: 'Connection of a bare model id',
          },
        },
        run: async (ctx) => {
          const [role, model] = ctx.positionals
          if (role !== 'front' && role !== 'cortex' && role !== 'guest')
            throw new UsageError('role must be front, cortex or guest')
          if (model === undefined) throw new UsageError('missing model id')
          const { client } = await connectLocal(deps)
          const connections = await client.rpc.providers.list()
          const given =
            ctx.string('connection') ?? connections.find((c) => model.startsWith(`${c.id}:`))?.id
          const connection = given ?? connections.find((c) => c.enabled)?.id
          if (connection === undefined) throw new CliError('no connection: keith-core provider add')
          const ref = model.startsWith(`${connection}:`) ? model : `${connection}:${model}`
          const roles = await client.rpc.models.roles.set({ role: role as ModelRole, ref })
          ctx.io.stdout.write(`${role}: ${roles[role] ?? ''}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'price',
        summary: 'Set or clear a manual price of a model (USD per million tokens)',
        subcommands: [
          defineCommand({
            name: 'set',
            summary: 'Price a model by hand: its spend is then counted and guests may use it',
            usage: '<connection:model> --in <usd> --out <usd>',
            positionals: true,
            flags: {
              in: {
                type: 'string',
                placeholder: 'usd',
                description: 'Input, USD per million tokens',
              },
              out: {
                type: 'string',
                placeholder: 'usd',
                description: 'Output, USD per million tokens',
              },
            },
            run: async (ctx) => {
              const [ref] = ctx.positionals
              if (ref === undefined) throw new UsageError('missing model ref (connection:model)')
              const input = priceFlag(ctx.string('in'), '--in')
              const output = priceFlag(ctx.string('out'), '--out')
              const { client } = await connectLocal(deps)
              const saved = await client.rpc.models.price.set({
                ref,
                inputPerMTokUsd: input,
                outputPerMTokUsd: output,
              })
              ctx.io.stdout.write(
                `${saved.ref}: in ${money(saved.inputPerMTokUsd)}, out ${money(saved.outputPerMTokUsd)} USD per million tokens (manual)\n`,
              )
              return 0
            },
          }),
          defineCommand({
            name: 'clear',
            summary: 'Remove the manual price of a model (the catalog price applies again)',
            usage: '<connection:model>',
            positionals: true,
            run: async (ctx) => {
              const [ref] = ctx.positionals
              if (ref === undefined) throw new UsageError('missing model ref (connection:model)')
              const { client } = await connectLocal(deps)
              await client.rpc.models.price.clear({ ref })
              ctx.io.stdout.write(`${ref}: manual price removed\n`)
              return 0
            },
          }),
        ],
      }),
    ],
  })
}

/** A price flag: a plain decimal number of USD per million tokens (0 to 10000). */
function priceFlag(text: string | undefined, flag: string): number {
  if (text === undefined || !/^\d+(\.\d+)?$/.test(text.trim()))
    throw new UsageError(`${flag} must be a price in USD per million tokens (a plain number)`)
  const n = Number(text.trim())
  if (n > 10_000) throw new UsageError(`${flag} must be at most 10000`)
  return n
}

export function budgetCommand(deps: CliDeps): Command {
  const show = (
    ctx: CommandContext,
    s: {
      limitUsd: number | null
      spentUsd: number
      remainingUsd: number | null
      unpriced?: string[]
      people?:
        | Array<{
            username: string | null
            name: string
            limitUsd: number | null
            spentUsd: number
            remainingUsd: number | null
          }>
        | undefined
    },
  ) => {
    ctx.io.stdout.write(
      `budget: ${money(s.spentUsd)} spent, ${s.limitUsd === null ? 'no limit' : `limit ${money(s.limitUsd)} USD, ${money(s.remainingUsd ?? 0)} left`} this month\n`,
    )
    for (const ref of s.unpriced ?? []) {
      ctx.io.stdout.write(
        `  no price for ${ref}: its spend is not counted (keith-core model price set)\n`,
      )
    }
    for (const p of s.people ?? []) {
      const cap =
        p.limitUsd === null
          ? 'no cap'
          : `cap ${money(p.limitUsd)} USD, ${money(p.remainingUsd ?? 0)} left`
      ctx.io.stdout.write(`  ${p.username ?? p.name}: ${money(p.spentUsd)} spent, ${cap}\n`)
    }
  }
  return defineCommand({
    name: 'budget',
    summary: 'Monthly spending limit and per-person caps',
    subcommands: [
      defineCommand({
        name: 'show',
        summary: 'Spent and remaining this month, per person',
        run: async (ctx) => {
          show(ctx, await (await connectLocal(deps)).client.rpc.budget.get())
          return 0
        },
      }),
      defineCommand({
        name: 'set',
        summary: 'Set the global monthly limit in USD, or none',
        usage: '<usd|none>',
        positionals: true,
        run: async (ctx) => {
          const value = ctx.positionals[0]
          if (value === undefined) throw new UsageError('missing amount (a number of USD, or none)')
          const limitUsd = budgetFlag(value)
          show(ctx, await (await connectLocal(deps)).client.rpc.budget.set({ limitUsd }))
          return 0
        },
      }),
      defineCommand({
        name: 'cap',
        summary: "Set one person's monthly cap in USD, or none",
        usage: '<username> <usd|none>',
        positionals: true,
        run: async (ctx) => {
          const [person, value] = ctx.positionals
          if (person === undefined || value === undefined)
            throw new UsageError('usage: budget cap <username> <usd|none>')
          const usd = budgetFlag(value)
          const row = await (await connectLocal(deps)).client.rpc.budget.setPersonCap({
            person,
            usd,
          })
          ctx.io.stdout.write(
            `${row.username ?? row.name}: ${row.limitUsd === null ? 'no cap' : `cap ${money(row.limitUsd)} USD`}, ${money(row.spentUsd)} spent this month\n`,
          )
          return 0
        },
      }),
    ],
  })
}
