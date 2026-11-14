// `keith-core presence <username>`: the raw presence of one person for the owner (docs/specs/parietal.md, "Settings,
// audit, errors"). The owner reads the record as it is; the read is audited as `presence.read`. The front agent never
// quotes it: the disclosure rule (P27.4.1) decides what a model may say.
import { type Command, defineCommand, printTable, UsageError } from '@keith/cli'
import type { PresenceRaw } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** The summary lines of the raw record: the state, the manual status, the reachable and the active client. */
export function presenceLines(raw: PresenceRaw, person: string): string[] {
  const { presence, status } = raw
  const lines = [
    `${person}: ${presence.state}${presence.note === null ? '' : ` (${presence.note})`}`,
  ]
  if (status.busy)
    lines.push(
      `status: busy until ${status.until === null ? 'further notice' : when(status.until)}${status.note === null ? '' : `, ${status.note}`}`,
    )
  lines.push(`active client: ${presence.activeClient ?? 'none'}`)
  lines.push(`online clients: ${presence.reachableOn.length}`)
  return lines
}

export function presenceCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'presence',
    summary: "A person's presence as it is computed now (the raw record, owner only; audited)",
    usage: '<username>',
    positionals: true,
    run: async (ctx) => {
      const person = ctx.positionals[0]
      if (person === undefined)
        throw new UsageError('missing username (keith-core presence <username>)')
      const { client } = await connectLocal(deps)
      const raw = await client.rpc.admin.presence.read({ person })
      for (const line of presenceLines(raw, person)) ctx.io.stdout.write(`${line}\n`)
      if (raw.clients.length === 0) {
        ctx.io.stdout.write('no client is registered\n')
        return 0
      }
      printTable(
        ctx.io,
        raw.clients.map((c) => [
          c.id,
          c.kind,
          c.label,
          c.online ? 'online' : 'offline',
          when(c.lastSeenAt),
          c.lastActiveAt === null ? 'never' : when(c.lastActiveAt),
        ]),
        { header: ['ID', 'KIND', 'LABEL', 'STATE', 'LAST SEEN', 'LAST ACTIVE'] },
      )
      return 0
    },
  })
}
