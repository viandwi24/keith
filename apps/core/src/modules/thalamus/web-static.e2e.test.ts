import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { inlineScriptHashes } from './web-static.ts'

/** `/app`: the web client's build served by core (docs/specs/thalamus.md, "Web client"). */
const SCRIPT = '\n  window.__boot = { base: "/app" }\n'
const SHELL = `<!doctype html><html><head><script src="/app/_app/x.js"></script></head><body><script>${SCRIPT}</script></body></html>`
const HASH = createHash('sha256').update(SCRIPT).digest('base64')

let dir: string
let outside: string
let on: BootedCore
let missing: BootedCore
let off: BootedCore

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keith-web-'))
  outside = mkdtempSync(join(tmpdir(), 'keith-web-out-'))
  mkdirSync(join(dir, '_app/immutable'), { recursive: true })
  writeFileSync(join(dir, '200.html'), SHELL)
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, '_app/immutable/app.abc.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Keith","scope":"/app/"}')
  writeFileSync(join(dir, 'service-worker.js'), 'self.addEventListener("fetch", () => {})\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside the build')
  symlinkSync(outside, join(dir, 'escape'))
  on = await bootCore({ KEITH_WEB_DIR: dir })
  missing = await bootCore({ KEITH_WEB_DIR: join(dir, 'nope') })
  off = await bootCore({ KEITH_WEB_DIR: dir, KEITH_WEB: 'off' })
})
afterAll(async () => {
  await on.stop()
  await missing.stop()
  await off.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const get = (b: BootedCore, path: string, headers: Record<string, string> = {}) =>
  fetch(`${b.url}${path}`, { headers, redirect: 'manual' })

describe('/app', () => {
  test('the shell is served with no-cache and the security headers', async () => {
    for (const path of ['/app', '/app/', '/app/chat/some/route']) {
      const res = await get(on, path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(await res.text()).toBe(SHELL)
    }
    const res = await get(on, '/app')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`script-src 'self' 'sha256-${HASH}'`)
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    for (const part of [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ])
      expect(csp).toContain(part)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('a file is served; hashed assets are immutable', async () => {
    const icon = await get(on, '/app/favicon.svg')
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toContain('image/svg')
    expect(icon.headers.get('cache-control')).toBe('no-cache')
    const asset = await get(on, '/app/_app/immutable/app.abc.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await asset.text()).toBe('export const a = 1\n')
  })

  test('the PWA files: the manifest has its own type, the service worker is script and never cached hard', async () => {
    const manifest = await get(on, '/app/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json')
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    const worker = await get(on, '/app/service-worker.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type')).toContain('javascript')
    // an update of the worker must be seen at the next load: no max-age, and no Service-Worker-Allowed (its scope is /app/)
    expect(worker.headers.get('cache-control')).toBe('no-cache')
    expect(worker.headers.get('service-worker-allowed')).toBeNull()
    expect(worker.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  test('a missing asset is a 404, never the shell', async () => {
    expect((await get(on, '/app/_app/immutable/gone.js')).status).toBe(404)
    expect((await get(on, '/app/missing.png')).status).toBe(404)
  })

  test('a path cannot leave the build folder', async () => {
    const attempts = [
      '/app/..%2f..%2fpackage.json',
      '/app/%2e%2e/%2e%2e/secret.txt',
      '/app/escape/secret.txt',
      '/app/%5c..%5csecret.txt',
      '/app/%00',
    ]
    for (const path of attempts) {
      const res = await get(on, path)
      expect(await res.text()).not.toContain('outside the build')
      expect([200, 400, 404]).toContain(res.status)
      if (res.status === 200) expect(res.headers.get('content-type')).toContain('text/html')
    }
    expect((await get(on, '/app/escape/secret.txt')).status).toBe(404)
  })

  test('only GET and HEAD', async () => {
    const res = await fetch(`${on.url}/app`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('/ redirects a browser to /app and leaves API clients alone', async () => {
    const page = await get(on, '/', { accept: 'text/html,application/xhtml+xml' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/app')
    expect((await get(on, '/', { accept: 'application/json' })).status).toBe(404)
    expect((await get(on, '/')).status).toBe(404)
  })

  test('the app needs no sign-in, the API still does', async () => {
    expect((await get(on, '/app')).status).toBe(200)
    expect((await fetch(`${on.url}/rpc/auth/whoami`, { method: 'POST' })).status).toBe(401)
  })

  test('a missing build answers 404 with a hint', async () => {
    const res = await get(missing, '/app')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('bun run --cwd apps/web build')
    expect((await get(missing, '/app/anything')).status).toBe(404)
  })

  test('KEITH_WEB=off removes /app and the redirect', async () => {
    expect((await get(off, '/app')).status).toBe(404)
    expect((await get(off, '/', { accept: 'text/html' })).status).toBe(404)
  })

  test('the Host guard still applies', async () => {
    const res = await fetch(`${on.url}/app`, { headers: { host: 'evil.example' } })
    expect(res.status).toBe(421)
  })
})

describe('inlineScriptHashes', () => {
  test('hashes inline scripts only', () => {
    expect(inlineScriptHashes(SHELL)).toEqual([HASH])
    expect(inlineScriptHashes('<script src="a.js"></script><script></script>')).toEqual([])
  })
})
