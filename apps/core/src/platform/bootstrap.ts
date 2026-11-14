import { join } from 'node:path'
import { type Config, loadConfig } from './config.ts'
import { createLogger, type FileLogger } from './logger.ts'

/** Everything Keith creates is owner-only. */
export function applyUmask(): void {
  process.umask(0o077)
}

export interface Bootstrap {
  config: Config
  logger: FileLogger
}

/**
 * What every entrypoint (`start`, `setup`, `db migrate`, `token recover`) does first: everything
 * Keith creates is owner-only (umask 077), the config comes from the environment, the logger
 * writes the daily files in the data folder.
 */
export function bootstrap(env: Record<string, string | undefined> = process.env): Bootstrap {
  applyUmask()
  const config = loadConfig(env)
  const logger = createLogger({ level: config.logLevel, dir: join(config.dataDir, 'logs') })
  return { config, logger }
}
