/** Shared setup of the M2 gate tests: data folders, booting a core in process, small helpers. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient, type KeithClient } from '@keith/client'
import type { Task } from '@keith/contracts'
import { openDatabase } from '@keith/db'
import type { UIMessage } from 'ai'
import type { AnyProviderDefinition } from 'eharness/providers'
import { type Core, type CoreOptions, type CoreTiming, createCore } from '../compose.ts'
import { loadConfig } from '../platform/config.ts'
import { silentLogger } from '../platform/logger.ts'
import { SERVER_LIMITS } from '../platform/net.ts'
import { migrateAll } from './migrate-all.ts'
import { issueOwnerToken } from './owner-token.ts'

const dirs: string[] = []
const running: Running[] = []
export const FAST = {
  inboxPollMs: 20,
  reconcileEveryMs: 3_600_000,
  pruneEveryMs: 3_600_000,
  deliveryTickMs: 20,
  deliveryRetryMs: [20, 20, 20],
}

export interface Running {
  core: Core
  server: ReturnType<typeof Bun.serve>
  client: KeithClient
}

export function newDir(env: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'keith-e2e-core-'))
  dirs.push(dir)
  const config = loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'e2e-core', ...env })
  const sqlite = openDatabase(config.dbFile)
  migrateAll(sqlite)
  sqlite.close()
  return config
}

export async function boot(
  config: ReturnType<typeof loadConfig>,
  definitions: AnyProviderDefinition[],
  token?: string,
  timing: Partial<CoreTiming> = FAST,
  instanceId?: string,
  extra: Pick<CoreOptions, 'nodeCapabilities'> = {},
): Promise<Running & { token: string }> {
  const core = await createCore({
    config,
    logger: silentLogger,
    catalogs: { offline: true },
    definitions,
    timing,
    ...(instanceId === undefined ? {} : { instanceId }),
    ...extra,
  })
  const server = Bun.serve({
    port: 0,
    ...SERVER_LIMITS,
    fetch: core.fetch,
    websocket: core.websocket,
  })
  const owner = token ?? (await issueOwnerToken(config))
  const r = {
    core,
    server,
    client: createKeithClient({ baseUrl: server.url.href, token: owner }),
    token: owner,
  }
  running.push(r)
  return r
}

export async function stop(r: Running): Promise<void> {
  const at = running.indexOf(r)
  if (at >= 0) running.splice(at, 1)
  await r.server.stop(true)
  await r.core.close()
}

/** Stop every core still running and remove the data folders (call from `afterAll`). */
export async function cleanup(): Promise<void> {
  for (const r of [...running]) await stop(r).catch(() => undefined)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}

export const textOf = (m: UIMessage | undefined): string =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')

export async function send(client: KeithClient, text: string): Promise<void> {
  for await (const _ of client.reply(text)) {
    // drain: the stream ends with the turn
  }
}

export const spawn = (id: string, description: string) => ({
  toolName: 'agent',
  toolCallId: id,
  input: {
    subagent_type: 'cortex.research',
    description,
    prompt: `Task: ${description}`,
    run_in_background: true,
  },
})

export const messagesOf = async (client: KeithClient): Promise<UIMessage[]> =>
  (await client.harness.sessions.messages('front:owner', { limit: 200 })).messages
export const tasksOf = (client: KeithClient): Promise<Task[]> => client.rpc.tasks.list({})
export const idle = (client: KeithClient): Promise<boolean> =>
  client.harness.sessions.get('front:owner').then((s) => !s.running)

export async function connect(client: KeithClient): Promise<void> {
  await client.rpc.providers.put({ providerId: 'front-p' })
  await client.rpc.providers.put({ providerId: 'cortex-p' })
  // list the models once, as the TUI does: that is when a provider's prices reach the catalog
  await client.rpc.providers.models({ id: 'front-p' })
  await client.rpc.providers.models({ id: 'cortex-p' })
  await client.rpc.models.roles.set({ role: 'front', ref: 'front-p:f' })
  await client.rpc.models.roles.set({ role: 'cortex', ref: 'cortex-p:w' })
}
