// The service worker of the web client (docs/specs/web.md, "PWA"). It does three things and nothing else:
//  1. caches the app shell (the page and the build's immutable files) so the app opens fast and an offline start shows the shell;
//  2. shows a notification for a Web Push message (the payload is `{ title, body, url, tag }`, neutral by default);
//  3. on a click, focuses an open window of the app and goes to the message's page, or opens one.
// It never stores an API answer: only the precache list is cached (`routeOf`).
import { immutable } from '$app/manifest'
import { self } from '$app/service-worker'
import {
  cacheNameOf,
  planOf,
  precacheUrls,
  routeOf,
  windowToFocus,
} from '../lib/features/pwa/sw-logic.ts'

const scope = self.registration.scope
const urls = precacheUrls(immutable, scope)
const precached = new Set(urls)
const cacheName = cacheNameOf(urls)

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName)
      // `reload`: the shell must be the server's current page, not an HTTP-cached copy
      await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('keith-shell-') && key !== cacheName) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const route = routeOf(request, scope, precached)
  if (route === 'pass') return
  if (route === 'asset') {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)))
    return
  }
  // a page load: the network first (a new build must show), the cached shell when it cannot be reached
  event.respondWith(
    fetch(request).catch(async () => (await caches.match(new URL(scope).href)) ?? Response.error()),
  )
})

self.addEventListener('push', (event) => {
  const plan = planOf(event.data?.text(), scope)
  event.waitUntil(self.registration.showNotification(plan.title, plan.options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const target = data?.url ?? new URL(scope).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const at = windowToFocus(
        windows.map((w) => w.url),
        scope,
      )
      const existing = windows[at]
      if (existing === undefined) {
        await self.clients.openWindow(target)
        return
      }
      const moved = await existing.navigate(target).catch(() => existing)
      await (moved ?? existing).focus()
    })(),
  )
})
