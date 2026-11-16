import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginWeb, isPluginWebPath, pluginContentSecurityPolicy } from './plugin-web.ts'

const root = mkdtempSync(join(tmpdir(), 'keith-plugin-web-'))
const web = join(root, 'maps', 'web')
mkdirSync(join(web, 'img'), { recursive: true })
writeFileSync(join(web, 'map.html'), '<!doctype html><title>Map</title>')
writeFileSync(join(web, 'other.html'), '<!doctype html><title>Other</title>')
writeFileSync(join(web, 'map.js'), 'export {}')
writeFileSync(join(web, 'map.css'), 'body{}')
writeFileSync(join(web, 'img', 'pin.svg'), '<svg/>')
writeFileSync(join(web, 'notes.txt'), 'not served')
writeFileSync(join(root, 'maps', 'plugin.ts'), 'secret source')
writeFileSync(join(root, 'outside.js'), 'outside')
symlinkSync(join(root, 'outside.js'), join(web, 'escape.js'))
writeFileSync(join(web, 'globe.html'), '<!doctype html><title>Globe</title>')
const lib = join(root, 'lib', 'Build')
mkdirSync(join(lib, 'Workers'), { recursive: true })
writeFileSync(join(lib, 'Engine.js'), 'export const engine = 1')
writeFileSync(join(lib, 'Workers', 'w.wasm'), 'wasm')
writeFileSync(join(lib, 'page.html'), '<!doctype html>')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const TILES = 'https://tile.openstreetmap.org'
const API = 'https://api.example.org'
const served = createPluginWeb({
  plugins: () => [
    { id: 'maps', manifest: { web: { dir: web, mounts: { 'vendor/engine': lib } } } },
    { id: 'notes', manifest: {} },
  ],
  contributions: (point) =>
    point !== 'web.window'
      ? []
      : [
          {
            point,
            contributor: 'maps',
            id: 'map',
            entry: { entry: { path: './web/map.html' }, network: [TILES] },
          },
          {
            point,
            contributor: 'maps',
            id: 'other',
            entry: { entry: { path: './web/other.html' }, network: [API] },
          },
          {
            point,
            contributor: 'maps',
            id: 'globe',
            entry: {
              entry: { path: './web/globe.html' },
              network: [TILES],
              gpu: true,
              media: true,
            },
          },
          {
            point,
            contributor: 'web',
            id: 'browser',
            entry: { entry: { builtin: 'browser' }, network: [] },
          },
        ],
})
const get = (path: string, method = 'GET') =>
  served.serve(new Request(`http://keith.test${path}`, { method }))

describe('thalamus: plugin web bundles', () => {
  test('a page gets the CSP of its own app, nosniff and no-cache', async () => {
    const res = await get('/plugins/maps/web/map.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(
      // the core's own origin next to 'self': WebKit matches 'self' against nothing in an opaque-origin (sandboxed) frame
      `default-src 'none'; script-src 'self' http://keith.test; style-src 'self' http://keith.test; img-src 'self' http://keith.test ${TILES}; connect-src ${TILES}; frame-ancestors 'self'`,
    )
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(await res.text()).toContain('<title>Map</title>')
    const other = await get('/plugins/maps/web/other.html')
    expect(other.headers.get('content-security-policy')).toContain(`connect-src ${API};`)
    expect(other.headers.get('content-security-policy')).not.toContain(TILES)
  })

  test('other files get the union of the plugin apps networks and their own type', async () => {
    const js = await get('/plugins/maps/web/map.js')
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('content-security-policy')).toContain(`connect-src ${TILES} ${API};`)
    expect(js.headers.get('access-control-allow-origin')).toBe('*')
    expect((await get('/plugins/maps/web/map.css')).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    )
    expect((await get('/plugins/maps/web/img/pin.svg')).headers.get('content-type')).toBe(
      'image/svg+xml',
    )
    const head = await get('/plugins/maps/web/map.js', 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  test('a gpu page may start blob workers, compile wasm and fetch its own plugin paths; media opens https audio', async () => {
    const csp = (await get('/plugins/maps/web/globe.html')).headers.get('content-security-policy')
    expect(csp).toBe(
      `default-src 'none'; script-src 'self' http://keith.test 'wasm-unsafe-eval'; style-src 'self' http://keith.test; img-src 'self' http://keith.test blob: data: ${TILES}; connect-src http://keith.test/plugins/maps/ ${TILES}; worker-src 'self' http://keith.test blob: data:; media-src https:; frame-ancestors 'self'`,
    )
    // a plugin id that is not one never reaches the header
    expect(
      pluginContentSecurityPolicy([], 'http://keith.test', { gpu: true, pluginId: 'a b' }),
    ).toContain("connect-src 'none'")
  })

  test('a mounted library is served from its own folder, cached, never as a page', async () => {
    const js = await get('/plugins/maps/web/vendor/engine/Engine.js')
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('engine')
    expect(js.headers.get('cache-control')).toBe('public, max-age=86400')
    const wasm = await get('/plugins/maps/web/vendor/engine/Workers/w.wasm')
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect((await get('/plugins/maps/web/vendor/engine/page.html')).status).toBe(404)
    expect((await get('/plugins/maps/web/vendor/engine/../map.js')).status).toBe(404)
    expect((await get('/plugins/maps/web/vendor/other/Engine.js')).status).toBe(404)
  })

  test('an empty network is connect-src none', () => {
    expect(pluginContentSecurityPolicy([])).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-ancestors 'self'",
    )
    // anything that is not a bare https origin is dropped, never written into the header
    expect(pluginContentSecurityPolicy([], "http://x; script-src 'unsafe-inline'")).toContain(
      "script-src 'self';",
    )
    expect(pluginContentSecurityPolicy(["https://a.test; script-src 'unsafe-inline'"])).toContain(
      "connect-src 'none'",
    )
  })

  test('traversal, encoded traversal, symlinks out, directories and unknown types are 404', async () => {
    for (const path of [
      '/plugins/maps/web/../plugin.ts',
      '/plugins/maps/web/%2e%2e/plugin.ts',
      '/plugins/maps/web/img/..%2f..%2fplugin.ts',
      '/plugins/maps/web/..%5cplugin.ts',
      '/plugins/maps/web/%2fetc%2fpasswd.js',
      '/plugins/maps/web/escape.js',
      '/plugins/maps/web/img',
      '/plugins/maps/web/img/',
      '/plugins/maps/web/notes.txt',
      '/plugins/maps/web/missing.js',
      '/plugins/maps/web/',
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    }
  })

  test('a plugin without web, an unknown plugin and a write are refused', async () => {
    expect((await get('/plugins/notes/web/map.html')).status).toBe(404)
    expect((await get('/plugins/ghost/web/map.html')).status).toBe(404)
    expect((await get('/plugins/maps/web/map.html', 'POST')).status).toBe(405)
  })

  test('isPluginWebPath matches only bundle files', () => {
    expect(isPluginWebPath('/plugins/maps/web/map.html')).toBe(true)
    expect(isPluginWebPath('/plugins/maps/search')).toBe(false)
    expect(isPluginWebPath('/plugins/openapi.json')).toBe(false)
  })
})
