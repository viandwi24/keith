import { appBase } from '../session/index.ts'

let registering: Promise<ServiceWorkerRegistration | undefined> | undefined

/**
 * Registers the service worker of the app (`/app/service-worker.js`, scope `/app/`), once per page. `undefined` when the browser has
 * none or in `vite dev` (which does not serve the built worker). Never throws: the app works without it.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  registering ??= (async () => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return undefined
    try {
      const base = appBase()
      return await navigator.serviceWorker.register(`${base}/service-worker.js`, {
        scope: `${base}/`,
      })
    } catch {
      return undefined
    }
  })()
  return registering
}
