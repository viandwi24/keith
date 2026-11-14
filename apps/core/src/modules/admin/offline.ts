import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AuditRepo,
  auditRepo,
  type CredentialsRepo,
  credentialsRepo,
  frontGenerationsRepo,
  type SettingsRepo,
  type Sqlite,
  settingsRepo,
  sqliteActivityStore,
  sqliteCatalogCache,
  sqlitePersonStore,
  sqliteProfileStore,
  type TokensRepo,
  tokensRepo,
} from '@keith/db'
import {
  type AnyProviderDefinition,
  type ManagerCatalogOptions,
  sealedProfileStore,
} from 'eharness/providers'
import type { Config } from '../../platform/config.ts'
import {
  migrateWithBackup,
  openKeithDatabase,
  openKeithDatabaseReadOnly,
} from '../../platform/db.ts'
import type { Logger } from '../../platform/logger.ts'
import type { FrontGenerationOf } from '../../platform/sessions.ts'
import { createVault } from '../../platform/vault.ts'
import { type Budget, createBudget } from '../budget/index.ts'
import { createPeopleService, type PeopleService } from '../people/index.ts'
import {
  createProviderService,
  createUnreadableKeys,
  type ProviderService,
} from '../providers/index.ts'
import { frontGenerations } from '../wernicke-broca/index.ts'
import { acquireLock, type FileLock } from './lockfile.ts'

export const LOCK_FILE = 'core.lock'

export interface OfflineOptions {
  /** Create or upgrade the database first (setup, `db migrate`). Default false: refuse an unmigrated one. */
  migrate?: boolean
  /** Where the migration block goes (setup). Default: stderr. */
  log?: Logger
  /** Do not take the lock (read-only inspection such as `doctor`). Default false. */
  noLock?: boolean
  /**
   * Read only (`doctor`, P23.4.6): the database opens read only, the vault never creates `secret.key`, no
   * `settings.unreadable` audit row is written and the budget is not seeded. Implies `noLock`; cannot migrate.
   */
  readOnly?: boolean
  definitions?: AnyProviderDefinition[]
  catalogs?: ManagerCatalogOptions
  fetch?: typeof fetch
  warn?: (message: string) => void
}

/** The admin operations against the database with core stopped. */
export interface OfflineAdmin {
  sqlite: Sqlite
  settings: SettingsRepo
  tokens: TokensRepo
  credentials: CredentialsRepo
  audit: AuditRepo
  /** The people service, offline: a rename goes through its checks and audit (FD10-03). */
  people: PeopleService
  providers: ProviderService
  /** A read-only open has no budget (its first use would seed a row): reading it throws. */
  readonly budget: Budget
  close(): void
}

/**
 * Open the services of core without running it: settings, providers, models, budget and tokens
 * go through the same code the running core uses. Holds `<dataDir>/core.lock` until `close()`, so
 * two offline commands (or one and a starting core) never write at once.
 */
export async function openOfflineAdmin(
  config: Config,
  options: OfflineOptions = {},
): Promise<OfflineAdmin> {
  const readOnly = options.readOnly === true
  if (readOnly && options.migrate === true)
    throw new Error('a read-only open cannot migrate the database')
  const lock: FileLock | undefined =
    options.noLock || readOnly
      ? undefined
      : (() => {
          // the folder may not exist yet on a first run
          migrateDirOnly(config)
          return acquireLock(join(config.dataDir, LOCK_FILE))
        })()
  try {
    // snapshot first when behind; refuses a database a newer build wrote (ADR-0027 §3)
    if (options.migrate === true)
      migrateWithBackup(config, undefined, options.log ?? stderrLog, 'offline')
    const sqlite = readOnly
      ? await openKeithDatabaseReadOnly(config.dbFile)
      : await openKeithDatabase(config.dataDir, config.dbFile)
    const settings = settingsRepo(sqlite)
    const { vault } = createVault(config.secretKey, config.dataDir, { create: !readOnly })
    const audit = auditRepo(sqlite)
    // a key that cannot be opened must not stop recovery: skip it, warn, audit (OWN-012); a read-only open warns only
    const unreadable = createUnreadableKeys({
      ...(options.warn === undefined ? {} : { warn: options.warn }),
      ...(readOnly
        ? {}
        : {
            record: (keys: string[]) => {
              try {
                audit.add({
                  kind: 'settings.unreadable',
                  actor: 'system',
                  via: 'offline',
                  detail: { keys },
                })
              } catch {}
            },
          }),
    })
    const providers = createProviderService({
      store: sealedProfileStore({
        inner: sqliteProfileStore(sqlite),
        vault,
        onUnreadable: unreadable.onUnreadable,
      }),
      unreadable,
      settings,
      cache: sqliteCatalogCache(sqlite),
      env: config.providerEnv,
      catalogs: options.catalogs ?? { offline: true },
      ...(options.definitions === undefined ? {} : { definitions: options.definitions }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    })
    await providers.ready()
    // createBudget seeds the global limit on first use: a read-only open must not reach it
    const budgetService = readOnly
      ? undefined
      : createBudget({
          sqlite,
          settings,
          store: sqliteActivityStore(sqlite),
          // the offline budget only writes the owner's feed records: the generations as stored, read once
          generations: loadedGenerations(sqlite),
        })
    return {
      sqlite,
      settings,
      tokens: tokensRepo(sqlite),
      credentials: credentialsRepo(sqlite),
      audit,
      people: createPeopleService({
        store: sqlitePersonStore(sqlite, { via: 'offline' }),
        audit: {
          record: (event) => audit.add({ ...event, via: 'offline' }),
        },
        // a rename needs neither sign-in state nor sessions: the offline open has none
        signIn: { canLogin: () => true, setCanLogin: () => false },
      }),
      providers,
      get budget(): Budget {
        if (budgetService === undefined) throw new Error('a read-only open has no budget')
        return budgetService
      },
      close() {
        providers.manager.dispose()
        sqlite.close()
        lock?.release()
      },
    }
  } catch (error) {
    lock?.release()
    throw error
  }
}

/** Lines of a migration go to stderr when no caller asks for another logger. */
const stderrLog: Logger = {
  debug() {},
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
}

/** The stored front generations, read into the port (a read of the table only; nothing is written). */
function loadedGenerations(sqlite: Sqlite): FrontGenerationOf {
  const port = frontGenerations(frontGenerationsRepo(sqlite))
  port.load()
  return port
}

function migrateDirOnly(config: Config): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
}

/** Run `fn` with the offline admin and always close it. */
export async function withOfflineAdmin<T>(
  config: Config,
  options: OfflineOptions,
  fn: (admin: OfflineAdmin) => Promise<T>,
): Promise<T> {
  const admin = await openOfflineAdmin(config, options)
  try {
    return await fn(admin)
  } finally {
    admin.close()
  }
}
