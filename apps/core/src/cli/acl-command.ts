import { type Command, defineCommand, stripControl, UsageError } from '@keith/cli'
import { type AclView, parseMode } from '@keith/contracts'
import { type CliDeps, connectLocal } from './context.ts'
import { askFirst, yesFlag } from './prompt-helpers.ts'

const bitsText = (b: number): string =>
  `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${b & 1 ? 'x' : '-'}`

/** `r`, `rw`, `r-x`, `rwx` or a digit 1-7 to bits. */
export function parseBits(text: string): number | undefined {
  if (/^[1-7]$/.test(text)) return Number(text)
  if (!/^[r-][w-][x-]$/.test(text) && !/^(r?w?x?)$/.test(text)) return undefined
  const bits =
    (text.includes('r') ? 4 : 0) | (text.includes('w') ? 2 : 0) | (text.includes('x') ? 1 : 0)
  return bits === 0 ? undefined : bits
}

function arg(positionals: string[], index: number, what: string): string {
  const value = positionals[index]
  if (value === undefined) throw new UsageError(`missing ${what}`)
  return value
}

/** An `ls -l`-like view: mode, owner, team, then one line per entry. */
export function renderAcl(v: AclView): string {
  const lines = [
    `${v.modeText}  owner=${v.owner.label}  group=${v.group?.label ?? '-'}  ${v.kind} ${v.id}`,
  ]
  for (const e of v.entries) lines.push(`  ${e.effect.padEnd(5)} ${e.label} ${bitsText(e.bits)}`)
  return `${lines.join('\n')}\n`
}

/** `keith-core acl ...`: who may reach a resource (docs/specs/acl.md), as the owner, over the socket. */
export function aclCommand(deps: CliDeps): Command {
  const flags = {
    deny: { type: 'boolean', description: 'Work on the deny entry instead of the allow' },
  } as const
  return defineCommand({
    name: 'acl',
    summary: 'Resource access: show, share, unshare, chmod, chgrp, chown (as the owner)',
    subcommands: [
      defineCommand({
        name: 'show',
        summary:
          "Mode, owner, team and entries of a resource (looking at a member's resource is audited)",
        usage: '<kind> <id>',
        positionals: true,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.show({
            kind: arg(ctx.positionals, 0, 'kind'),
            id: arg(ctx.positionals, 1, 'id'),
          })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
      defineCommand({
        name: 'share',
        summary: 'Allow (or with --deny, deny) a user, a group, @users or @public some bits',
        usage: '<kind> <id> <user:name|group:name|@users|@public> <r|rw|rwx|1-7> [--deny]',
        positionals: true,
        flags,
        run: async (ctx) => {
          const bits = parseBits(arg(ctx.positionals, 3, 'bits (r, rw, rwx or 1-7)'))
          if (bits === undefined) throw new UsageError('bits are r, w, x combined, or a digit 1-7')
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.share({
            kind: arg(ctx.positionals, 0, 'kind'),
            id: arg(ctx.positionals, 1, 'id'),
            target: arg(ctx.positionals, 2, 'target'),
            bits,
            effect: ctx.bool('deny') ? 'deny' : 'allow',
          })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
      defineCommand({
        name: 'unshare',
        summary: 'Remove an entry (the allow, or with --deny the deny)',
        usage: '<kind> <id> <target> [--deny]',
        positionals: true,
        flags,
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.unshare({
            kind: arg(ctx.positionals, 0, 'kind'),
            id: arg(ctx.positionals, 1, 'id'),
            target: arg(ctx.positionals, 2, 'target'),
            effect: ctx.bool('deny') ? 'deny' : 'allow',
          })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
      defineCommand({
        name: 'chmod',
        summary: 'Set the nine bits: 640 or rw-r-----',
        usage: '<kind> <id> <mode>',
        positionals: true,
        run: async (ctx) => {
          const mode = parseMode(arg(ctx.positionals, 2, 'mode'))
          if (mode === undefined)
            throw new UsageError('a mode is three octal digits (640) or rw-r-----')
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.chmod({
            kind: arg(ctx.positionals, 0, 'kind'),
            id: arg(ctx.positionals, 1, 'id'),
            mode,
          })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
      defineCommand({
        name: 'chgrp',
        summary: 'Set the team (a group), or - to clear it',
        usage: '<kind> <id> <group|->',
        positionals: true,
        run: async (ctx) => {
          const group = arg(ctx.positionals, 2, 'group')
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.chgrp({
            kind: arg(ctx.positionals, 0, 'kind'),
            id: arg(ctx.positionals, 1, 'id'),
            group: group === '-' ? null : group,
          })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
      defineCommand({
        name: 'chown',
        summary: 'Hand a resource to another active person (owner only)',
        usage: '<kind> <id> <username> [--yes]',
        positionals: true,
        flags: yesFlag,
        run: async (ctx) => {
          const kind = arg(ctx.positionals, 0, 'kind')
          const id = arg(ctx.positionals, 1, 'id')
          const owner = arg(ctx.positionals, 2, 'username')
          await askFirst(
            ctx.io,
            'acl chown',
            `hand ${stripControl(kind)} ${stripControl(id)} to ${stripControl(owner)}? They become its owner, and you lose ownership of it.`,
            ctx.bool('yes'),
          )
          const { client } = await connectLocal(deps)
          const v = await client.rpc.acl.chown({ kind, id, owner })
          ctx.io.stdout.write(renderAcl(v))
          return 0
        },
      }),
    ],
  })
}
