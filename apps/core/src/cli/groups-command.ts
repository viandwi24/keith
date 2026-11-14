import { type Command, defineCommand, printTable, stripControl, UsageError } from '@keith/cli'
import type { GroupView } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'
import { askFirst, yesFlag } from './prompt-helpers.ts'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const names = (g: GroupView): string =>
  g.members
    .map((m) =>
      m.status === 'active'
        ? stripControl(m.username ?? m.id)
        : `${stripControl(m.username ?? m.id)}!`,
    )
    .join(', ')

function arg(positionals: string[], index: number, what: string): string {
  const value = positionals[index]
  if (value === undefined) throw new UsageError(`missing ${what}`)
  return value
}

/** `keith-core groups ...`: the groups people are shared with (docs/specs/acl.md), owner only, over the socket. */
export function groupsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'groups',
    summary: 'Groups of people for sharing: list, create, add and remove members, delete',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Every group with its members (a name marked ! is suspended or gone)',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const groups = await client.rpc.admin.groups.list()
          if (groups.length === 0)
            ctx.io.stdout.write('no groups yet; `keith-core groups create <name>`\n')
          else
            printTable(
              ctx.io,
              groups.map((g) => [
                g.name,
                String(g.members.length),
                String(g.usage),
                names(g),
                when(g.createdAt),
              ]),
              { header: ['NAME', 'MEMBERS', 'USED BY', 'PEOPLE', 'CREATED'] },
            )
          return 0
        },
      }),
      defineCommand({
        name: 'show',
        summary: 'One group: members, status, and how many resources use it',
        usage: '<group>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const g = await client.rpc.admin.groups.get({ group: arg(ctx.positionals, 0, 'group') })
          ctx.io.stdout.write(
            `${stripControl(g.name)} (id ${g.id}), used by ${g.usage} resource(s)\n`,
          )
          printTable(
            ctx.io,
            g.members.map((m) => [m.username ?? '-', m.name, m.status, m.id]),
            { header: ['USERNAME', 'NAME', 'STATUS', 'ID'] },
          )
          return 0
        },
      }),
      defineCommand({
        name: 'create',
        summary: 'Create a group (2-32 characters of a-z 0-9 . _ -)',
        usage: '<name>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const g = await client.rpc.admin.groups.create({
            name: arg(ctx.positionals, 0, 'group name').toLowerCase(),
          })
          ctx.io.stdout.write(`created ${stripControl(g.name)} (id ${g.id})\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'delete',
        summary: 'Delete a group; refused while a resource uses it (the count is printed)',
        usage: '<group> [--yes]',
        positionals: true,
        flags: yesFlag,
        run: async (ctx) => {
          const group = arg(ctx.positionals, 0, 'group')
          await askFirst(
            ctx.io,
            'groups delete',
            `delete group ${stripControl(group)}? A group that a resource still uses is refused.`,
            ctx.bool('yes'),
          )
          const { client } = await connectLocal(deps)
          await client.rpc.admin.groups.delete({ group })
          ctx.io.stdout.write(`${group}: deleted\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'add',
        summary: 'Add an active person to a group',
        usage: '<group> <username>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const g = await client.rpc.admin.groups.add({
            group: arg(ctx.positionals, 0, 'group'),
            person: arg(ctx.positionals, 1, 'username').toLowerCase(),
          })
          ctx.io.stdout.write(`${stripControl(g.name)}: ${names(g)}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'remove',
        summary: 'Take a person out of a group (effective at once, also for queued work)',
        usage: '<group> <username>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const g = await client.rpc.admin.groups.remove({
            group: arg(ctx.positionals, 0, 'group'),
            person: arg(ctx.positionals, 1, 'username').toLowerCase(),
          })
          ctx.io.stdout.write(`${stripControl(g.name)}: ${names(g) || 'no members'}\n`)
          return 0
        },
      }),
    ],
  })
}
