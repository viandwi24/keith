import type { AccessMode, AccessProxy } from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'
import type { Config } from '../../platform/config.ts'
import { isLoopbackHost } from '../../platform/net.ts'

/** Settings keys of the admin layer (docs/specs/core-cli.md). */
export const SETTING = {
  setupDone: 'setup.done',
  accessMode: 'access.mode',
  accessPublicUrl: 'access.publicUrl',
  accessHost: 'access.host',
  accessProxy: 'access.proxy',
} as const

export type ValueSource = 'env' | 'db' | 'default'

export interface Network {
  mode: AccessMode
  host: string
  port: number
  publicUrl: string | undefined
  proxy: AccessProxy
  sources: { host: ValueSource; port: ValueSource; publicUrl: ValueSource; mode: ValueSource }
}

const DEFAULT_HOST = '127.0.0.1'

/**
 * Bind address, port and public URL: the environment wins, then the settings the owner saved
 * (`access.*`), then the defaults. Read again whenever it is needed, so `access` takes effect
 * without a restart except for the bind address.
 */
export function effectiveNetwork(config: Config, settings: SettingsRepo): Network {
  const dbHost = settings.get<string>(SETTING.accessHost)
  const dbUrl = settings.get<string>(SETTING.accessPublicUrl)
  const dbMode = settings.get<AccessMode>(SETTING.accessMode)
  const host: [string, ValueSource] =
    config.sources.host === 'env'
      ? [config.host, 'env']
      : dbHost !== undefined
        ? [dbHost, 'db']
        : [DEFAULT_HOST, 'default']
  const publicUrl: [string | undefined, ValueSource] =
    config.sources.publicUrl === 'env'
      ? [config.publicUrl, 'env']
      : dbUrl !== undefined
        ? [dbUrl, 'db']
        : [undefined, 'default']
  return {
    mode: dbMode ?? 'local',
    proxy: settings.get<AccessProxy>(SETTING.accessProxy) ?? 'none',
    host: host[0],
    port: config.port,
    publicUrl: publicUrl[0],
    sources: {
      host: host[1],
      port: config.sources.port,
      publicUrl: publicUrl[1],
      mode: dbMode === undefined ? 'default' : 'db',
    },
  }
}

/** The bind address `access remote` records: a proxy (https URL) keeps loopback, else all interfaces. */
export function deriveBindHost(mode: AccessMode, publicUrl: string | undefined): string {
  if (mode === 'local') return DEFAULT_HOST
  if (publicUrl?.startsWith('https://')) return DEFAULT_HOST
  return '0.0.0.0'
}

/** Whether a host is loopback (re-exported for the doctor). */
export const isLoopback = isLoopbackHost

/** Every value `config show` prints, with where it came from. */
export function configEntries(
  config: Config,
  settings: SettingsRepo,
  ownerName: string | undefined,
): { key: string; value: string; source: ValueSource }[] {
  const net = effectiveNetwork(config, settings)
  return [
    {
      key: 'data dir',
      value: config.dataDir,
      source: config.sources.dataDir === 'env' ? 'env' : 'default',
    },
    { key: 'host', value: net.host, source: net.sources.host },
    { key: 'port', value: String(net.port), source: net.sources.port },
    { key: 'public url', value: net.publicUrl ?? '(none)', source: net.sources.publicUrl },
    { key: 'access mode', value: net.mode, source: net.sources.mode },
    {
      key: 'access proxy',
      value: net.proxy,
      source: settings.get(SETTING.accessProxy) === undefined ? 'default' : 'db',
    },
    {
      key: 'allowed hosts',
      value: config.allowedHosts.join(', ') || '(none)',
      source: config.sources.allowedHosts,
    },
    { key: 'log level', value: config.logLevel, source: config.sources.logLevel },
    {
      key: 'setup done',
      value: String(settings.get<boolean>(SETTING.setupDone) === true),
      source: 'db',
    },
    { key: 'owner name', value: ownerName ?? '(unset)', source: 'db' },
  ]
}
