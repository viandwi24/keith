import { afterAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { createRequestGuard, isForwarded } from './guard.ts'

const booted: BootedCore[] = []
afterAll(async () => {
  for (const b of booted) await b.stop().catch(() => undefined)
})
async function boot(env: Record<string, string> = {}) {
  const b = await bootCore(env)
  booted.push(b)
  return b
}
const get = (b: BootedCore, path: string, headers: Record<string, string>) =>
  fetch(`${b.url}${path}`, { headers })
const rpcHealth = (b: BootedCore, headers: Record<string, string>) =>
  fetch(`${b.url}/rpc/health/get`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  })

describe('Host allowlist on a running core', () => {
  test('a foreign Host is refused on /health, /rpc and /nodes/ws', async () => {
    const b = await boot()
    expect((await get(b, '/health', { host: 'evil.example' })).status).toBe(421)
    expect((await rpcHealth(b, { host: 'evil.example' })).status).toBe(421)
    const ws = await get(b, '/nodes/ws', {
      host: 'evil.example',
      upgrade: 'websocket',
      connection: 'Upgrade',
    })
    expect(ws.status).toBe(421)
    // the real host reaches the route (a node token is still needed)
    expect((await get(b, '/health', {})).status).toBe(200)
    expect((await get(b, '/nodes/ws', {})).status).toBe(401)
  })

  test('loopback names need the listening port', async () => {
    const b = await boot()
    expect((await get(b, '/health', { host: `127.0.0.1:${b.port}` })).status).toBe(200)
    expect((await get(b, '/health', { host: `localhost:${b.port}` })).status).toBe(200)
    expect((await get(b, '/health', { host: `[::1]:${b.port}` })).status).toBe(200)
    expect((await get(b, '/health', { host: 'localhost:1' })).status).toBe(421)
    expect((await get(b, '/health', { host: 'localhost' })).status).toBe(421) // port 80
  })

  test('the public URL host is allowed on any port (proxies)', async () => {
    const b = await boot({ KEITH_PUBLIC_URL: 'https://mac.tailnet.ts.net' })
    expect((await get(b, '/health', { host: 'mac.tailnet.ts.net' })).status).toBe(200)
    expect((await get(b, '/health', { host: 'mac.tailnet.ts.net:8443' })).status).toBe(200)
    expect((await get(b, '/health', { host: 'other.tailnet.ts.net' })).status).toBe(421)
  })

  test('a public URL saved with `access` takes effect without a restart', async () => {
    const b = await boot()
    expect((await get(b, '/health', { host: 'core.example.org' })).status).toBe(421)
    await b.local.rpc.admin.access.set({ mode: 'remote', publicUrl: 'https://core.example.org' })
    expect((await get(b, '/health', { host: 'core.example.org' })).status).toBe(200)
  })

  test('KEITH_ALLOWED_HOSTS adds names', async () => {
    const b = await boot({ KEITH_ALLOWED_HOSTS: 'Core.Lan, nas.home' })
    expect((await get(b, '/health', { host: 'core.lan' })).status).toBe(200)
    expect((await get(b, '/health', { host: 'nas.home:7420' })).status).toBe(200)
    expect((await get(b, '/health', { host: 'router.home' })).status).toBe(421)
  })

  test('an Origin that is not allowed is refused, an allowed one passes', async () => {
    const b = await boot()
    expect((await get(b, '/health', { origin: 'http://evil.example' })).status).toBe(403)
    expect((await get(b, '/health', { origin: 'null' })).status).toBe(403)
    expect((await get(b, '/health', { origin: `http://evil.example:${b.port}` })).status).toBe(403)
    expect((await get(b, '/health', { origin: `http://localhost:${b.port}` })).status).toBe(200)
    expect((await get(b, '/health', { origin: 'http://localhost:1' })).status).toBe(403)
  })

  test('the local socket skips the checks', async () => {
    const b = await boot()
    const res = await fetch('http://evil.example/health', {
      unix: b.socketPath,
      headers: { origin: 'http://evil.example' },
    } as RequestInit)
    expect(res.status).toBe(200)
  })
})

describe('proxy rule', () => {
  test('forwarding headers on loopback never make a request local', async () => {
    const b = await boot()
    for (const headers of [
      { 'x-forwarded-for': '127.0.0.1' },
      { forwarded: 'for=127.0.0.1' },
      { 'tailscale-user-login': 'vian@example.com' },
    ]) {
      expect((await rpcHealth(b, headers)).status).toBe(401)
    }
  })

  test('a call through a proxy is audited as remote, and X-Forwarded-For is not the client address', async () => {
    const b = await boot()
    const token = await issueOwnerToken({ dataDir: b.dir, dbFile: `${b.dir}/keith.db` } as never)
    const res = await fetch(`${b.url}/rpc/admin/tokens/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-forwarded-for': '9.9.9.9',
      },
      body: JSON.stringify({ json: { label: 'via proxy' } }),
    })
    expect(res.status).toBe(200)
    const [event] = await b.local.rpc.admin.audit.list({ limit: 1 })
    expect(event).toMatchObject({ kind: 'credential.created', via: 'tcp' })
    expect(event?.detail.forwarded).toBe(true)
  })

  test('`access --proxy` is stored', async () => {
    const b = await boot()
    expect((await b.local.rpc.admin.access.get()).proxy).toBe('none')
    const set = await b.local.rpc.admin.access.set({ mode: 'remote', proxy: 'tailscale-serve' })
    expect(set.proxy).toBe('tailscale-serve')
    expect((await b.local.rpc.admin.access.get()).proxy).toBe('tailscale-serve')
  })

  test('isForwarded sees Forwarded, X-Forwarded-* and Tailscale-User-*', () => {
    expect(isForwarded(new Headers({ forwarded: 'for=1.1.1.1' }))).toBe(true)
    expect(isForwarded(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true)
    expect(isForwarded(new Headers({ 'Tailscale-User-Name': 'x' }))).toBe(true)
    expect(isForwarded(new Headers({ host: 'localhost', accept: '*/*' }))).toBe(false)
  })
})

describe('createRequestGuard', () => {
  const guard = createRequestGuard({ publicUrl: () => undefined, extraHosts: [] })
  const check = (host: string, port = 7420, origin?: string) =>
    guard.check(
      new Request('http://localhost/x', { headers: { ...(origin ? { origin } : {}), host } }),
      port,
    )?.status
  test('malformed and odd Host values are refused', () => {
    expect(check('')).toBe(421)
    expect(check('localhost:7420@evil.example')).toBe(421)
    expect(check('localhost:7420/x')).toBe(421)
    expect(check('LOCALHOST:7420')).toBeUndefined()
  })
  test('without a known listening port the port is not compared', () => {
    expect(guard.check(new Request('http://localhost:1/x'), undefined)).toBeUndefined()
  })
})

describe('createRequestGuard for the guest listener', () => {
  let extra: string[] = ['kiosk.example']
  const guard = createRequestGuard({
    publicUrl: () => undefined,
    extraHosts: () => extra,
    literalIps: true,
  })
  const check = (host: string, port = 7421, origin?: string) =>
    guard.check(
      new Request('http://localhost/x', { headers: { ...(origin ? { origin } : {}), host } }),
      port,
    )?.status
  test('a literal LAN address with the listening port is served, with a wrong port it is not', () => {
    expect(check('192.168.1.5:7421')).toBeUndefined()
    expect(check('10.0.0.8:7421', 7421, 'http://10.0.0.8:7421')).toBeUndefined()
    expect(check('[fd00::2]:7421')).toBeUndefined()
    expect(check('192.168.1.5:7420')).toBe(421)
    expect(check('192.168.1.5:7421', 7421, 'http://192.168.1.9:7420')).toBe(403)
  })
  test('a name is served only when the owner listed it; the list is read per request', () => {
    expect(check('rebind.evil.example:7421')).toBe(421)
    expect(check('kiosk.example:7421')).toBeUndefined()
    extra = []
    expect(check('kiosk.example:7421')).toBe(421)
  })
  test('the main listener guard still refuses a literal address', () => {
    const main = createRequestGuard({ publicUrl: () => undefined, extraHosts: [] })
    const res = main.check(
      new Request('http://x/y', { headers: { host: '192.168.1.5:7420' } }),
      7420,
    )
    expect(res?.status).toBe(421)
  })
})
