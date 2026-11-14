import { type Command, defineCommand, printTable, UsageError } from '@keith/cli'
import { type CliDeps, connectLocal } from './context.ts'

const when = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** `keith-core sessions ...`: the live sessions of a person (docs/specs/auth.md, "Sessions"), over the socket. */
export function sessionsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'sessions',
    summary: 'Live sign-in sessions: list and end them',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'The live sessions of a person (the owner by default)',
        usage: '[<username>]',
        positionals: true,
        run: async (ctx) => {
          const person = ctx.positionals[0]
          const { client } = await connectLocal(deps)
          const sessions = await client.rpc.admin.sessions.list(
            person === undefined ? {} : { person },
          )
          printTable(
            ctx.io,
            sessions.map((s) => [
              s.id,
              s.methods.join('+'),
              s.label,
              when(s.createdAt),
              when(s.lastSeenAt),
              s.lastIp ?? '-',
              s.idleExpiresAt === null ? 'no limit' : `idle ${when(s.idleExpiresAt)}`,
            ]),
            { header: ['ID', 'METHODS', 'LABEL', 'CREATED', 'LAST SEEN', 'LAST IP', 'ENDS'] },
          )
          return 0
        },
      }),
      defineCommand({
        name: 'revoke',
        summary: 'End one session by id (that client falls back to the sign-in)',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing session id')
          const { client } = await connectLocal(deps)
          await client.rpc.admin.sessions.revoke({ id })
          ctx.io.stdout.write(`${id}: revoked\n`)
          return 0
        },
      }),
    ],
  })
}
