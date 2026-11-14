/**
 * M1 gate (docs/plans/done/P2-m1-chat.md): the real core in process, driven through
 * `@keith/client` exactly as the TUI does. The model is `scriptedProvider` (no network).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase } from '@keith/db'
import type { UIMessage } from 'ai'
import { scriptedProvider } from 'eharness/testing'
import { type Core, createCore } from './compose.ts'
import { loadConfig } from './platform/config.ts'
import { silentLogger } from './platform/logger.ts'
import { migrateAll } from './testing/migrate-all.ts'
import { issueOwnerToken } from './testing/owner-token.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-e2e-'))
const config = loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'e2e' })

interface Running {
  core: Core
  server: ReturnType<typeof Bun.serve>
  url: string
}
const running: Running[] = []

async function boot(): Promise<Running> {
  const core = await createCore({
    config,
    logger: silentLogger,
    catalogs: { offline: true },
    definitions: [
      scriptedProvider({
        models: {
          a: [{ text: 'Hello, I am Keith.' }],
          b: [{ text: 'Model B menjawab.' }],
        },
      }),
    ],
  })
  const server = Bun.serve({ port: 0, fetch: core.fetch, websocket: core.websocket })
  const r = { core, server, url: server.url.href }
  running.push(r)
  return r
}

async function stop(r: Running): Promise<void> {
  await r.server.stop(true)
  await r.core.close()
}

const textOf = (m: UIMessage | undefined): string =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')

async function collect(stream: AsyncGenerator<UIMessage>): Promise<UIMessage[]> {
  const out: UIMessage[] = []
  for await (const m of stream) out.push(structuredClone(m))
  return out
}

afterAll(async () => {
  for (const r of running) await stop(r).catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('M1: chat end to end', () => {
  let token = ''
  let client: KeithClient

  test('an unmigrated database is refused with the command to run', async () => {
    await expect(createCore({ config, logger: silentLogger })).rejects.toThrow('bun run db:migrate')
    const sqlite = openDatabase(config.dbFile)
    migrateAll(sqlite)
    sqlite.close()
  })

  test('an owner token authorizes; /health is open and reports the build', async () => {
    const r = await boot()
    token = await issueOwnerToken(config)
    expect(token).toStartWith('keith_')
    client = createKeithClient({ baseUrl: r.url, token })
    const health = await client.rpc.health.get()
    expect(health).toMatchObject({ status: 'ok', sha: 'e2e' })
    // the version comes from apps/core/package.json (Changesets bumps it)
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/)
    expect((await fetch(new URL('/health', r.url))).status).toBe(200)
  })

  test('without the token, chat and rpc are refused', async () => {
    const url = running[0]?.url ?? ''
    const anonymous = createKeithClient({ baseUrl: url, token: 'keith_wrong' })
    await expect(anonymous.rpc.providers.list()).rejects.toThrow()
    await expect(anonymous.harness.sessions.messages('front:owner')).rejects.toMatchObject({
      status: 401,
    })
    expect((await fetch(new URL('/sessions/front:owner/messages', url))).status).toBe(401)
  })

  test('a person reaches only their own front session', async () => {
    await expect(client.harness.sessions.messages('front:someone')).rejects.toMatchObject({
      status: 404,
    })
  })

  test('without a model the turn ends with a readable notice and no network call', async () => {
    await collect(client.reply('hello?'))
    const page = await client.harness.sessions.messages('front:owner')
    const notice = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'data-eh.notice') as
      | { data?: { message?: string } }
      | undefined
    expect(notice?.data?.message).toContain('/connect')
  })

  test('a connection and a model pick make the front agent stream its answer', async () => {
    await client.rpc.providers.put({ providerId: 'scripted' })
    await client.rpc.models.roles.set({ role: 'front', ref: 'scripted:a' })
    const streamed = await collect(client.reply('hello'))
    expect(streamed.length).toBeGreaterThan(1) // several snapshots: it streamed
    expect(textOf(streamed.at(-1))).toBe('Hello, I am Keith.')
  })

  test('a new model pick applies to the next turn without a restart', async () => {
    await client.rpc.models.roles.set({ role: 'front', ref: 'scripted:b' })
    const streamed = await collect(client.reply('and now?'))
    expect(textOf(streamed.at(-1))).toBe('Model B menjawab.')
  })

  test('credentials never come back in clear', async () => {
    const key = ['sk', 'e2e', crypto.randomUUID().replaceAll('-', '')].join('-')
    const created = await client.rpc.providers.put({
      providerId: 'openrouter',
      settings: { apiKey: key },
    })
    expect(created.settings.apiKey).toEqual({ set: true, hint: `…${key.slice(-4)}` })
    expect(JSON.stringify(await client.rpc.providers.list())).not.toContain(key)
    const sqlite = openDatabase(config.dbFile)
    const rows = sqlite
      .query<{ settings: string }, []>('SELECT settings FROM config_profiles')
      .all()
    sqlite.close()
    expect(JSON.stringify(rows)).not.toContain(key)
  })

  test('the conversation survives a core restart', async () => {
    const first = running[0]
    if (first !== undefined) await stop(first)
    running.length = 0
    const r = await boot()
    const again = createKeithClient({ baseUrl: r.url, token })
    const page = await again.harness.sessions.messages('front:owner')
    const texts = page.messages.map((m) => `${m.role}: ${textOf(m)}`)
    expect(texts).toContain('user: hello?')
    expect(texts).toContain('user: hello')
    expect(texts).toContain('assistant: Hello, I am Keith.')
    expect(texts).toContain('user: and now?')
    expect(texts).toContain('assistant: Model B menjawab.')
    expect((await again.rpc.models.roles.get()).front).toBe('scripted:b')
  })
})
