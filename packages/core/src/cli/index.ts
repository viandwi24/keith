// The `keith` command: setup, start, migrate, --version. `runCli` takes its I/O as parameters so
// tests can run it in-process; `main.ts` is the executable.

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isKeithError } from '@keith/sdk'
import { type BootstrapOptions, bootstrap, KEITH_VERSION, type Keith } from '../bootstrap.ts'
import { keithPaths } from '../config/index.ts'
import { systemClock } from '../shared/index.ts'
import type { Clock } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import { type Prompter, terminalPrompter } from './prompt.ts'
import { runSetup } from './setup.ts'

export { type Prompter, scriptedPrompter, terminalPrompter } from './prompt.ts'
export { PROVIDER_CHOICES, renderConfig, runSetup, type SetupOptions, type SetupResult } from './setup.ts'

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
  const prompter = io.prompter ?? terminalPrompter()
  try {
    await runSetup({ home: keithHome(io.env), prompter, out: io.out, clock: io.clock ?? systemClock })
    return 0
  } finally {
    prompter.close()
  }
}

async function migrateCommand(io: CliIo): Promise<number> {
  const paths = keithPaths(keithHome(io.env))
  await mkdir(paths.home, { recursive: true })
  const db = openDb(paths.dbFile)
  db.close()
  io.out(`Database is up to date: ${paths.dbFile}`)
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
