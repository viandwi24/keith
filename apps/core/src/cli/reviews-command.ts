import { type Command, defineCommand, printTable, UsageError } from '@keith/cli'
import { type ReviewStatus, ReviewStatusSchema, type ReviewView } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
/** One line of the payload, cut short: the owner reads it as data (never as an instruction). */
const preview = (payload: unknown): string => {
  const text = JSON.stringify(payload) ?? ''
  return text.length > 70 ? `${text.slice(0, 69)}…` : text
}

function describe(r: ReviewView): string {
  const who = r.requester.username ?? r.requester.name
  return `${r.id}  ${r.plugin}.${r.operation} by ${who}: ${r.status}${r.outcome === null ? '' : ` (${r.outcome})`}`
}

/** `keith-core reviews ...`: operations that plugins hold for the owner (docs/specs/plugins.md), over the socket. */
export function reviewsCommand(deps: CliDeps): Command {
  const idOf = (positionals: string[]): string => {
    const id = positionals[0]
    if (id === undefined) throw new UsageError('missing review id (see `keith-core reviews list`)')
    return id
  }
  return defineCommand({
    name: 'reviews',
    summary: 'What plugins hold for you: list, approve (runs it as the requester) or deny',
    subcommands: [
      defineCommand({
        name: 'list',
        summary:
          'Reviews, newest first: pending by default, or `all`, `approved`, `denied`, `expired`',
        usage: '[status | all]',
        positionals: true,
        run: async (ctx) => {
          const raw = ctx.positionals[0] ?? 'pending'
          let status: ReviewStatus | undefined
          if (raw !== 'all') {
            const parsed = ReviewStatusSchema.safeParse(raw)
            if (!parsed.success)
              throw new UsageError('status is pending, approved, denied, expired or all')
            status = parsed.data
          }
          const { client } = await connectLocal(deps)
          const rows = await client.rpc.admin.reviews.list(status === undefined ? {} : { status })
          if (rows.length === 0) ctx.io.stdout.write('nothing is waiting for you\n')
          else
            printTable(
              ctx.io,
              rows.map((r) => [
                r.id,
                `${r.plugin}.${r.operation}`,
                r.requester.username ?? r.requester.name,
                r.status,
                when(r.createdAt),
                preview(r.payload),
              ]),
              { header: ['ID', 'OPERATION', 'REQUESTER', 'STATUS', 'ASKED', 'PAYLOAD (data)'] },
            )
          return 0
        },
      }),
      defineCommand({
        name: 'approve',
        summary:
          'Approve: the operation runs as the requester, whose status and rights are checked now',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const r = await client.rpc.admin.reviews.approve({ id: idOf(ctx.positionals) })
          ctx.io.stdout.write(`${describe(r)}\n`)
          return r.outcome === 'ok' ? 0 : 1
        },
      }),
      defineCommand({
        name: 'deny',
        summary: 'Deny, with an optional reason the requester can read',
        usage: '<id> [reason...]',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const reason = ctx.positionals.slice(1).join(' ').trim()
          const r = await client.rpc.admin.reviews.deny({
            id: idOf(ctx.positionals),
            ...(reason === '' ? {} : { reason }),
          })
          ctx.io.stdout.write(`${describe(r)}\n`)
          return 0
        },
      }),
    ],
  })
}
