// The `keith` command: setup, start, migrate, backup, restore, --version. `runCli` takes its I/O as parameters so
// tests can run it in-process; `main.ts` is the executable.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isKeithError } from '@keith/sdk'
import { type BootstrapOptions, bootstrap, KEITH_VERSION, type Keith } from '../bootstrap.ts'
import { keithPaths } from '../config/index.ts'
import { systemClock, withHomeLock } from '../shared/index.ts'
import type { Clock } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import { runBackup } from './backup.ts'
import { type Prompter, terminalPrompter } from './prompt.ts'
import { runRestore } from './restore.ts'
import { runSetup } from './setup.ts'

export { type Prompter, scriptedPrompter, terminalPrompter } from './prompt.ts'
export {
  OPTIONAL_PLUGINS,
  PROVIDER_CHOICES,
  renderConfig,
  runSetup,
  type SetupOptions,
  type SetupResult,
} from './setup.ts'

export type CliIo = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  /** Default: the terminal. */
  prompter?: Prompter | undefined
  clock?: Clock | undefined
  /**
   * `keith start` resolves this promise's value when it should stop. Default: the first SIGINT
   * or SIGTERM (a second one exits at once).
   */
  waitForStop?: ((keith: Keith) => Promise<void>) | undefined
  /** Extra bootstrap options (tests: fake plugins, logger). */
  bootstrap?: Partial<Omit<BootstrapOptions, 'home' | 'flags' | 'env'>> | undefined
}

const USAGE = `Usage: keith <command> [options]

Commands:
  setup                  Create KEITH_HOME, config.toml, persona.md, the database and the owner
  start [--port N] [--host H]   Start Keith
  migrate                Apply pending database migrations
  backup [--out DIR]     Copy the database, files, plugins, config and persona to
                         DIR/keith-backup-<YYYYMMDD-HHMMSS>/ (default DIR: KEITH_HOME/backups);
                         works while Keith runs
  restore DIR [--force]  Bring a backup back into a stopped KEITH_HOME (--force moves the
                         current state aside to <KEITH_HOME>.before-restore-<time>/ first)
  --version              Print the version

KEITH_HOME defaults to ~/.keith.`

/** `KEITH_HOME`, or `~/.keith`. */
export function keithHome(env: Record<string, string | undefined>): string {
  const home = env.KEITH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.keith')
}

/** Runs one `keith` command. Returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case '--version':
      case '-v':
      case 'version':
        io.out(KEITH_VERSION)
        return 0
      case undefined:
      case '--help':
      case '-h':
      case 'help':
        io.out(USAGE)
        return 0
      case 'setup':
        return await setupCommand(io)
      case 'start':
        return await startCommand(rest, io)
      case 'migrate':
        return await migrateCommand(io)
      case 'backup':
        return await backupCommand(rest, io)
      case 'restore':
        return await restoreCommand(rest, io)
      default:
        io.err(`Unknown command: ${command}`)
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    io.err(describe(error))
    return 1
  }
}

function describe(error: unknown): string {
  if (isKeithError(error)) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

async function setupCommand(io: CliIo): Promise<number> {
  const home = keithHome(io.env)
  // Setup writes the database: it must not run next to a started Keith (I-1, config.md#logs-and-lock).
  return await withHomeLock(home, async () => {
    const prompter = io.prompter ?? terminalPrompter()
    try {
      await runSetup({ home, prompter, out: io.out, clock: io.clock ?? systemClock })
      return 0
    } finally {
      prompter.close()
    }
  })
}

async function migrateCommand(io: CliIo): Promise<number> {
  const paths = keithPaths(keithHome(io.env))
  await mkdir(paths.home, { recursive: true })
  return await withHomeLock(paths.home, async () => {
    const db = openDb(paths.dbFile)
    db.close()
    io.out(`Database is up to date: ${paths.dbFile}`)
    return 0
  })
}

async function backupCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  await runBackup({
    paths: keithPaths(keithHome(io.env)),
    out: values.out,
    clock: io.clock ?? systemClock,
    print: io.out,
  })
  return 0
}

async function restoreCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { force: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: true,
  })
  const [from, ...extra] = positionals
  if (from === undefined || extra.length > 0) {
    io.err('Usage: keith restore <dir> [--force]')
    return 2
  }
  await runRestore({
    paths: keithPaths(keithHome(io.env)),
    from,
    force: values.force,
    clock: io.clock ?? systemClock,
    print: io.out,
  })
  return 0
}

async function startCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, host: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  })
  let port: number | undefined
  if (values.port !== undefined) {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      io.err(`Invalid --port: ${values.port}`)
      return 2
    }
  }
  const keith = await bootstrap({
    ...io.bootstrap,
    home: keithHome(io.env),
    flags: { port, host: values.host },
    env: io.env,
    clock: io.bootstrap?.clock ?? io.clock,
  })
  io.out(`Keith ${keith.version} is listening on ${keith.url}`)
  await (io.waitForStop ?? waitForSignal)(keith)
  await keith.stop()
  return 0
}

/** Resolves on the first SIGINT/SIGTERM; a second signal exits at once. */
function waitForSignal(keith: Keith): Promise<void> {
  return new Promise((resolve) => {
    let received = false
    const onSignal = (signal: NodeJS.Signals) => {
      if (received) {
        keith.log.warn('second signal, exiting now', { signal })
        process.exit(1)
      }
      received = true
      keith.log.info('signal received, shutting down', { signal })
      resolve()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}
