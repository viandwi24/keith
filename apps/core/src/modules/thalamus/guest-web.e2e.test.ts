import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedProvider } from 'eharness/testing'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { createGuestListener, type GuestListener } from './guest-listener.ts'

/** The guest chat page on the guest listener (docs/specs/guests.md, "Guest page"; thalamus.md, "Guest listener"). */
const SCRIPT = '\n  window.__boot = { base: "/app" }\n'
const SHELL = `<!doctype html><html><head><script src="/app/_app/x.js"></script></head><body><script>${SCRIPT}</script></body></html>`
const HASH = createHash('sha256').update(SCRIPT).digest('base64')

let dir: string
let booted: BootedCore
let withWeb: GuestListener
let withoutWeb: GuestListener
let bare: BootedCore
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keith-guest-web-'))
  mkdirSync(join(dir, '_app/immutable'), { recursive: true })
  writeFileSync(join(dir, '200.html'), SHELL)
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Keith"}')
  writeFileSync(join(dir, 'service-worker.js'), 'self.addEventListener("fetch", () => {})\n')
  writeFileSync(join(dir, '_app/immutable/app.abc.js'), 'export const a = 1\n')
  const guestModel = {
    definitions: [
      scriptedProvider({
        id: 'pricey',
        models: { cheap: [{ text: 'ok' }] },
        info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
      }),
    ],
  }
  booted = await bootCore({ KEITH_WEB_DIR: dir }, guestModel)
  bare = await bootCore({ KEITH_WEB: 'off' }, guestModel)
  for (const b of [booted, bare]) {
    await b.local.rpc.providers.put({ providerId: 'pricey' })
    await b.local.rpc.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  }
  await booted.local.rpc.admin.guests.set({ enabled: true, zones: ['loopback'] })
  await bare.local.rpc.admin.guests.set({ enabled: true, zones: ['loopback'] })
  withWeb = createGuestListener({ http: booted.core.guestHttp, port: 0, pollMs: 0 })
  withoutWeb = createGuestListener({ http: bare.core.guestHttp, port: 0, pollMs: 0 })
  withWeb.reconcile()
  withoutWeb.reconcile()
})
afterAll(async () => {
  await withWeb.stop()
  await withoutWeb.stop()
  await booted.stop()
  await bare.stop()
  rmSync(dir, { recursive: true, force: true })
})

const get = (listener: GuestListener, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${listener.port()}${path}`, { headers, redirect: 'manual' })

describe('the guest page', () => {
  test('/app/guest is the shell, with the security headers and a CSP that hashes its inline script', async () => {
    for (const path of ['/app/guest', '/app/guest/']) {
      const res = await get(withWeb, path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('content-security-policy')).toContain(
        `script-src 'self' 'sha256-${HASH}'`,
      )
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(await res.text()).toBe(SHELL)
    }
  })

  test('the build assets and the icon are served; nothing else of the app is', async () => {
    const asset = await get(withWeb, '/app/_app/immutable/app.abc.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await get(withWeb, '/app/favicon.svg')).status).toBe(200)
    for (const path of [
      '/app',
      '/app/',
      '/app/login',
      '/app/chat',
      '/app/manage/people',
      '/app/apps',
      '/app/200.html',
      '/app/manifest.webmanifest',
      '/app/service-worker.js',
      '/app/guestbook',
    ]) {
      const res = await get(withWeb, path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('__boot')
    }
  })

  test('the owner routes do not exist on this listener, with or without the page', async () => {
    for (const listener of [withWeb, withoutWeb]) {
      for (const path of [
        '/rpc/auth/whoami',
        '/auth/whoami',
        '/sessions',
        '/activity',
        '/plugins/tui/menu',
      ]) {
        const res = await get(listener, path)
        expect(res.status).toBe(404)
      }
      expect(
        (await fetch(`http://127.0.0.1:${listener.port()}/rpc/auth/whoami`, { method: 'POST' }))
          .status,
      ).toBe(404)
    }
  })

  test('only GET and HEAD reach the page', async () => {
    const res = await fetch(`http://127.0.0.1:${withWeb.port()}/app/guest`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('the bare address sends a browser to the page and leaves API clients alone', async () => {
    const page = await get(withWeb, '/', { accept: 'text/html,application/xhtml+xml' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/app/guest')
    expect((await get(withWeb, '/', { accept: 'application/json' })).status).toBe(404)
  })

  test('the Host guard still applies', async () => {
    const res = await get(withWeb, '/app/guest', { host: 'rebind.evil.example' })
    expect(res.status).toBe(421)
  })

  test('KEITH_WEB=off: no page on the guest listener either; the guest API stays', async () => {
    expect((await get(withoutWeb, '/app/guest')).status).toBe(404)
    expect((await get(withoutWeb, '/', { accept: 'text/html' })).status).toBe(404)
    expect((await get(withoutWeb, '/guest/status')).status).toBe(200)
  })
})
