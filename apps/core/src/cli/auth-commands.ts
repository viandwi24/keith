import { type Command, defineCommand, printTable, stripControl, UsageError } from '@keith/cli'
import { withOfflineAdmin } from '../modules/admin/index.ts'
import { recoverOwner } from '../modules/auth/index.ts'
import { type CliDeps, configOf, connectLocal, requireOffline } from './context.ts'

const when = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** `3m`, `2h`, `4d`: how long ago, for a table. */
function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 129_600) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

export function devicesCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'devices',
    summary: 'Devices that log in with a code (`keith login`)',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'Login requests that wait, and the devices that are logged in',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const { pending, devices } = await client.rpc.admin.devices.list()
          ctx.io.stdout.write('waiting for approval\n')
          if (pending.length === 0) ctx.io.stdout.write('  none\n')
          else
            printTable(
              ctx.io,
              pending.map((p) => [`  ${p.label}`, p.ip, `${age(p.createdAt)} ago`]),
              { header: ['  LABEL', 'FROM', 'ASKED'] },
            )
          ctx.io.stdout.write('devices\n')
          if (devices.length === 0) ctx.io.stdout.write('  none\n')
          else
            printTable(
              ctx.io,
              devices.map((d) => [
                `  ${d.id}`,
                d.label,
                when(d.createdAt),
                when(d.lastSeenAt),
                d.lastIp ?? '-',
                d.revokedAt === null ? 'live' : `revoked ${when(d.revokedAt)}`,
              ]),
              { header: ['  ID', 'LABEL', 'CREATED', 'LAST SEEN', 'LAST IP', 'STATE'] },
            )
          return 0
        },
      }),
      defineCommand({
        name: 'approve',
        summary: 'Approve the login that shows this code',
        usage: '<code> [--label <text>]',
        positionals: true,
        flags: {
          label: { type: 'string', placeholder: 'text', description: 'Name of the device' },
        },
        run: async (ctx) => {
          const code = ctx.positionals[0]
          if (code === undefined) throw new UsageError('missing code (e.g. ABCD-EFGH)')
          const label = ctx.string('label')
          const { client } = await connectLocal(deps)
          const done = await client.rpc.admin.devices.approve({
            code,
            ...(label === undefined ? {} : { label }),
          })
          ctx.io.stdout.write(`approved: ${stripControl(done.label)} (${done.credentialId})\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'deny',
        summary: 'Refuse the login that shows this code',
        usage: '<code>',
        positionals: true,
        run: async (ctx) => {
          const code = ctx.positionals[0]
          if (code === undefined) throw new UsageError('missing code')
          await (await connectLocal(deps)).client.rpc.admin.devices.deny({ code })
          ctx.io.stdout.write('denied\n')
          return 0
        },
      }),
      defineCommand({
        name: 'revoke',
        summary: 'Log a device out (by id, see `devices list`)',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing device id')
          await (await connectLocal(deps)).client.rpc.admin.devices.revoke({ id })
          ctx.io.stdout.write(`${id}: revoked\n`)
          return 0
        },
      }),
    ],
  })
}

export function tokenCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'token',
    summary: 'Long-lived tokens for scripts (`keith login --token`)',
    subcommands: [
      defineCommand({
        name: 'create',
        summary: 'Create a token (shown once)',
        flags: {
          label: { type: 'string', placeholder: 'text', description: 'What the token is for' },
        },
        run: async (ctx) => {
          const label = ctx.require('label')
          const { client } = await connectLocal(deps)
          const created = await client.rpc.admin.tokens.create({ label })
          ctx.io.stdout.write(`token ${created.id} (${label}), shown once:\n${created.token}\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'list',
        summary: 'List tokens (older keith_ tokens show as legacy)',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          const rows = (await client.rpc.admin.tokens.list()).map((t) => [
            t.id,
            t.label,
            t.legacy ? 'legacy' : 'token',
            when(t.createdAt),
            when(t.lastSeenAt),
            t.revokedAt === null ? 'live' : `revoked ${when(t.revokedAt)}`,
          ])
          if (rows.length === 0)
            ctx.io.stdout.write('no tokens: keith-core token create --label <text>\n')
          else
            printTable(ctx.io, rows, {
              header: ['ID', 'LABEL', 'KIND', 'CREATED', 'LAST SEEN', 'STATE'],
            })
          return 0
        },
      }),
      defineCommand({
        name: 'revoke',
        summary: 'Revoke a token (legacy ones too)',
        usage: '<id>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing token id')
          await (await connectLocal(deps)).client.rpc.admin.tokens.revoke({ id })
          ctx.io.stdout.write(`${id}: revoked\n`)
          return 0
        },
      }),
      defineCommand({
        name: 'recover',
        summary:
          'Revoke every credential and token of the owner and print a new token (core must be stopped)',
        run: async (ctx) => {
          const config = configOf(deps)
          await requireOffline(config, 'token recover')
          const made = await withOfflineAdmin(
            config,
            { migrate: false, ...deps.offline },
            async (admin) => {
              const result = await recoverOwner(admin.tokens, admin.credentials)
              admin.audit.add({
                kind: 'token.recover',
                actor: 'system',
                via: 'offline',
                detail: { revoked: result.revoked, credentialId: result.id },
              })
              return result
            },
          )
          ctx.io.stdout.write(
            `new owner token (${made.revoked} old credentials and tokens revoked), shown once:\n${made.token}\n`,
          )
          return 0
        },
      }),
    ],
  })
}

export function auditCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'audit',
    summary:
      'The security log, newest first; `audit mine <person>` shows one person their lines; `audit retention` shows or sets how long it is kept',
    subcommands: [
      defineCommand({
        name: 'mine',
        summary:
          'The lines about a person: who looked at or changed something of theirs (the owner can show a member their lines)',
        usage: '[<person>] [--limit <n>]',
        positionals: true,
        flags: {
          limit: { type: 'string', placeholder: 'n', description: 'How many (default 50)' },
        },
        run: async (ctx) => {
          const raw = ctx.string('limit')
          const limit = raw === undefined ? 50 : Number(raw)
          if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new UsageError('--limit takes a number from 1 to 200')
          const [person] = ctx.positionals
          const { client } = await connectLocal(deps)
          const lines = await client.audit.mine({
            limit,
            ...(person === undefined ? {} : { person }),
          })
          if (lines.length === 0)
            ctx.io.stdout.write('nobody looked at their things: nothing recorded\n')
          else
            printTable(
              ctx.io,
              lines.map((l) => [
                new Date(l.at).toISOString().slice(0, 19).replace('T', ' '),
                l.actorName,
                l.summary,
              ]),
              { header: ['AT (UTC)', 'WHO', 'WHAT'] },
            )
          return 0
        },
      }),
      defineCommand({
        name: 'retention',
        summary: 'How many days of the audit log are kept (default 180; 0 keeps everything)',
        usage: '[show | set <days>]',
        positionals: true,
        run: async (ctx) => {
          const [verb, raw] = ctx.positionals
          if (verb !== undefined && verb !== 'show' && verb !== 'set')
            throw new UsageError('use `audit retention show` or `audit retention set <days>`')
          const { client } = await connectLocal(deps)
          if (verb === 'set') {
            const days = Number(raw)
            if (raw === undefined || !Number.isInteger(days) || days < 0 || days > 3650)
              throw new UsageError('give a whole number of days, 0 to 3650 (0 keeps everything)')
            const done = await client.rpc.admin.audit.retention.set({ days })
            ctx.io.stdout.write(
              done.days === 0
                ? 'audit retention: keep everything (0 days: nothing is ever pruned)\n'
                : `audit retention: ${done.days} days (older rows are deleted at boot and every 10 minutes)\n`,
            )
            return 0
          }
          const now = await client.rpc.admin.audit.retention.get()
          ctx.io.stdout.write(
            `audit retention: ${now.days === 0 ? 'keep everything' : `${now.days} days`} (default ${now.defaultDays}, max ${now.maxDays}, 0 keeps everything)\n`,
          )
          return 0
        },
      }),
    ],
    flags: { limit: { type: 'string', placeholder: 'n', description: 'How many (default 50)' } },
    run: async (ctx) => {
      const raw = ctx.string('limit')
      const limit = raw === undefined ? 50 : Number(raw)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new UsageError('--limit takes a number from 1 to 500')
      const { client } = await connectLocal(deps)
      const events = await client.rpc.admin.audit.list({ limit })
      if (events.length === 0) ctx.io.stdout.write('nothing recorded yet\n')
      else
        printTable(
          ctx.io,
          events.map((e) => [
            new Date(e.at).toISOString().slice(0, 19).replace('T', ' '),
            e.kind,
            e.actor,
            e.via,
            JSON.stringify(e.detail),
          ]),
          { header: ['AT (UTC)', 'KIND', 'ACTOR', 'VIA', 'DETAIL'] },
        )
      return 0
    },
  })
}
