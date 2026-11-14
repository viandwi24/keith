import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient } from '@keith/client'
import { type Core, createCore } from '../../compose.ts'
import { loadConfig } from '../../platform/config.ts'
import { migrateKeithDatabase } from '../../platform/db.ts'
import { silentLogger } from '../../platform/logger.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import {
  CoreAlreadyRunning,
  type LocalListener,
  listenLocal,
  probeSocket,
  SOCKET_PATH_FILE,
  socketPathFor,
} from './index.ts'

const dirs: string[] = []
const stops: Array<() => Promise<unknown>> = []
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'keith-sock-'))
  dirs.push(d)
  return d
}
afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function boot() {
  const dataDir = dir()
  const config = loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'sock' })
  migrateKeithDatabase(config.dataDir, config.dbFile)
  const core: Core = await createCore({
    config,
    logger: silentLogger,
    catalogs: { offline: true },
    localTrust: 'full',
  })
  const tcp = Bun.serve({ port: 0, fetch: core.fetch, websocket: core.websocket })
  const local = await listenLocal({ dataDir, fetch: core.fetchLocal })
  stops.push(async () => {
    await tcp.stop(true)
    await local.stop()
    await core.close()
  })
  return { config, core, tcp, local }
}

describe('local socket', () => {
  test('an authorized stream on the socket outlives a short idle timeout; an idle connection is closed', async () => {
    const dataDir = dir()
    const config = loadConfig({ KEITH_DATA_DIR: dataDir, KEITH_BUILD_SHA: 'sock' })
    migrateKeithDatabase(config.dataDir, config.dbFile)
    const core: Core = await createCore({
      config,
      logger: silentLogger,
      catalogs: { offline: true },
      localTrust: 'full',
    })
    const local = await listenLocal({ dataDir, fetch: core.fetchLocal, idleTimeout: 1 })
    stops.push(async () => {
      await local.stop()
      await core.close()
    })
    // the same rule as the TCP server: an authorized request (here the owner over the socket) lifts the idle timeout
    const res = await fetch('http://localhost/activity/stream', { unix: local.path } as RequestInit)
    expect(res.status).toBe(200)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const closed = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true
      })(),
      Bun.sleep(3_000).then(() => false),
    ])
    expect(closed).toBe(false)
    await reader.cancel()

    // a connection that sends a partial request and nothing more is closed by the idle timeout
    const gone = Promise.withResolvers<void>()
    const socket = await Bun.connect({
      unix: local.path,
      socket: { data() {}, close: () => gone.resolve(), error: () => gone.resolve() },
    })
    socket.write('POST /rpc/health/get HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n')
    const winner = await Promise.race([
      gone.promise.then(() => 'closed'),
      Bun.sleep(4_000).then(() => 'open'),
    ])
    socket.end()
    expect(winner).toBe('closed')
  })

  test('the socket is owner-only and a request over it is the owner without a token', async () => {
    const { tcp, local } = await boot()
    expect(statSync(local.path).mode & 0o777).toBe(0o600)
    const unix = { unix: local.path } as RequestInit
    const rpc = await fetch('http://localhost/rpc/health/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      ...unix,
    })
    expect(rpc.status).toBe(200)
    const own = await fetch('http://localhost/sessions/front:owner/messages', unix)
    expect(own.status).toBe(200)
    expect((await fetch('http://localhost/sessions/front:other/messages', unix)).status).toBe(404)

    // the same without a token over TCP is refused
    const url = tcp.url.origin
    expect(
      (
        await fetch(`${url}/rpc/health/get`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401)
    expect((await fetch(`${url}/sessions/front:owner/messages`)).status).toBe(401)
  })

  test('the typed client works over the socket with no token', async () => {
    const { local } = await boot()
    const client = createKeithClient({
      baseUrl: 'http://localhost',
      fetch: ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(i, { ...init, unix: local.path } as RequestInit)) as typeof fetch,
    })
    expect((await client.rpc.health.get()).status).toBe('ok')
    expect((await client.rpc.admin.tokens.list()).length).toBe(0)
  })

  test('a token minted over the socket authorizes over TCP', async () => {
    const { tcp, config } = await boot()
    const token = await issueOwnerToken(config)
    const client = createKeithClient({ baseUrl: tcp.url.href, token })
    expect((await client.rpc.admin.tokens.list()).map((t) => t.label)).toEqual(['test'])
  })

  test('a stale socket file is replaced; a live one refuses the start', async () => {
    const { core, local } = await boot()
    const second = dir()
    const stale = join(second, 'core.sock')
    writeFileSync(stale, '')
    const fresh: LocalListener = await listenLocal({ dataDir: second, fetch: core.fetchLocal })
    stops.push(() => fresh.stop())
    expect(await probeSocket(stale)).toBe(true)
    await expect(
      listenLocal({ dataDir: dir(), fetch: core.fetchLocal, path: local.path }),
    ).rejects.toThrow(CoreAlreadyRunning)
    await fresh.stop()
    expect(await probeSocket(stale)).toBe(false) // removed on stop
  })

  test('a long data dir falls back to a short path under TMPDIR, recorded in the data dir', async () => {
    const long = join(dir(), 'x'.repeat(90))
    mkdirSync(long, { recursive: true })
    const path = socketPathFor(long)
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(Buffer.byteLength(path)).toBeLessThan(104)
    expect(socketPathFor(long)).toBe(path) // deterministic: server and CLI agree
    const { core } = await boot()
    const l = await listenLocal({ dataDir: long, fetch: core.fetchLocal })
    stops.push(() => l.stop())
    expect(l.path).toBe(path)
    expect(readFileSync(join(long, SOCKET_PATH_FILE), 'utf8').trim()).toBe(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
