import { CliError } from '@keith/cli'
import { createKeithClient, type KeithClient } from '@keith/client'
import type { AnyProviderDefinition, ManagerCatalogOptions } from 'eharness/providers'
import type { HasherOptions } from '../modules/auth/index.ts'
import { probeSocket, socketPathFor } from '../modules/local-socket/index.ts'
import { type Config, loadConfig } from '../platform/config.ts'
import type { FileLogger } from '../platform/logger.ts'
import type { RunOptions } from '../run-core.ts'
import { adminSessionFetch } from './admin-session.ts'
import type { ConsoleDeps } from './console-types.ts'

/** What the commands need from outside; the defaults are the real process, tests override. */
export interface CliDeps {
  /** Environment (default `process.env`). */
  env?: Record<string, string | undefined>
  /** Provider definitions, catalogs and fetch of the offline service layer (tests). */
  offline?: {
    definitions?: AnyProviderDefinition[]
    catalogs?: ManagerCatalogOptions
    fetch?: typeof fetch
  }
  /** `start` options (tests: definitions, timing, port 0, logger). */
  start?: Partial<Pick<RunOptions, 'core' | 'port'>> & { logger?: FileLogger }
  /** Whether `tailscale version` works (default: runs it). */
  tailscale?: () => Promise<boolean>
  /** Terminal console and setup wizard (tests: fake probe, spawn, `which` and screens). */
  console?: ConsoleDeps
  /** Test only: a cheaper argon2 cost for the owner PIN the wizard sets. */
  hasher?: HasherOptions
  /** Ask the owner's PIN for an admin session on a socket that needs one (default: a hidden prompt). */
  askPin?: () => Promise<string>
  /** Version printed by `--version`. */
  version?: string
}

export function configOf(deps: CliDeps): Config {
  try {
    return loadConfig(deps.env ?? process.env)
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
}

export const NOT_RUNNING = 'core is not running; start it with `keith-core start`'

/** `fetch` that talks to a Unix socket whatever the URL says. */
export function unixFetch(socketPath: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, { ...init, unix: socketPath } as RequestInit)) as typeof fetch
}

export interface Online {
  client: KeithClient
  config: Config
  socketPath: string
}

/**
 * The typed client over the local socket; refuses when core is not running. `prompt: false` never asks for the
 * owner PIN (doctor): a socket that needs a session then fails with `AdminSessionRequiredError`.
 */
export async function connectLocal(
  deps: CliDeps,
  options: { prompt?: boolean | undefined } = {},
): Promise<Online> {
  const config = configOf(deps)
  const socketPath = socketPathFor(config.dataDir)
  if (!(await probeSocket(socketPath))) throw new CliError(NOT_RUNNING)
  // with `local trust: none` the socket answers 401 until a PIN buys a short admin session, kept in memory (admin-session.ts)
  const client = createKeithClient({
    baseUrl: 'http://localhost',
    fetch: adminSessionFetch({
      dataDir: config.dataDir,
      socketFetch: unixFetch(socketPath),
      ask: deps.askPin,
      initialToken: config.adminSession,
      prompt: options.prompt,
    }),
  })
  return { client, config, socketPath }
}

/** Offline-only commands call this first: they refuse while the socket answers. */
export async function requireOffline(config: Config, what: string): Promise<void> {
  if (await probeSocket(socketPathFor(config.dataDir))) {
    throw new CliError(
      `core is running; stop it before \`keith-core ${what}\` (this command works only while core is stopped)`,
    )
  }
}
