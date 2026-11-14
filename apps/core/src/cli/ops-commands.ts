import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type CliIo, type Command, defineCommand, printTable, UsageError } from '@keith/cli'
import { NODE_CALL_LIMIT_DEFAULT, NODE_CALL_LIMIT_MAX, NODE_CALL_LIMIT_MIN } from '@keith/contracts'
import { openDatabase, settingsRepo, tokensRepo } from '@keith/db'
import { acquireLock, configEntries, LOCK_FILE } from '../modules/admin/index.ts'
import { migrateWithBackup, secureDataDir } from '../platform/db.ts'
import type { Logger } from '../platform/logger.ts'
import { type CliDeps, configOf, connectLocal, requireOffline } from './context.ts'

const when = (ms: number | null): string =>
  ms === null ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

export function pairCommand(deps: CliDeps) {
  return defineCommand({
    name: 'pair',
    summary: 'Print the command that joins a node to this core',
    run: async (ctx) => {
      const { client } = await connectLocal(deps)
      const pairing = await client.rpc.nodes.pair()
      ctx.io.stdout.write(
        `pairing code ${pairing.code} (valid until ${new Date(pairing.expiresAt).toLocaleTimeString()})\nOn the node machine run:\n  ${pairing.joinCommand}\n`,
      )
      return 0
    },
  })
}

/** `approvals ttl [hours]`: how long a pending approval waits for an answer (ADR-0027 §10). */
export function approvalsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'approvals',
    summary: 'How long a pending approval waits for an answer',
    subcommands: [
      defineCommand({
        name: 'ttl',
        summary: 'Show or set the lifetime of an approval (hours, 1 to 168; default 24)',
        usage: '[hours]',
        positionals: true,
        run: async (ctx) => {
          const [raw] = ctx.positionals
          const { client } = await connectLocal(deps)
          if (raw === undefined) {
            const now = await client.rpc.admin.approvals.get()
            ctx.io.stdout.write(
              `approvals: ${now.ttlHours} hours (default ${now.defaultHours}, max ${now.maxHours}); an older request is denied as expired\n`,
            )
            return 0
          }
          const hours = Number(raw)
          if (!Number.isInteger(hours) || hours < 1 || hours > 168)
            throw new UsageError('give a whole number of hours, 1 to 168')
          const done = await client.rpc.admin.approvals.set({ ttlHours: hours })
          ctx.io.stdout.write(
            `approvals: ${done.ttlHours} hours (a request older than that is denied as expired)\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'ping-before',
        summary: 'Show or set how many hours before expiry the owner is pinged about an approval',
        usage: '[hours]',
        positionals: true,
        run: async (ctx) => {
          const [raw] = ctx.positionals
          const { client } = await connectLocal(deps)
          if (raw === undefined) {
            const now = await client.rpc.admin.approvals.get()
            ctx.io.stdout.write(
              `approvals: ping ${now.pingBeforeHours} hours before expiry (default ${now.defaultPingBeforeHours}; below the ${now.ttlHours}-hour lifetime)\n`,
            )
            return 0
          }
          const hours = Number(raw)
          if (!Number.isInteger(hours) || hours < 1)
            throw new UsageError('give a whole number of hours, at least 1 and below the lifetime')
          const done = await client.rpc.admin.approvals.set({ pingBeforeHours: hours })
          ctx.io.stdout.write(
            `approvals: ping ${done.pingBeforeHours} hours before expiry (below the ${done.ttlHours}-hour lifetime)\n`,
          )
          return 0
        },
      }),
    ],
  })
}

export function nodesCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'nodes',
    summary: 'Paired nodes',
    subcommands: [
      defineCommand({
        name: 'list',
        summary: 'List nodes',
        run: async (ctx) => {
          const { client } = await connectLocal(deps)
          printTable(
            ctx.io,
            (await client.rpc.nodes.list()).map((n) => [
              n.name,
              n.status,
              `${n.os}/${n.arch}`,
              n.allowShell ? 'shell' : '-',
              when(n.lastSeenAt),
            ]),
            { header: ['NAME', 'STATUS', 'PLATFORM', 'SHELL', 'LAST SEEN'] },
          )
          return 0
        },
      }),
      defineCommand({
        name: 'sandbox-limit',
        summary: 'Show or set the calls per hour one person may make to the sandbox (owner)',
        usage: '[n]',
        positionals: true,
        run: async (ctx) => {
          if (ctx.positionals.length > 1) throw new UsageError('usage: nodes sandbox-limit [n]')
          const [raw] = ctx.positionals
          const { client } = await connectLocal(deps)
          if (raw === undefined) {
            const now = await client.rpc.nodes.settings.get()
            ctx.io.stdout.write(
              `sandbox: ${now.maxPerHourPerPerson} calls per hour per person (${NODE_CALL_LIMIT_MIN} to ${NODE_CALL_LIMIT_MAX}, default ${NODE_CALL_LIMIT_DEFAULT})\n`,
            )
            return 0
          }
          const n = Number(raw)
          if (!/^\d+$/.test(raw) || n < NODE_CALL_LIMIT_MIN || n > NODE_CALL_LIMIT_MAX)
            throw new UsageError(
              `give a whole number of calls per hour, ${NODE_CALL_LIMIT_MIN} to ${NODE_CALL_LIMIT_MAX}`,
            )
          const done = await client.rpc.nodes.settings.set({ maxPerHourPerPerson: n })
          ctx.io.stdout.write(
            `sandbox: ${done.maxPerHourPerPerson} calls per hour per person (a call over that is rate-limited)\n`,
          )
          return 0
        },
      }),
      defineCommand({
        name: 'revoke',
        summary: 'Revoke a node (by name or id)',
        usage: '<name>',
        positionals: true,
        run: async (ctx) => {
          const id = ctx.positionals[0]
          if (id === undefined) throw new UsageError('missing node name')
          await (await connectLocal(deps)).client.rpc.nodes.revoke({ id })
          ctx.io.stdout.write(`${id}: revoked\n`)
          return 0
        },
      }),
    ],
  })
}

export function configCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'config',
    summary: 'Effective configuration',
    subcommands: [
      defineCommand({
        name: 'show',
        summary:
          'Each value with its source (env, db or default). Precedence: env, then db, then default',
        run: async (ctx) => {
          const config = configOf(deps)
          const stub = { get: () => undefined, set() {}, delete() {} }
          let settings: Parameters<typeof configEntries>[1] = stub
          let name: string | undefined
          const sqlite = existsSync(config.dbFile) ? openDatabase(config.dbFile) : undefined
          try {
            if (sqlite !== undefined) {
              try {
                settings = settingsRepo(sqlite)
                settings.get('setup.done')
                name =
                  settings.get<boolean>('setup.done') === true
                    ? tokensRepo(sqlite).owner()?.name
                    : undefined
              } catch {
                settings = stub // not migrated
              }
            }
            printTable(
              ctx.io,
              configEntries(config, settings, name).map((e) => [e.key, e.value, `(${e.source})`]),
            )
          } finally {
            sqlite?.close()
          }
          return 0
        },
      }),
    ],
  })
}

/** The migration block on the terminal: lines to stdout, warnings to stderr. */
function printLog(io: CliIo): Logger {
  return {
    debug() {},
    info: (message) => io.stdout.write(`${message}\n`),
    warn: (message) => io.stderr?.write(`${message}\n`),
    error: (message) => io.stderr?.write(`${message}\n`),
  }
}

export function dbCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'db',
    summary: 'Database',
    subcommands: [
      defineCommand({
        name: 'migrate',
        summary: 'Create or upgrade the database (core must be stopped)',
        run: async (ctx) => {
          const config = configOf(deps)
          await requireOffline(config, 'db migrate')
          secureDataDir(config.dataDir)
          const lock = acquireLock(join(config.dataDir, LOCK_FILE))
          try {
            migrateWithBackup(config, undefined, printLog(ctx.io), 'offline')
          } finally {
            lock.release()
          }
          ctx.io.stdout.write(`${config.dbFile} is up to date\n`)
          return 0
        },
      }),
    ],
  })
}
