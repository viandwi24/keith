import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient, type KeithClient } from '@keith/client'
import type { LocalTrust } from '@keith/contracts'
import type { KeithPlugin } from '@keith/host'
import type { AnyProviderDefinition } from 'eharness/providers'
import { scriptedProvider } from 'eharness/testing'
import { type Core, type CoreTiming, createCore } from '../compose.ts'
import type { ViewLimitsForTests } from '../compose-views.ts'
import type { HasherOptions } from '../modules/auth/index.ts'
import type { RoomToolCall } from '../modules/corpus-callosum/index.ts'
import { listenLocal } from '../modules/local-socket/index.ts'
import { loadConfig } from '../platform/config.ts'
import { migrateKeithDatabase } from '../platform/db.ts'
import { silentLogger } from '../platform/logger.ts'

export interface BootedCore {
  dir: string
  core: Core
  /** TCP origin, e.g. `http://localhost:41234`. */
  url: string
  port: number
  socketPath: string
  /** Typed client over the local socket (owner, no token). */
  local: KeithClient
  /** Typed client over TCP with a bearer. */
  tcp(token: string): KeithClient
  stop(): Promise<void>
}

/** Tests: a core on a temp data dir with a TCP listener and the local socket. Call `stop()`. */
/** Cheap argon2 for tests that are not about hashing (the pinned cost has its own test). */
export const FAST_HASH: HasherOptions = { memoryCost: 1024, timeCost: 1 }

export async function bootCore(
  env: Record<string, string> = {},
  options: {
    hasher?: HasherOptions
    localClock?: () => number
    views?: ViewLimitsForTests
    plugins?: readonly KeithPlugin[]
    /** Extra provider definitions next to the default scripted one (for example a priced model). */
    definitions?: AnyProviderDefinition[]
    /** Timers of the background machinery (for example `guestGraceMs`). */
    timing?: Partial<CoreTiming>
    /** How often open streams are re-checked against their credential. */
    streamSweepMs?: number
    /** Every call of a room tool, with the principal it saw (P30.4.1 rights test). */
    onRoomToolCall?: (call: RoomToolCall) => void
    /** The clock of guest sessions and of the per-address start window. */
    guestClock?: () => number
    /**
     * The owner's `local trust`. Default `full`: most tests use the socket as the implicit owner. `default`
     * keeps the product default (`none`: every socket client signs in).
     */
    localTrust?: LocalTrust | 'default'
  } = {},
): Promise<BootedCore> {
  const dir = mkdtempSync(join(tmpdir(), 'keith-boot-'))
  const config = loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test', ...env })
  migrateKeithDatabase(config.dataDir, config.dbFile, options.plugins)
  const core = await createCore({
    config,
    logger: silentLogger,
    definitions: [
      scriptedProvider({ models: { a: [{ text: 'hi' }] } }),
      ...(options.definitions ?? []),
    ],
    catalogs: { offline: true },
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.streamSweepMs === undefined ? {} : { streamSweepMs: options.streamSweepMs }),
    ...(options.onRoomToolCall === undefined ? {} : { onRoomToolCall: options.onRoomToolCall }),
    ...(options.guestClock === undefined ? {} : { guestClock: options.guestClock }),
    ...(options.hasher === undefined ? {} : { hasher: options.hasher }),
    localTrust: options.localTrust === 'default' ? undefined : (options.localTrust ?? 'full'),
    ...(options.localClock === undefined ? {} : { localClock: options.localClock }),
    ...(options.views === undefined ? {} : { views: options.views }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  })
  const tcp = Bun.serve({ port: 0, fetch: core.fetch, websocket: core.websocket })
  const port = tcp.port as number
  core.announce({ host: '127.0.0.1', port })
  const socket = await listenLocal({
    dataDir: dir,
    fetch: core.fetchLocal,
    websocket: core.websocket as never,
  })
  const url = `http://localhost:${port}`
  return {
    dir,
    core,
    url,
    port,
    socketPath: socket.path,
    local: createKeithClient({
      baseUrl: 'http://localhost',
      fetch: ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(i, { ...init, unix: socket.path } as RequestInit)) as typeof fetch,
    }),
    tcp: (token) => createKeithClient({ baseUrl: url, token }),
    async stop() {
      await tcp.stop(true)
      await socket.stop()
      await core.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Tests: step a TCP credential of `person` up (sets their PIN over the socket first). */
export async function stepUp(
  booted: BootedCore,
  credential: string,
  person = 'owner',
  pin = '482915',
): Promise<void> {
  await booted.local.rpc.admin.people.setPin({ person, pin })
  const res = await fetch(`${booted.url}/auth/step-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ pin }),
  })
  if (res.status !== 200) throw new Error(`step-up failed: ${res.status} ${await res.text()}`)
}
