import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKeithError } from '@keith/sdk'
import type { PluginOwner } from '../plugins/types.ts'
import { createPluginWs } from './plugin-routes.ts'
import { login, startTestServer, type TestServer } from './test-fakes.ts'

const infra: PluginOwner = { pluginId: '@keith/weather', namespace: 'weather', kind: 'infra' }
const web: PluginOwner = { pluginId: '@keith/web', namespace: 'web', kind: 'client-app' }

function codeOf(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return isKeithError(error) ? error.code : 'not a KeithError'
  }
}

let t: TestServer
let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keith-static-'))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<h1>web</h1>')
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  t = await startTestServer()
})
afterEach(async () => {
  await t.stop()
})

describe('plugin http routes', () => {
  test('a route under /p/<namespace>/… works, with params and bearer auth by default', async () => {
    const http = t.server.http.forPlugin(infra)
    http.route('GET', '/cities/:name', (_req, c) =>
      Response.json({ city: c.params.name, who: c.person?.name }),
    )
    const token = await login(t)
    const ok = await fetch(`${t.base}/p/weather/cities/new%20york`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(await ok.json()).toEqual({ city: 'new york', who: 'Tony' })
    const denied = await fetch(`${t.base}/p/weather/cities/paris`)
    expect(denied.status).toBe(401)
  })

  test('auth none routes get a null person without a token', async () => {
    t.server.http.forPlugin(infra).route('POST', 'hook', () => new Response('ok'), { auth: 'none' })
    const res = await fetch(`${t.base}/p/weather/hook`, { method: 'POST' })
    expect(await res.text()).toBe('ok')
    expect((await fetch(`${t.base}/p/weather/hook`)).status).toBe(404)
  })

  test('registering under /v1 or another plugin’s mount throws ROUTE_CONFLICT', () => {
    const http = t.server.http.forPlugin(infra)
    const noop = () => new Response('')
    expect(codeOf(() => http.route('GET', '/v1/health', noop))).toBe('ROUTE_CONFLICT')
    expect(codeOf(() => http.route('GET', '/v1', noop))).toBe('ROUTE_CONFLICT')
    expect(codeOf(() => http.route('GET', '/p/web/x', noop))).toBe('ROUTE_CONFLICT')
    http.route('GET', '/x', noop)
    expect(codeOf(() => http.route('GET', '/p/weather/x', noop))).toBe('ROUTE_CONFLICT')
    expect(codeOf(() => http.static('/v1', dir))).toBe('ROUTE_CONFLICT')
  })

  test('core /v1 routes are never shadowed by plugins', async () => {
    t.server.http.forPlugin(web).static('/', dir, { spaFallback: 'index.html' })
    expect((await fetch(`${t.base}/v1/health`)).status).toBe(200)
    expect((await fetch(`${t.base}/v1/nope`)).status).toBe(404)
  })

  test('static files, SPA fallback and no path traversal', async () => {
    const reg = t.server.http.forPlugin(web)
    reg.static('/', dir, { spaFallback: 'index.html' })
    expect(await (await fetch(`${t.base}/`)).text()).toBe('<h1>web</h1>')
    expect(await (await fetch(`${t.base}/assets/app.js`)).text()).toBe('console.log(1)')
    expect(await (await fetch(`${t.base}/some/client/route`)).text()).toBe('<h1>web</h1>')
    const traversal = await fetch(`${t.base}/assets/..%2f..%2f..%2fetc%2fpasswd`)
    expect(await traversal.text()).toBe('<h1>web</h1>')
  })

  test('static under /p/<namespace> for infra plugins; / is client-app only and owned once', async () => {
    t.server.http.forPlugin(infra).static('/files', dir)
    expect(await (await fetch(`${t.base}/p/weather/files/assets/app.js`)).text()).toBe('console.log(1)')
    expect((await fetch(`${t.base}/p/weather/files/missing.txt`)).status).toBe(404)
    expect(codeOf(() => t.server.http.forPlugin(infra).static('/', dir))).toBe('PLUGIN_KIND_VIOLATION')
    t.server.http.forPlugin(web).static('/', dir)
    const other: PluginOwner = { pluginId: '@keith/other', namespace: 'other', kind: 'client-app' }
    expect(codeOf(() => t.server.http.forPlugin(other).static('/', dir))).toBe('ROUTE_CONFLICT')
  })

  test('removeByPlugin drops a plugin’s routes', async () => {
    t.server.http.forPlugin(infra).route('GET', '/ping', () => new Response('pong'), { auth: 'none' })
    expect(await (await fetch(`${t.base}/p/weather/ping`)).text()).toBe('pong')
    t.server.http.removeByPlugin(infra.pluginId)
    expect((await fetch(`${t.base}/p/weather/ping`)).status).toBe(404)
  })

  test('a throwing plugin handler gives 500 INTERNAL', async () => {
    t.server.http.forPlugin(infra).route(
      'GET',
      '/boom',
      () => {
        throw new Error('boom')
      },
      { auth: 'none' },
    )
    const res = await fetch(`${t.base}/p/weather/boom`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } })
  })
})

describe('plugin ws registry', () => {
  test('frame types must start with the namespace, and are unique', () => {
    const ws = createPluginWs()
    const reg = ws.forPlugin(infra)
    const schema = { safeParse: () => ({ success: true }) } as never
    expect(codeOf(() => reg.handle('telegram.linked', schema, () => {}))).toBe('PLUGIN_NAMESPACE_INVALID')
    expect(codeOf(() => reg.handle('weather.', schema, () => {}))).toBe('PLUGIN_NAMESPACE_INVALID')
    reg.handle('weather.subscribe', schema, () => {})
    expect(ws.find('weather.subscribe')?.pluginId).toBe(infra.pluginId)
    expect(codeOf(() => reg.handle('weather.subscribe', schema, () => {}))).toBe('ROUTE_CONFLICT')
    ws.removeByPlugin(infra.pluginId)
    expect(ws.find('weather.subscribe')).toBeUndefined()
  })
})
