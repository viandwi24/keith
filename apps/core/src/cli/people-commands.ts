import { chmodSync, copyFileSync, unlinkSync } from 'node:fs'
import {
  ask,
  askHidden,
  CliError,
  type Command,
  type CommandContext,
  confirm,
  defineCommand,
  isInteractive,
  printTable,
  stripControl,
  UsageError,
} from '@keith/cli'
import type { Person } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

/** The keep time of a removed person's data (ADR-0027 §26); the core's default `REMOVED_KEEP_MS`. */
const REMOVED_KEEP_DAYS = 30

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const label = (p: Person): string => stripControl(p.username ?? p.id)

function oneArg(positionals: string[], what: string): string {
  const value = positionals[0]
  if (value === undefined) throw new UsageError(`missing ${what}`)
  return value
}

/**
 * A capability id from argv. The core checks it against the live registry (the core ids plus those of loaded
 * plugins), so the CLI keeps no list of its own: `keith-core plugin show <id>` names a plugin's ids.
 */
function capabilityArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.trim() === '') throw new UsageError('missing capability')
  return value.trim()
}

/**
 * A secret from stdin (`--<flag>-stdin`, one line) or asked twice with hidden input. Without a
 * terminal and without the flag it refuses: a secret never comes from argv.
 */
async function readSecret(ctx: CommandContext, what: string, flag: string): Promise<string> {
  const fromStdin = ctx.bool(flag)
  if (!fromStdin && !isInteractive(ctx.io)) throw new UsageError(`missing --${flag}`)
  const first = await askHidden(`New ${what}`, { io: ctx.io })
  if (fromStdin) return first
  const again = await askHidden(`Repeat the ${what}`, { io: ctx.io })
  if (again !== first) throw new CliError(`the two ${what}s differ: nothing was changed`)
  return first
}

/** `keith-core people ...`: manage who can use Keith (docs/specs/people.md), over the socket. */
export function peopleCommand(deps: CliDeps): Command {
  const byName = (name: string, summary: string, run: NonNullable<Command['run']>) =>
    defineCommand({ name, summary, usage: '<username>', positionals: true, run })
  const yes = {
    yes: { type: 'boolean', description: 'Do not ask first (for scripts)' },
  } as const
  const byNameAsk = (name: string, summary: string, run: NonNullable<Command['run']>) =>
    defineCommand({
      name,
      summary,
      usage: '<username> [--yes]',
      positionals: true,
      flags: yes,
      run,
    })
  return defineCommand({
    name: 'people',
    summary: 'The people who use Keith: add, rename, suspend, remove, passwords, grants, ownership',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Everyone, newest change first',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const people = await client.rpc.admin.people.list()
          printTable(
            ctx.io,
            people.map((p) => [
              p.username ?? '-',
              p.name,
              p.role,
              p.status,
              when(p.createdAt),
              p.id,
            ]),
            { header: ['USERNAME', 'NAME', 'ROLE', 'STATUS', 'ADDED', 'ID'] },
          )
          return 0
        },
      }),
      defineCommand({
        name: 'add',
        summary: 'Add a person (a member by default)',
        usage: '<username> [--name <text>] [--role member]',
        positionals: true,
        flags: {
          name: {
            type: 'string',
            placeholder: 'text',
            description: 'Display name (default: the username)',
          },
          role: {
            type: 'string',
            placeholder: 'role',
            description: 'member (the owner changes by transfer-owner)',
          },
        },
        run: async (ctx) => {
          const username = oneArg(ctx.positionals, 'username').toLowerCase()
          const name = ctx.string('name')
          const role = ctx.string('role')
          if (role !== undefined && role !== 'owner' && role !== 'member')
            throw new UsageError('--role takes owner or member')
          const { client } = await connectLocal(deps)
          const person = await client.rpc.admin.people.add({
            username,
            ...(name === undefined ? {} : { name }),
            ...(role === undefined ? {} : { role }),
          })
          ctx.io.stdout.write(`added ${label(person)} (${person.role}, id ${person.id})\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'rename',
        summary: 'Change a username and/or display name',
        usage: '<username> [<new-username>] [--name <text>]',
        positionals: true,
        flags: { name: { type: 'string', placeholder: 'text', description: 'New display name' } },
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const next = ctx.positionals[1]?.toLowerCase()
          const name = ctx.string('name')
          if (next === undefined && name === undefined)
            throw new UsageError('give a new username, --name <text>, or both')
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.people.rename({
            person,
            ...(next === undefined ? {} : { username: next }),
            ...(name === undefined ? {} : { name }),
          })
          ctx.io.stdout.write(`${label(done)}: ${stripControl(done.name)}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'role',
        summary: 'Set a role (owner or member; the owner moves by transfer-owner)',
        usage: '<username> <role>',
        positionals: true,
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const role = ctx.positionals[1]
          if (role !== 'owner' && role !== 'member') throw new UsageError('role is owner or member')
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.people.setRole({ person, role })
          ctx.io.stdout.write(`${label(done)}: ${done.role}\n`)
          return 0
        },
      }),
      byName(
        'suspend',
        'Deny access until reactivated (credentials stay, they just fail)',
        async (ctx) => {
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.people.suspend({
            person: oneArg(ctx.positionals, 'username'),
          })
          ctx.io.stdout.write(`${label(done)}: ${done.status}\n`)
          return 0
        },
      ),
      byName('reactivate', 'Let a suspended person in again', async (ctx) => {
        const { client } = await connectLocal(deps)
        const done = await client.rpc.admin.people.reactivate({
          person: oneArg(ctx.positionals, 'username'),
        })
        ctx.io.stdout.write(`${label(done)}: ${done.status}\n`)
        return 0
      }),
      byNameAsk(
        'remove',
        'Remove a person and revoke their credentials; their data is kept 30 days (the audit log stays)',
        async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          if (!ctx.bool('yes')) {
            if (!isInteractive(ctx.io))
              throw new UsageError('remove asks first: run it in a terminal or pass --yes')
            if (
              !(await confirm(
                `remove ${stripControl(person)} and keep their data for ${REMOVED_KEEP_DAYS} days?`,
                { default: false, io: ctx.io },
              ))
            )
              throw new CliError('nothing was removed')
          }
          const { client } = await connectLocal(deps)
          const removed = await client.rpc.admin.people.remove({ person })
          if (removed.keptUntil === null) ctx.io.stdout.write(`${person}: removed\n`)
          else
            ctx.io.stdout.write(
              `${person}: removed; data kept in workspace/keith/removed/${removed.id} until ${new Date(removed.keptUntil).toISOString().slice(0, 10)}; run people export first for an archive\n`,
            )
          return 0
        },
      ),
      defineCommand({
        name: 'export',
        summary: "Write an archive of a person's memory, workspace and conversations (owner only)",
        usage: '<username> [--out <file>] | --removed <personId> [--out <file>]',
        positionals: true,
        flags: {
          out: {
            type: 'string',
            placeholder: 'file',
            description: 'Also copy the archive to this file (mode 0600)',
          },
          removed: {
            type: 'string',
            placeholder: 'personId',
            description:
              'A removed person whose data is still kept (the id `people remove` printed)',
          },
        },
        run: async (ctx) => {
          const removed = ctx.string('removed')
          if (removed !== undefined && ctx.positionals.length > 0)
            throw new UsageError('name a username, or --removed <personId>, not both')
          const username =
            removed === undefined ? oneArg(ctx.positionals, 'username').toLowerCase() : undefined
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.people.export({
            ...(username === undefined ? {} : { person: username }),
            ...(removed === undefined ? {} : { removed }),
          })
          let path = done.path
          const out = ctx.string('out')
          if (out !== undefined) {
            copyFileSync(done.path, out)
            chmodSync(out, 0o600)
            unlinkSync(done.path)
            path = out
          }
          ctx.io.stdout.write(`exported ${done.personId} (${done.files} entries) to ${path}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'login',
        summary: 'Turn a member sign-in on or off (owner only); off ends their sessions',
        usage: '<username> on|off',
        positionals: true,
        run: async (ctx) => {
          const username = oneArg(ctx.positionals, 'username').toLowerCase()
          const state = ctx.positionals[1]
          if (state !== 'on' && state !== 'off')
            throw new UsageError('usage: login <username> on|off')
          const { client } = await connectLocal(deps)
          const person = await client.rpc.admin.people.setLogin({
            person: username,
            canLogin: state === 'on',
          })
          ctx.io.stdout.write(`${label(person)}: sign-in ${state}\n`)
          return 0
        },
      }),
      byNameAsk(
        'transfer-owner',
        'Make this person the owner; the current owner becomes a member',
        async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          if (!ctx.bool('yes')) {
            if (!isInteractive(ctx.io))
              throw new UsageError('transfer-owner asks first: run it in a terminal or pass --yes')
            const typed = await ask(`Type ${stripControl(person)} to make them the owner`, {
              io: ctx.io,
            })
            if (typed.toLowerCase() !== person.toLowerCase())
              throw new CliError('that is not the same username; ownership did not move')
          }
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.people.transferOwner({ person })
          ctx.io.stdout.write(
            `${label(done.owner)} is now the owner; ${label(done.previousOwner)} is a member\n`,
          )
          return 0
        },
      ),
      defineCommand({
        name: 'passwd',
        summary: 'Set a password (15-256 characters); the person is signed out everywhere',
        usage: '<username> [--password-stdin]',
        positionals: true,
        flags: {
          'password-stdin': { type: 'boolean', description: 'Read the password from stdin' },
        },
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const password = await readSecret(ctx, 'password', 'password-stdin')
          const { client } = await connectLocal(deps)
          await client.rpc.admin.people.setPassword({ person, password })
          ctx.io.stdout.write(`${person}: password set (their sessions were revoked)\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'pin',
        summary: 'Set a PIN (6-12 digits): signs in on the same network and confirms step-up',
        usage: '<username> [--pin-stdin]',
        positionals: true,
        flags: { 'pin-stdin': { type: 'boolean', description: 'Read the PIN from stdin' } },
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const pin = await readSecret(ctx, 'PIN', 'pin-stdin')
          const { client } = await connectLocal(deps)
          await client.rpc.admin.people.setPin({ person, pin })
          ctx.io.stdout.write(`${person}: PIN set\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'grant',
        summary: 'Give a person one more capability on top of their role (or list them)',
        usage: '<username> [<capability>]',
        positionals: true,
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const capability = capabilityArg(ctx.positionals[1])
          const { client } = await connectLocal(deps)
          const grants =
            capability === undefined
              ? await client.rpc.admin.people.grants({ person })
              : await client.rpc.admin.people.grant({ person, capability })
          ctx.io.stdout.write(
            `${person}: ${grants.length === 0 ? '(no grants)' : grants.join(', ')}\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'revoke-grant',
        summary: 'Take a granted capability back',
        usage: '<username> <capability>',
        positionals: true,
        run: async (ctx) => {
          const person = oneArg(ctx.positionals, 'username')
          const capability = capabilityArg(ctx.positionals[1])
          if (capability === undefined) throw new UsageError('missing capability')
          const { client } = await connectLocal(deps)
          const grants = await client.rpc.admin.people.revokeGrant({ person, capability })
          ctx.io.stdout.write(
            `${person}: ${grants.length === 0 ? '(no grants)' : grants.join(', ')}\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'alias',
        summary:
          'Email and phone aliases a person may sign in with (set by the owner, never verified)',
        usage: 'add <username> <email|phone> | remove <email|phone> | list <username>',
        positionals: true,
        run: async (ctx) => {
          const [action, first, second] = ctx.positionals
          const { client } = await connectLocal(deps)
          if (action === 'add') {
            if (first === undefined || second === undefined)
              throw new UsageError('usage: alias add <username> <email|phone>')
            const kind = second.includes('@') ? 'email' : 'phone'
            const done = await client.rpc.admin.people.alias.add({
              person: first,
              kind,
              value: second,
            })
            ctx.io.stdout.write(`${first}: ${done.kind} ${done.value} added\n`)
            return 0
          }
          if (action === 'remove') {
            if (first === undefined) throw new UsageError('usage: alias remove <email|phone>')
            await client.rpc.admin.people.alias.remove({ value: first })
            ctx.io.stdout.write('alias removed\n')
            return 0
          }
          if (action === 'list') {
            if (first === undefined) throw new UsageError('usage: alias list <username>')
            const aliases = await client.rpc.admin.people.alias.list({ person: first })
            printTable(
              ctx.io,
              aliases.map((a) => [a.kind, a.value, when(a.createdAt)]),
              { header: ['KIND', 'VALUE', 'ADDED'] },
            )
            return 0
          }
          throw new UsageError('alias takes add, remove or list')
        },
      }),
      byName('unlock', 'Clear a lock and the failed-login counters of a person', async (ctx) => {
        const person = oneArg(ctx.positionals, 'username')
        const { client } = await connectLocal(deps)
        const done = await client.rpc.admin.people.unlock({ person })
        ctx.io.stdout.write(`${person}: ${done.wasLocked ? 'unlocked' : 'was not locked'}\n`)
        return 0
      }),
      byName('clear-password', 'Remove a password (sessions are revoked)', async (ctx) => {
        const person = oneArg(ctx.positionals, 'username')
        const { client } = await connectLocal(deps)
        await client.rpc.admin.people.clearSecret({ person, kind: 'password' })
        ctx.io.stdout.write(`${person}: password cleared\n`)
        return 0
      }),
      byName('clear-pin', 'Remove a PIN', async (ctx) => {
        const person = oneArg(ctx.positionals, 'username')
        const { client } = await connectLocal(deps)
        await client.rpc.admin.people.clearSecret({ person, kind: 'pin' })
        ctx.io.stdout.write(`${person}: PIN cleared\n`)
        return 0
      }),
    ],
  })
}
