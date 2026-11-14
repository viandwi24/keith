import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION, parseNodeMessage } from '@keith/contracts'
import { driverFingerprint, loadConfig, type NodeConfig, saveConfig } from './platform/config.ts'
import { silentLogger } from './platform/logger.ts'
import { writeFakeDriver } from './testing/fake-driver.ts'

function at<T>(list: T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

import { runNode, wsUrl } from './run.ts'

type Msg = Record<string, unknown>

let root: string
let received: Msg[]
let auth: (string | null)[]
let sockets: Bun.ServerWebSocket<unknown>[]
let accept: boolean
let refuseUpgrade: 0 | 401 | 503
let server: ReturnType<typeof Bun.serve>

const send = (ws: Bun.ServerWebSocket<unknown>, m: Msg): void => {
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...m }))
}

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'keith-node-run-'))
  received = []
  auth = []
  sockets = []
  accept = true
  refuseUpgrade = 0
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      auth.push(req.headers.get('authorization'))
      if (refuseUpgrade !== 0) return new Response('{}', { status: refuseUpgrade })
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: {
      open: (ws) => {
        sockets.push(ws)
      },
      message(ws, raw) {
        const parsed = parseNodeMessage(String(raw))
        if (!parsed.ok) throw new Error(parsed.error)
        received.push(parsed.message as unknown as Msg)
        if (parsed.message.type === 'hello') {
          send(ws, {
            type: 'welcome',
            accepted: accept,
            nodeId: 'n1',
            heartbeatMs: 50,
            reason: accept ? undefined : 'revoked',
          })
          if (!accept) ws.close()
        }
      },
    },
  })
})
afterEach(async () => {
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
})

const config = (): NodeConfig => ({
  core: `http://localhost:${server.port}`,
  nodeId: 'n1',
  token: 'tok',
  name: 'n',
  policy: { allowShell: true, workdir: join(root, 'w') },
  drivers: [],
})

describe('runNode', () => {
  test('wsUrl maps http to ws and https to wss', () => {
    expect(wsUrl('http://h:1')).toBe('ws://h:1/nodes/ws')
    expect(wsUrl('https://h/base/')).toBe('wss://h/base/nodes/ws')
  })

  test('hello, heartbeat, invoke to result with progress, cancel, clean stop', async () => {
    const abort = new AbortController()
    const done = runNode(config(), { logger: silentLogger, signal: abort.signal })
    await waitFor(() => received.filter((m) => m.type === 'heartbeat').length >= 2)
    expect(auth[0]).toBe('Bearer tok')
    expect(received[0]?.type).toBe('hello')

    const ws = at(sockets, 0)
    send(ws, {
      type: 'invoke',
      callId: 'a',
      capability: 'shell.exec',
      input: { command: 'echo round-trip' },
      timeoutMs: 5000,
    })
    await waitFor(() => received.some((m) => m.type === 'result' && m.callId === 'a'))
    const result = received.find((m) => m.type === 'result' && m.callId === 'a')
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(String(result?.output)).toContain('round-trip')
    expect(received.some((m) => m.type === 'progress' && m.callId === 'a')).toBe(true)

    send(ws, {
      type: 'invoke',
      callId: 'b',
      capability: 'shell.exec',
      input: { command: 'sleep 30' },
      timeoutMs: 60_000,
    })
    await Bun.sleep(150)
    send(ws, { type: 'cancel', callId: 'b' })
    await waitFor(() => received.some((m) => m.type === 'result' && m.callId === 'b'))
    expect(received.find((m) => m.type === 'result' && m.callId === 'b')).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    abort.abort()
    expect(await done).toBe(0)
  })

  test('reconnects after the server closes the socket', async () => {
    const abort = new AbortController()
    const done = runNode(config(), { logger: silentLogger, signal: abort.signal, random: () => 0 })
    await waitFor(() => sockets.length === 1 && received.length > 0)
    at(sockets, 0).close()
    await waitFor(() => sockets.length === 2, 6_000)
    await waitFor(() => received.filter((m) => m.type === 'hello').length === 2)
    abort.abort()
    expect(await done).toBe(0)
  })

  test('a running command dies when the socket drops', async () => {
    const abort = new AbortController()
    const pidFile = join(root, 'pid')
    const done = runNode(config(), { logger: silentLogger, signal: abort.signal, random: () => 0 })
    await waitFor(() => sockets.length === 1 && received.length > 0)
    send(at(sockets, 0), {
      type: 'invoke',
      callId: 'x',
      capability: 'shell.exec',
      input: { command: `echo $$ > ${pidFile}; sleep 30` },
      timeoutMs: 60_000,
    })
    await waitFor(() => Bun.file(pidFile).size > 0)
    await Bun.sleep(50)
    const pid = Number((await Bun.file(pidFile).text()).trim())
    at(sockets, 0).close()
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    abort.abort()
    await done
  })

  test('a refused welcome exits with 1 and does not reconnect', async () => {
    accept = false
    const code = await runNode(config(), { logger: silentLogger })
    expect(code).toBe(1)
    await Bun.sleep(1_500)
    expect(sockets).toHaveLength(1)
  })

  test('a rotated token is stored in the config file at 0600 and the next connection uses it', async () => {
    const path = join(root, 'node.json')
    await saveConfig(path, config())
    const abort = new AbortController()
    const done = runNode(config(), {
      logger: silentLogger,
      signal: abort.signal,
      configPath: path,
      random: () => 0,
    })
    await waitFor(() => sockets.length === 1 && received.length > 0)
    send(at(sockets, 0), { type: 'rotate', token: 'fresh-token' })
    await waitFor(() => received.some((m) => m.type === 'rotated'))
    await waitFor(() => sockets.length === 2)
    await waitFor(() => auth.length === 2)
    expect(auth).toEqual(['Bearer tok', 'Bearer fresh-token'])
    expect((await loadConfig(path)).token).toBe('fresh-token')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    abort.abort()
    expect(await done).toBe(0)
  })

  test('without a config file a rotate is not acknowledged and the token stays', async () => {
    const abort = new AbortController()
    const done = runNode(config(), { logger: silentLogger, signal: abort.signal })
    await waitFor(() => sockets.length === 1 && received.length > 0)
    send(at(sockets, 0), { type: 'rotate', token: 'fresh-token' })
    await Bun.sleep(100)
    expect(received.some((m) => m.type === 'rotated')).toBe(false)
    expect(sockets).toHaveLength(1)
    abort.abort()
    expect(await done).toBe(0)
  })
})

describe('runNode drivers (P31)', () => {
  const helloManifest = (): Msg | undefined =>
    received.find((m) => m.type === 'hello')?.manifest as Msg | undefined

  test('hello announces the built-in drivers and an installed driver that loads (manifest v2)', async () => {
    const folder = join(root, 'fake')
    await writeFakeDriver(folder, 'fake')
    const abort = new AbortController()
    const withDriver: NodeConfig = {
      ...config(),
      drivers: [
        {
          name: 'fake',
          source: 'path',
          path: folder,
          sha256: await driverFingerprint(folder),
          options: {},
        },
      ],
    }
    const done = runNode(withDriver, { logger: silentLogger, signal: abort.signal })
    await waitFor(() => helloManifest() !== undefined)
    expect(helloManifest()).toMatchObject({
      manifestVersion: 2,
      drivers: [
        { name: 'system', capabilities: [{ id: 'system.info', schemaVersion: 1 }] },
        { name: 'shell', capabilities: [{ id: 'shell.exec', schemaVersion: 1 }] },
        { name: 'fake', capabilities: [{ id: 'fake.ping', schemaVersion: 1 }] },
      ],
    })
    abort.abort()
    expect(await done).toBe(0)
  })

  test('a driver that throws at start is absent and the node still comes online', async () => {
    const folder = join(root, 'boom')
    await writeFakeDriver(folder, 'boom', { throwAtStart: true })
    const abort = new AbortController()
    const withDriver: NodeConfig = {
      ...config(),
      drivers: [
        {
          name: 'boom',
          source: 'path',
          path: folder,
          sha256: await driverFingerprint(folder),
          options: {},
        },
      ],
    }
    const done = runNode(withDriver, { logger: silentLogger, signal: abort.signal })
    await waitFor(() => received.filter((m) => m.type === 'heartbeat').length >= 2)
    expect(helloManifest()).toMatchObject({ drivers: [{ name: 'system' }, { name: 'shell' }] })
    abort.abort()
    expect(await done).toBe(0)
  })
})

describe('runNode revocation (F-033)', () => {
  test('a socket closed with 4003 exits with code 3 and does not reconnect', async () => {
    const done = runNode(config(), { logger: silentLogger, random: () => 0 })
    await waitFor(() => received.some((m) => m.type === 'hello'))
    at(sockets, 0).close(4003, 'revoked')
    expect(await done).toBe(3)
    await Bun.sleep(1_200)
    expect(sockets).toHaveLength(1)
  })

  test('a token refused at connect (401) exits with code 3 instead of retrying', async () => {
    refuseUpgrade = 401
    const done = runNode(config(), { logger: silentLogger, random: () => 0 })
    expect(await done).toBe(3)
    expect(auth.length).toBe(2) // the failed upgrade, then one plain probe
    expect(auth.every((a) => a === 'Bearer tok')).toBe(true)
    expect(sockets).toHaveLength(0)
  })

  test('a 503 at connect keeps retrying; the daemon stops only on abort', async () => {
    refuseUpgrade = 503
    const abort = new AbortController()
    const done = runNode(config(), {
      logger: silentLogger,
      signal: abort.signal,
      random: () => 0,
    })
    await waitFor(() => auth.length >= 4, 8_000)
    abort.abort()
    expect(await done).toBe(0)
  })
})
