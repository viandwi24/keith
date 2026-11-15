// The browser's `createKeithClient`: cookie mode, same origin, the platform `fetch` and `WebSocket`. No token ever reaches
// page script; the HttpOnly cookie travels by itself (ADR-0035).
import { createKeithClient as createCoreClient, type KeithClient } from '../client.ts'
import type { ViewConnector, ViewSocket } from '../view/open-view.ts'

export interface BrowserClientOptions {
  /** Core URL. Default: the page's own origin (the core serves the app, so there is no CORS). */
  baseUrl?: string
  /** The only mode of a browser: the session is an HttpOnly cookie. */
  auth: 'cookie'
  /** Tests only: replaces `fetch`. It still gets `credentials: 'same-origin'`. */
  fetch?: typeof fetch
}

/** The origin of the page, or an empty string where there is no page (a test with no `location`). */
export const defaultBaseUrl = (): string =>
  (globalThis as { location?: { origin?: string } }).location?.origin ?? ''

/** A `fetch` that always sends and accepts the cookie of the page's own origin. */
export function sameOriginFetch(inner?: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    (inner ?? globalThis.fetch)(input, { ...init, credentials: 'same-origin' })) as typeof fetch
}

/** The platform `WebSocket`: the cookie goes with the upgrade (same origin), so no header is set. */
export const browserViewConnector: ViewConnector = (url) =>
  new WebSocket(url) as unknown as ViewSocket

export function createKeithClient(options: BrowserClientOptions): KeithClient {
  return createCoreClient({
    baseUrl: options.baseUrl ?? defaultBaseUrl(),
    auth: options.auth,
    fetch: sameOriginFetch(options.fetch),
    connectView: browserViewConnector,
  })
}
